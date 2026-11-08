/**
 * Reference-aware retention (hardening: history, files and models). Finds what may be removed under
 * a per-application policy, reports counts and bytes, and removes it only when asked, in short
 * batches. It never touches answers, revisions, citations, ratings, artifacts, approvals, Huddle items
 * or the audit log, and it keeps anything those rows reference:
 *
 *   model calls     detail older than N days is folded into model_call_daily (usage totals keep
 *                   counting it), then removed
 *   test runs       runs (and their results) older than N days, except every target build's runs, the
 *                   latest run of each repository workflow, and any run an answer, artifact, approval,
 *                   citation, Huddle item or audit row mentions
 *   passages        retired passage versions (F20) that no saved citation, answer, artifact, approval,
 *                   Huddle item or audit row links to (a link names the source and its version)
 *   vectors         passage vectors of embedding models that are not configured
 *   files           files in the blob directory that no attachment or App Context source refers to,
 *                   older than a grace period (an upload in progress is never touched)
 *
 * Bytes for rows are the sizes of their stored values (an estimate of what the database frees before
 * VACUUM); bytes for files are their sizes on disk.
 */
import { readdirSync, rmSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import type { HorizonDb } from './db';

export interface AppLimits {
  /** Days of model-call detail to keep; null keeps everything. */
  modelCallDays: number | null;
  /** Days of test runs to keep (protected runs are always kept); null keeps everything. */
  runDays: number | null;
}

export interface RetentionPolicy extends AppLimits {
  /** Per-application overrides. */
  apps?: Record<string, Partial<AppLimits>>;
  /** Only these applications (default: all). Vectors and files outside them are left alone. */
  only?: string[];
  /** Remove retired passage versions nobody cites (default true). */
  retiredPassages?: boolean;
  /** Embedding models whose vectors are kept. Null: do not remove any vectors (no model configured). */
  keepModels?: string[] | null;
  /** The blob directory (HORIZON_FILES_DIR); orphan files are looked for only when given. */
  filesDir?: string | null;
  /** Files younger than this are never orphans (default 24 h). */
  fileGraceHours?: number;
}

export const DEFAULT_POLICY: RetentionPolicy = { modelCallDays: 90, runDays: 180, retiredPassages: true, keepModels: null, filesDir: null, fileGraceHours: 24 };

export interface Category {
  rows: number;
  bytes: number;
  byApp: Record<string, { rows: number; bytes: number }>;
  /** What is kept although it is old, and why. */
  kept?: Record<string, number>;
  note?: string;
}

export interface RetentionReport {
  applied: boolean;
  at: string;
  modelCalls: Category;
  testRuns: Category & { results: number };
  retiredPassages: Category & { vectors: number };
  staleVectors: Category & { models: string[] };
  orphanFiles: Category & { files: string[] };
  database: { bytes: number; freeBytes: number };
}

const DAY = 86_400_000;
const BATCH = 500;
const empty = (): Category => ({ rows: 0, bytes: 0, byApp: {} });
const add = (c: Category, app: string | null, rows: number, bytes: number) => {
  c.rows += rows;
  c.bytes += bytes;
  const k = app ?? '(none)';
  const a = (c.byApp[k] ??= { rows: 0, bytes: 0 });
  a.rows += rows;
  a.bytes += bytes;
};

const limitFor = (p: RetentionPolicy, app: string, key: keyof AppLimits) => (p.apps?.[app]?.[key] !== undefined ? p.apps[app][key]! : p[key]);
const inScope = (p: RetentionPolicy, app: string | null) => !p.only?.length || (app != null && p.only.includes(app));

/**
 * Text that references other rows: answers, citations, artifacts, approvals, Huddle items and the audit
 * log. Read row by row (iterate), never all at once.
 */
const REFERENCING = [
  'SELECT blocks AS t FROM answer_revisions',
  'SELECT source_ref || char(10) || detail AS t FROM citations',
  'SELECT body AS t FROM artifacts',
  'SELECT target || char(10) || facts || char(10) || payload || char(10) || COALESCE(outcome, \'\') AS t FROM approvals',
  'SELECT citations || char(10) || summary || char(10) || ai_summary AS t FROM huddle_items',
  'SELECT COALESCE(href, \'\') || char(10) || entity_ref AS t FROM huddle_links',
  // An import's own audit row names the run it created; that row is kept as history, and it alone does
  // not keep the run. Any other audit row that names a run (or a passage link) does.
  "SELECT entity_ref || char(10) || COALESCE(detail, '') AS t FROM audit_log WHERE action != 'hexa.ingest_run'",
];
function* referencingText(db: HorizonDb): Generator<string> {
  for (const sql of REFERENCING) for (const r of db.raw.prepare(sql).iterate() as Iterable<{ t: string | null }>) if (r.t) yield r.t;
}

/** Which of these ids appear as whole tokens in any referencing text. */
function referencedIds(db: HorizonDb, ids: Set<string>): Set<string> {
  const found = new Set<string>();
  if (ids.size === 0) return found;
  for (const t of referencingText(db)) for (const tok of t.match(/[A-Za-z0-9_-]+/g) ?? []) if (ids.has(tok)) found.add(tok);
  return found;
}

/** Source versions that something links to (`/context/source/<id>?v=<n>`); a link without a version pins version 1 and the current one. */
function citedVersions(db: HorizonDb): { exact: Set<string>; versionless: Set<string> } {
  const exact = new Set<string>();
  const versionless = new Set<string>();
  const link = /\/context\/source\/([^?#"'\s)\]\\]+)(?:\?v=(\d+))?/g;
  for (const t of referencingText(db))
    for (const m of t.matchAll(link)) {
      let id = m[1];
      try {
        id = decodeURIComponent(id);
      } catch {
        /* keep as written */
      }
      if (m[2]) exact.add(`${id}@${m[2]}`);
      else versionless.add(id);
    }
  return { exact, versionless };
}

function walk(dir: string): string[] {
  let out: string[] = [];
  let entries: import('node:fs').Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out = out.concat(walk(p));
    else if (e.isFile()) out.push(p);
  }
  return out;
}

/** Plans (and with `apply`, carries out) retention. Returns what was, or would be, removed. */
export function runRetention(db: HorizonDb, policy: RetentionPolicy = DEFAULT_POLICY, opts: { apply?: boolean; now?: number; log?: (line: string) => void } = {}): RetentionReport {
  const now = opts.now ?? Date.now();
  const apply = !!opts.apply;
  const raw = db.raw;
  const apps = (raw.prepare('SELECT id FROM applications ORDER BY id').all() as { id: string }[]).map((a) => a.id).filter((a) => inScope(policy, a));
  const log = opts.log ?? (() => {});

  /* ---------- Model calls: fold old detail into daily rows, then remove it ---------- */
  const modelCalls = empty();
  const callsWhere = 'm.created_at < ? AND w.application_id IS ?';
  const callBytes = "COALESCE(SUM(LENGTH(m.agent) + LENGTH(m.model) + LENGTH(m.purpose) + LENGTH(m.status) + LENGTH(m.created_at) + COALESCE(LENGTH(m.workflow_run_id), 0) + COALESCE(LENGTH(m.agent_run_id), 0) + COALESCE(LENGTH(m.user_id), 0) + 40), 0)";
  // Calls whose workflow run is gone have no application; they follow the default limit and only when every application is in scope.
  const callScopes: (string | null)[] = [...apps, ...(policy.only?.length ? [] : [null])];
  for (const app of callScopes) {
    const days = app ? limitFor(policy, app, 'modelCallDays') : policy.modelCallDays;
    if (days == null) continue;
    const cutoff = new Date(now - days * DAY).toISOString();
    const r = raw.prepare(`SELECT COUNT(*) AS n, ${callBytes} AS b FROM model_calls m LEFT JOIN workflow_runs w ON w.id = m.workflow_run_id WHERE ${callsWhere}`).get(cutoff, app) as { n: number; b: number };
    if (!r.n) continue;
    add(modelCalls, app, r.n, r.b);
    if (!apply) continue;
    const pick = raw.prepare(`SELECT m.id FROM model_calls m LEFT JOIN workflow_runs w ON w.id = m.workflow_run_id WHERE ${callsWhere} ORDER BY m.id LIMIT ${BATCH}`);
    const fold = raw.prepare(
      `INSERT INTO model_call_daily (application_id, day, agent, model, user_id, purpose, status, calls, prompt_tokens, completion_tokens, unreported, latency_ms)
       SELECT w.application_id, substr(m.created_at, 1, 10), m.agent, m.model, m.user_id, m.purpose, m.status, COUNT(*), SUM(m.prompt_tokens), SUM(m.completion_tokens),
              SUM(CASE WHEN m.prompt_tokens IS NULL THEN 1 ELSE 0 END), SUM(m.latency_ms)
       FROM model_calls m LEFT JOIN workflow_runs w ON w.id = m.workflow_run_id WHERE m.id IN (SELECT value FROM json_each(?))
       GROUP BY w.application_id, substr(m.created_at, 1, 10), m.agent, m.model, m.user_id, m.purpose, m.status
       ON CONFLICT DO UPDATE SET calls = calls + excluded.calls,
         prompt_tokens = CASE WHEN prompt_tokens IS NULL AND excluded.prompt_tokens IS NULL THEN NULL ELSE COALESCE(prompt_tokens, 0) + COALESCE(excluded.prompt_tokens, 0) END,
         completion_tokens = CASE WHEN completion_tokens IS NULL AND excluded.completion_tokens IS NULL THEN NULL ELSE COALESCE(completion_tokens, 0) + COALESCE(excluded.completion_tokens, 0) END,
         unreported = unreported + excluded.unreported, latency_ms = latency_ms + excluded.latency_ms`,
    );
    const drop = raw.prepare('DELETE FROM model_calls WHERE id IN (SELECT value FROM json_each(?))');
    const batch = raw.transaction((ids: number[]) => {
      const j = JSON.stringify(ids);
      fold.run(j);
      drop.run(j);
    });
    for (let ids = (pick.all(cutoff, app) as { id: number }[]).map((x) => x.id); ids.length; ids = (pick.all(cutoff, app) as { id: number }[]).map((x) => x.id)) batch(ids);
  }
  if (apply && modelCalls.rows) {
    // Usage totals are cached for a few seconds per process; a running server picks the change up then.
    log(`[retention] folded ${modelCalls.rows} model calls into daily totals`);
  }

  /* ---------- Test runs and their results ---------- */
  const testRuns = { ...empty(), results: 0, kept: { targetBuild: 0, latestOfWorkflow: 0, referenced: 0 } as Record<string, number> };
  const protectedRuns = new Set<string>();
  const reason = new Map<string, string>();
  for (const { application_id: app, repo } of raw.prepare('SELECT DISTINCT application_id, repo FROM test_runs').all() as { application_id: string; repo: string | null }[]) {
    if (!inScope(policy, app)) continue;
    for (const id of db.targetBuild(app, repo)?.runIds ?? []) protectedRuns.add(id), reason.set(id, 'targetBuild');
  }
  for (const { id } of raw
    .prepare(
      `SELECT id FROM (SELECT id, ROW_NUMBER() OVER (PARTITION BY application_id, repo, COALESCE(workflow, '') ORDER BY (started_at IS NOT NULL) DESC, COALESCE(started_at, ingested_at) DESC, attempt DESC, rowid DESC) AS rn FROM test_runs) WHERE rn = 1`,
    )
    .all() as { id: string }[])
    if (!protectedRuns.has(id)) protectedRuns.add(id), reason.set(id, 'latestOfWorkflow');
  const oldRuns: { id: string; app: string }[] = [];
  for (const app of apps) {
    const days = limitFor(policy, app, 'runDays');
    if (days == null) continue;
    const cutoff = new Date(now - days * DAY).toISOString();
    oldRuns.push(...(raw.prepare('SELECT id, application_id AS app FROM test_runs WHERE application_id = ? AND COALESCE(started_at, ingested_at) < ?').all(app, cutoff) as { id: string; app: string }[]));
  }
  const referencedRuns = referencedIds(db, new Set(oldRuns.filter((r) => !protectedRuns.has(r.id)).map((r) => r.id)));
  const runSize = raw.prepare(
    "SELECT (SELECT COUNT(*) FROM test_results WHERE run_id = ?) AS n, (SELECT COALESCE(SUM(LENGTH(test_case_id) + LENGTH(status) + COALESCE(LENGTH(message), 0) + 24), 0) FROM test_results WHERE run_id = ?) + COALESCE((SELECT LENGTH(id) + COALESCE(LENGTH(repo), 0) + COALESCE(LENGTH(workflow), 0) + COALESCE(LENGTH(run_url), 0) + COALESCE(LENGTH(branch), 0) + COALESCE(LENGTH(sha), 0) + 120 FROM test_runs WHERE id = ?), 0) AS b",
  );
  const removableRuns: string[] = [];
  for (const r of oldRuns) {
    const why = reason.get(r.id) ?? (referencedRuns.has(r.id) ? 'referenced' : null);
    if (why) {
      testRuns.kept[why]++;
      continue;
    }
    const s = runSize.get(r.id, r.id, r.id) as { n: number; b: number };
    add(testRuns, r.app, 1, s.b);
    testRuns.results += s.n;
    removableRuns.push(r.id);
  }
  if (apply && removableRuns.length) {
    // Results go with their run (ON DELETE CASCADE); each batch is its own short transaction.
    const drop = raw.prepare('DELETE FROM test_runs WHERE id IN (SELECT value FROM json_each(?))');
    const batch = raw.transaction((ids: string[]) => drop.run(JSON.stringify(ids)));
    for (let i = 0; i < removableRuns.length; i += BATCH) batch(removableRuns.slice(i, i + BATCH));
    log(`[retention] removed ${removableRuns.length} test runs and ${testRuns.results} results`);
  }

  /* ---------- Retired passage versions nobody cites ---------- */
  const retiredPassages = { ...empty(), vectors: 0, kept: { cited: 0 } as Record<string, number> };
  const removableVersions: { source: string; version: number }[] = [];
  if (policy.retiredPassages !== false) {
    const { exact, versionless } = citedVersions(db);
    const groups = raw
      .prepare(
        `SELECT c.source_id, c.source_version, s.application_id AS app, COUNT(*) AS n, SUM(LENGTH(c.text) + LENGTH(c.locator) + LENGTH(c.id) + 60) AS b,
                (SELECT COUNT(*) FROM chunk_embeddings e JOIN source_chunks c2 ON c2.id = e.chunk_id WHERE c2.source_id = c.source_id AND c2.source_version = c.source_version AND c2.retired_at IS NOT NULL) AS vn,
                (SELECT COALESCE(SUM(LENGTH(e.vector)), 0) FROM chunk_embeddings e JOIN source_chunks c2 ON c2.id = e.chunk_id WHERE c2.source_id = c.source_id AND c2.source_version = c.source_version AND c2.retired_at IS NOT NULL) AS vb
         FROM source_chunks c JOIN context_sources s ON s.id = c.source_id WHERE c.retired_at IS NOT NULL GROUP BY c.source_id, c.source_version`,
      )
      .all() as { source_id: string; source_version: number; app: string; n: number; b: number; vn: number; vb: number }[];
    for (const g of groups) {
      if (!inScope(policy, g.app)) continue;
      if (exact.has(`${g.source_id}@${g.source_version}`) || (g.source_version === 1 && versionless.has(g.source_id))) {
        retiredPassages.kept.cited += g.n;
        continue;
      }
      add(retiredPassages, g.app, g.n, g.b + g.vb);
      retiredPassages.vectors += g.vn;
      removableVersions.push({ source: g.source_id, version: g.source_version });
    }
    if (apply && removableVersions.length) {
      const drop = raw.prepare('DELETE FROM source_chunks WHERE source_id = ? AND source_version = ? AND retired_at IS NOT NULL');
      const batch = raw.transaction((vs: typeof removableVersions) => vs.forEach((v) => drop.run(v.source, v.version)));
      for (let i = 0; i < removableVersions.length; i += 50) batch(removableVersions.slice(i, i + 50));
      log(`[retention] removed ${retiredPassages.rows} retired passages of ${removableVersions.length} source versions`);
    }
  }

  /* ---------- Vectors of models no longer configured ---------- */
  const staleVectors = { ...empty(), models: [] as string[] };
  if (policy.keepModels == null) staleVectors.note = 'No embedding model given (keyword-only or not configured); vectors are left alone.';
  else {
    const keep = JSON.stringify(policy.keepModels);
    const rows = raw
      .prepare(
        `SELECT e.model, s.application_id AS app, COUNT(*) AS n, SUM(LENGTH(e.vector) + LENGTH(e.chunk_id) + LENGTH(e.text_sha) + 40) AS b
         FROM chunk_embeddings e JOIN source_chunks c ON c.id = e.chunk_id JOIN context_sources s ON s.id = c.source_id
         WHERE e.model NOT IN (SELECT value FROM json_each(?)) GROUP BY e.model, s.application_id`,
      )
      .all(keep) as { model: string; app: string; n: number; b: number }[];
    for (const r of rows) {
      if (!inScope(policy, r.app)) continue;
      add(staleVectors, r.app, r.n, r.b);
      if (!staleVectors.models.includes(r.model)) staleVectors.models.push(r.model);
    }
    if (apply && staleVectors.rows) {
      const pick = raw.prepare(
        `SELECT e.rowid AS id FROM chunk_embeddings e JOIN source_chunks c ON c.id = e.chunk_id JOIN context_sources s ON s.id = c.source_id
         WHERE e.model NOT IN (SELECT value FROM json_each(?)) AND (? IS NULL OR s.application_id IN (SELECT value FROM json_each(?))) LIMIT ${BATCH}`,
      );
      const drop = raw.prepare('DELETE FROM chunk_embeddings WHERE rowid IN (SELECT value FROM json_each(?))');
      const only = policy.only?.length ? JSON.stringify(policy.only) : null;
      const batch = raw.transaction((ids: number[]) => drop.run(JSON.stringify(ids)));
      for (let ids = (pick.all(keep, only, only) as { id: number }[]).map((x) => x.id); ids.length; ids = (pick.all(keep, only, only) as { id: number }[]).map((x) => x.id)) batch(ids);
      log(`[retention] removed ${staleVectors.rows} vectors of ${staleVectors.models.join(', ')}`);
    }
  }

  /* ---------- Files no row refers to ---------- */
  const orphanFiles = { ...empty(), files: [] as string[] };
  if (!policy.filesDir) orphanFiles.note = 'No files directory given; files were not checked.';
  else {
    const keys = new Set<string>([
      ...(raw.prepare('SELECT storage_key AS k FROM attachments').all() as { k: string }[]).map((r) => r.k),
      ...(raw.prepare('SELECT storage_key AS k FROM context_sources WHERE storage_key IS NOT NULL').all() as { k: string }[]).map((r) => r.k),
    ]);
    const grace = (policy.fileGraceHours ?? 24) * 3_600_000;
    for (const path of walk(policy.filesDir)) {
      const key = relative(policy.filesDir, path).split(sep).join('/');
      if (keys.has(key)) continue;
      const app = key.split('/')[0];
      if (!inScope(policy, app)) continue;
      const st = statSync(path);
      if (now - st.mtimeMs < grace) continue;
      add(orphanFiles, app, 1, st.size);
      orphanFiles.files.push(key);
    }
    if (apply) {
      // Checked again right before removal: a row may have arrived since the scan.
      const stillOrphan = (k: string) => !raw.prepare('SELECT 1 FROM attachments WHERE storage_key = ? UNION ALL SELECT 1 FROM context_sources WHERE storage_key = ?').get(k, k);
      for (const k of orphanFiles.files) if (stillOrphan(k)) rmSync(join(policy.filesDir, ...k.split('/')), { force: true });
      if (orphanFiles.files.length) log(`[retention] removed ${orphanFiles.files.length} orphan files`);
    }
  }

  const pageSize = raw.pragma('page_size', { simple: true }) as number;
  const database = { bytes: (raw.pragma('page_count', { simple: true }) as number) * pageSize, freeBytes: (raw.pragma('freelist_count', { simple: true }) as number) * pageSize };
  return { applied: apply, at: new Date(now).toISOString(), modelCalls, testRuns, retiredPassages, staleVectors, orphanFiles, database };
}

/** Policy from the environment: HORIZON_RETAIN_MODEL_CALLS_DAYS, HORIZON_RETAIN_RUNS_DAYS, and the same with _<APP> per application ("off" keeps everything). */
export function policyFromEnv(env: Record<string, string | undefined>, base: RetentionPolicy = DEFAULT_POLICY): RetentionPolicy {
  const days = (v: string | undefined, def: number | null) => (v == null || v.trim() === '' ? def : /^(off|never|keep)$/i.test(v.trim()) ? null : Number.isInteger(Number(v)) && Number(v) >= 1 ? Number(v) : def);
  const p: RetentionPolicy = { ...base, apps: { ...(base.apps ?? {}) } };
  p.modelCallDays = days(env.HORIZON_RETAIN_MODEL_CALLS_DAYS, base.modelCallDays);
  p.runDays = days(env.HORIZON_RETAIN_RUNS_DAYS, base.runDays);
  for (const [k, v] of Object.entries(env)) {
    const m = /^HORIZON_RETAIN_(MODEL_CALLS|RUNS)_DAYS_([A-Za-z0-9_-]+)$/.exec(k);
    if (!m) continue;
    const key = m[1] === 'RUNS' ? 'runDays' : 'modelCallDays';
    (p.apps![m[2]] ??= {})[key] = days(v, p[key]);
  }
  return p;
}
