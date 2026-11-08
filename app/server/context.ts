/**
 * App Context, server side: what Catalyzt knows about one application and where it came from.
 *
 * Sources are real: repositories from the workspace (their documentation is read from the local
 * clone and split into passages), the Jira feed, and what the team uploads (text formats are
 * read and split; other formats are kept and marked "stored, not readable"). Retrieval is hybrid
 * (server/retrieval.ts): keyword overlap and vector similarity fused by rank, then a reranker;
 * without models, or before passages have vectors, it is keyword-only and says so.
 * Confluence and an Enterprise Knowledge Fabric are not connected, and the API says so.
 *
 * A source that disagrees with a higher-trust source goes to review: its passages are excluded
 * until an application owner decides the conflict in Huddle.
 */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { containsSecret } from '../src/lib/guardrails';
import { extractText, MAX_ATTACHMENT_BYTES } from './attachments';
import type { AppRecord, HorizonDb, PersonRecord } from './db';
import { createItem } from './huddle';
import { embeddingCounts, embedQuery, forgetCounts, fromBlob, NO_MODELS, rank, textSha, vectorCandidates, words, type Candidate, type RetrievalMode, type RetrievalModels } from './retrieval';
import type { BlobStore } from './storage';
import type { Workspace } from './workspace';

/** Thrown for a request the caller got wrong; the route layer turns it into that HTTP status. */
export class RequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export const MAX_UPLOAD_MB = MAX_ATTACHMENT_BYTES / 1024 / 1024;
/** Documentation files read from a clone, and how much of it. */
const MAX_DOC_FILES = 60;
const MAX_DOC_BYTES = 512 * 1024;
/** Build and CI files read from a clone (R19): how many, how large, and how many passages each. */
const MAX_BUILD_FILES = 40;
const MAX_BUILD_BYTES = 64 * 1024;
const MAX_CHUNKS_PER_BUILD_FILE = 12;
const MAX_CHUNKS_PER_SOURCE = 400;
const MIN_CHUNK_CHARS = 40;
const TARGET_CHUNK_CHARS = 900;
/** The exclusion reason of a passage that holds what looks like a secret; a decision never lifts it (F05). */
export const SECRET_REASON = 'Contains what looks like a password, key or token';

export type SourceType = 'Repository' | 'Jira' | 'Confluence' | 'Text' | 'PDF' | 'Word' | 'Image' | 'ZIP' | 'File';
/** Trust order: Confluence > Jira > code > team uploads. There is no Fabric here. */
export type Trust = 'High' | 'Tickets' | 'Code' | 'Team upload';
export type SourceStatus = 'ready' | 'indexed' | 'review' | 'processing' | 'failed' | 'stored';
export type ScopeKind = 'app' | 'workspace' | 'chat';

const TRUST_RANK: Record<Trust, number> = { High: 4, Tickets: 3, Code: 2, 'Team upload': 1 };

export interface SourceView {
  id: string;
  type: SourceType;
  title: string;
  sub: string;
  /** 'App' for the whole application, otherwise the workspace name. */
  scope: string;
  trust: Trust;
  status: SourceStatus;
  content: string;
  /** Why a source is not readable, or what to know about it. */
  note: string | null;
  /** Rows that open somewhere other than the source panel (Jira opens the ticket list). */
  href: string | null;
  addedBy: string | null;
  size: number | null;
  mime: string | null;
  /** Bumps when the indexed text changes; citations carry it. */
  version: number;
  createdAt: string;
  updatedAt: string;
  syncedAt: string | null;
  chunks: number;
  excludedChunks: number;
  /** The open conflict this source is in, if any. */
  conflictId: string | null;
}

export interface ChunkView {
  id: string;
  seq: number;
  locator: string;
  text: string;
  excludedReason: string | null;
  /** The source version this passage belongs to. */
  version: number;
  /** Set when the passage was replaced by a later version (kept for citations). */
  retiredAt: string | null;
}

export interface CompareRow {
  label: string;
  value: string;
  where: string;
}

export interface ConflictView {
  id: string;
  sourceId: string;
  sourceTitle: string;
  otherSourceId: string;
  otherTitle: string;
  huddleItemId: string | null;
  title: string;
  detail: string;
  compare: CompareRow[];
  status: 'open' | 'resolved';
  resolution: 'keep_higher' | 'use_upload' | null;
  createdAt: string;
}

export interface RankedChunk {
  chunkId: string | null;
  sourceId: string | null;
  sourceTitle: string;
  where: string;
  text: string;
  /** 0 to 1, relevance to the question, not correctness. */
  relevance: number;
  used: boolean;
  reason: string | null;
  href: string | null;
}

/** A passage an answer may cite. */
export interface ContextPassage {
  chunkId: string;
  sourceId: string;
  sourceTitle: string;
  sourceType: SourceType;
  version: number;
  locator: string;
  text: string;
  href: string;
}

type Row = Record<string, unknown>;
const iso = (ms: number) => new Date(ms).toISOString();
const str = (v: unknown) => (typeof v === 'string' ? v : '');
const nullable = (v: unknown) => (typeof v === 'string' ? v : null);
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

export const repoSourceId = (app: string, repo: string) => `${app}-repo-${repo}`;
export const jiraSourceId = (app: string) => `${app}-jira`;
export const sourceHref = (sourceId: string) => `/context/source/${encodeURIComponent(sourceId)}`;
/** A passage link is pinned to the source version it was read from (F20), so it keeps opening that text after a re-index. */
export const chunkHref = (sourceId: string, seq: number, version: number) => `${sourceHref(sourceId)}?v=${version}#chunk-${seq}`;
/** Passage ids carry the version too; version 1 keeps the historical "<source>#<seq>" form for existing rows. */
const chunkId = (sourceId: string, version: number, seq: number) => `${sourceId}@v${version}#${seq}`;

/* ---------- Reading ---------- */

const SELECT = `
  SELECT s.*, u.name AS added_by,
    (SELECT COUNT(*) FROM source_chunks c WHERE c.source_id = s.id AND c.retired_at IS NULL) AS chunk_count,
    (SELECT COUNT(*) FROM source_chunks c WHERE c.source_id = s.id AND c.retired_at IS NULL AND c.excluded_reason IS NOT NULL) AS excluded,
    (SELECT k.id FROM conflicts k WHERE k.source_id = s.id AND k.status = 'open' ORDER BY k.created_at LIMIT 1) AS conflict_id
  FROM context_sources s LEFT JOIN users u ON u.id = s.created_by`;

/** The row's summary from live counts (R16): an upload says how many passages it has now, and how many a decision excludes. */
function liveContent(r: Row): string {
  const n = Number(r.chunk_count ?? 0);
  const excluded = Number(r.excluded ?? 0);
  const base = r.type === 'Text' && n > 0 ? `${n} passage${n === 1 ? '' : 's'}` : str(r.content);
  return n > 0 && excluded > 0 ? `${base} · ${excluded} excluded` : base;
}

function toView(r: Row): SourceView {
  return {
    id: str(r.id),
    type: r.type as SourceType,
    title: str(r.title),
    sub: str(r.subtitle),
    scope: r.scope_type === 'workspace' ? str(r.scope_ref) : 'App',
    trust: r.trust as Trust,
    status: r.status as SourceStatus,
    content: liveContent(r),
    note: nullable(r.note),
    href: nullable(r.href),
    addedBy: nullable(r.added_by),
    size: r.size_bytes == null ? null : Number(r.size_bytes),
    mime: nullable(r.mime),
    version: Number(r.version ?? 1),
    createdAt: str(r.created_at),
    updatedAt: str(r.updated_at),
    syncedAt: nullable(r.synced_at),
    chunks: Number(r.chunk_count ?? 0),
    excludedChunks: Number(r.excluded ?? 0),
    conflictId: nullable(r.conflict_id),
  };
}

export function listSources(db: HorizonDb, app: string): SourceView[] {
  return (db.raw.prepare(`${SELECT} WHERE s.application_id = ? ORDER BY s.created_at DESC, s.rowid DESC`).all(app) as Row[]).map(toView);
}

/** A source of this application, or null (a source of another application is not found either). */
export function getSource(db: HorizonDb, app: string, id: string): SourceView | null {
  const r = db.raw.prepare(`${SELECT} WHERE s.application_id = ? AND s.id = ?`).get(app, id) as Row | undefined;
  return r ? toView(r) : null;
}

/** The current passages of a source, or the passages of one earlier version (as a citation saw them, F20). */
export function listChunks(db: HorizonDb, app: string, sourceId: string, version?: number): ChunkView[] {
  const rows = (
    version == null
      ? db.raw.prepare('SELECT c.* FROM source_chunks c JOIN context_sources s ON s.id = c.source_id WHERE s.application_id = ? AND c.source_id = ? AND c.retired_at IS NULL ORDER BY c.seq, c.rowid').all(app, sourceId)
      : db.raw.prepare('SELECT c.* FROM source_chunks c JOIN context_sources s ON s.id = c.source_id WHERE s.application_id = ? AND c.source_id = ? AND c.source_version = ? ORDER BY c.seq, c.rowid').all(app, sourceId, version)
  ) as Row[];
  return rows.map((c) => ({
    id: str(c.id),
    seq: Number(c.seq),
    locator: str(c.locator),
    text: str(c.text),
    excludedReason: nullable(c.excluded_reason),
    version: Number(c.source_version ?? 1),
    retiredAt: nullable(c.retired_at),
  }));
}

function mustGet(db: HorizonDb, app: string, id: string) {
  const s = getSource(db, app, id);
  if (!s) throw new RequestError(404, 'This source does not exist in this application.');
  return s;
}

/* ---------- Text into passages ---------- */

export interface Doc {
  /** Relative path, used in locators. */
  path: string;
  text: string;
  /** A build, container or CI file: split by lines with its layout kept, not by paragraphs (R19). */
  build?: boolean;
}

/**
 * Splits documents into passages: paragraphs (blank-line separated), short ones merged with the
 * next up to about 900 characters, anything under 40 characters dropped. Locators are
 * "<path> ¶<n>" so a citation can be opened at the passage.
 */
export function chunkDocs(docs: Doc[], max = MAX_CHUNKS_PER_SOURCE): { locator: string; text: string }[] {
  const out: { locator: string; text: string }[] = [];
  for (const d of docs) {
    if (d.build) {
      for (const c of chunkLines(d)) {
        out.push(c);
        if (out.length >= max) return out;
      }
      continue;
    }
    let n = 0;
    let buf = '';
    const flush = () => {
      const t = buf.replace(/\s+/g, ' ').trim();
      buf = '';
      if (t.length < MIN_CHUNK_CHARS) return;
      n++;
      out.push({ locator: `${d.path} ¶${n}`, text: t.length > 2000 ? `${t.slice(0, 1997)}…` : t });
    };
    for (const para of d.text.split(/\r?\n\s*\r?\n/)) {
      const p = para.trim();
      if (!p) continue;
      if (buf && buf.length + p.length > TARGET_CHUNK_CHARS) flush();
      buf = buf ? `${buf}\n${p}` : p;
      if (buf.length >= TARGET_CHUNK_CHARS) flush();
      if (out.length >= max) return out;
    }
    flush();
    if (out.length >= max) return out;
  }
  return out;
}

/**
 * A build or CI file as passages: consecutive lines up to about 900 characters, indentation kept
 * (a pom.xml or a workflow reads by its layout), blank runs squeezed, at most a dozen per file so a
 * large manifest cannot crowd out the documentation.
 */
function chunkLines(d: Doc): { locator: string; text: string }[] {
  const out: { locator: string; text: string }[] = [];
  let buf: string[] = [];
  let len = 0;
  const flush = () => {
    const t = buf.join('\n').replace(/\n{3,}/g, '\n\n').trim();
    buf = [];
    len = 0;
    if (t.length < MIN_CHUNK_CHARS || out.length >= MAX_CHUNKS_PER_BUILD_FILE) return;
    out.push({ locator: `${d.path} ¶${out.length + 1}`, text: t.length > 2000 ? `${t.slice(0, 1997)}…` : t });
  };
  for (const raw of d.text.split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '');
    if (len && len + line.length > TARGET_CHUNK_CHARS) flush();
    buf.push(line);
    len += line.length + 1;
  }
  flush();
  return out;
}

const DOC_NAME = /^(readme|changelog|changes|contributing|architecture|design|security|testing|api)(\.|$)/i;
const DOC_EXT = /\.(md|markdown|rst|txt|proto)$/i;
const SPEC_NAME = /(openapi|swagger)[^/]*\.(ya?ml|json)$/i;
const SKIP_DIR = /^(node_modules|vendor|third_party|dist|build|out|target|\.git|\.github|\.venv|venv|site-packages)$/;
/** Build, container and CI files that say how the code is built, tested and run (R19). Lock files are not among them. */
const BUILD_NAME = /^(pom\.xml|build\.gradle(\.kts)?|settings\.gradle(\.kts)?|package\.json|docker-compose[^/]*\.ya?ml|compose\.ya?ml|Dockerfile([.-][^/]*)?|\.travis\.yml|\.gitlab-ci\.yml|Jenkinsfile|Makefile|makefile|GNUmakefile)$/;
const isWorkflow = (rel: string) => /^\.github\/workflows\/[^/]+\.ya?ml$/i.test(rel.split(sep).join('/'));

/**
 * What is worth indexing in a clone: top-level READMEs and the like, docs/ markdown, protos, API
 * specs, and the build, container and CI files (pom.xml, build.gradle, package.json, Dockerfile,
 * docker-compose, .travis.yml, GitHub workflows, Makefile) up to 64 KB each and 40 in all. Build
 * files come back marked `build` so they are split by lines.
 */
export function collectDocs(cloneDir: string, maxFiles = MAX_DOC_FILES): Doc[] {
  const found: string[] = [];
  const builds: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 4) return;
    let entries: string[];
    try {
      entries = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const name of entries) {
      if (found.length >= maxFiles && builds.length >= MAX_BUILD_FILES) return;
      const p = join(dir, name);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      const rel = relative(cloneDir, p);
      if (st.isDirectory()) {
        // .github is skipped except for its workflows, which say how CI builds and tests the code.
        if (!SKIP_DIR.test(name) || (depth === 0 && name === '.github')) walk(p, depth + 1);
        continue;
      }
      if (st.size === 0) continue;
      if (BUILD_NAME.test(name) || isWorkflow(rel)) {
        if (st.size <= MAX_BUILD_BYTES && builds.length < MAX_BUILD_FILES) builds.push(p);
        continue;
      }
      if (rel.split(sep)[0] === '.github' || st.size > MAX_DOC_BYTES || found.length >= maxFiles) continue;
      const top = depth === 0;
      const inDocs = /^docs?\//i.test(rel);
      const isDoc = (DOC_NAME.test(name) && (DOC_EXT.test(name) || !name.includes('.'))) || (DOC_EXT.test(name) && (top || inDocs || /\.proto$/i.test(name))) || SPEC_NAME.test(name);
      if (isDoc) found.push(p);
    }
  };
  walk(cloneDir, 0);
  const read = (p: string, build: boolean): Doc | null => {
    const buf = readFileSync(p);
    if (buf.subarray(0, 4000).includes(0)) return null;
    const doc: Doc = { path: relative(cloneDir, p).split(sep).join('/'), text: buf.toString('utf8') };
    return build ? { ...doc, build: true } : doc;
  };
  // Documentation first, so the passage cap is spent on prose before manifests.
  return [...found.map((p) => read(p, false)), ...builds.map((p) => read(p, true))].filter((d): d is Doc => !!d);
}

/**
 * Writes a source's passages as a new version, keeping exclusions by locator so a decided conflict
 * survives a re-index. The version bumps only when the text actually changed; an unchanged source is
 * left alone (its passages, exclusions and vectors stay). The previous version's passages are
 * retired, not deleted (F20): a citation saved with an answer keeps opening the text it cited, while
 * retrieval only sees current passages. Vectors of passages whose text is unchanged are carried
 * over, so only new text waits for the embedding job. Returns the chunk count.
 */
function indexSource(db: HorizonDb, sourceId: string, chunks: { locator: string; text: string }[], at: number): { chunks: number; version: number; changed: boolean } {
  const digest = sha(chunks.map((c) => `${c.locator}\n${c.text}`).join('\n\u0000'));
  const cur = db.raw.prepare('SELECT version, sha256, (SELECT COUNT(*) FROM source_chunks c WHERE c.source_id = context_sources.id AND c.retired_at IS NULL) AS n FROM context_sources WHERE id = ?').get(sourceId) as { version: number; sha256: string | null; n: number };
  const changed = cur.sha256 !== digest;
  if (!changed && cur.n >= chunks.length) return { chunks: cur.n, version: cur.version, changed: false };
  const version = cur.sha256 && changed ? cur.version + 1 : cur.version;
  db.raw.transaction(() => {
    const kept = new Map((db.raw.prepare('SELECT locator, excluded_reason FROM source_chunks WHERE source_id = ? AND retired_at IS NULL AND excluded_reason IS NOT NULL').all(sourceId) as Row[]).map((r) => [str(r.locator), str(r.excluded_reason)]));
    // Vectors by text hash and model, to carry over for passages whose text did not change.
    const vectors = db.raw.prepare('SELECT e.model, e.dims, e.vector, e.text_sha FROM chunk_embeddings e JOIN source_chunks c ON c.id = e.chunk_id WHERE c.source_id = ?').all(sourceId) as { model: string; dims: number; vector: Buffer; text_sha: string }[];
    const byText = new Map<string, typeof vectors>();
    for (const v of vectors) {
      const list = byText.get(v.text_sha) ?? [];
      list.push(v);
      byText.set(v.text_sha, list);
    }
    // The previous version stays, retired; a version written twice (first index of a source whose rows exist) is replaced.
    db.raw.prepare('UPDATE source_chunks SET retired_at = ? WHERE source_id = ? AND retired_at IS NULL AND source_version != ?').run(iso(at), sourceId, version);
    db.raw.prepare('DELETE FROM source_chunks WHERE source_id = ? AND source_version = ? AND retired_at IS NULL').run(sourceId, version);
    const ins = db.raw.prepare('INSERT INTO source_chunks (id, source_id, locator, text, excluded_reason, seq, source_version, chars, text_sha) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
    const insVec = db.raw.prepare('INSERT OR IGNORE INTO chunk_embeddings (chunk_id, model, dims, vector, text_sha, created_at) VALUES (?, ?, ?, ?, ?, ?)');
    chunks.forEach((c, i) => {
      const id = chunkId(sourceId, version, i + 1);
      const h = textSha(c.text);
      // F05: a passage that holds what looks like a secret is kept out of retrieval, whatever else is decided about it.
      ins.run(id, sourceId, c.locator, c.text, kept.get(c.locator) ?? (containsSecret(c.text) ? SECRET_REASON : null), i + 1, version, c.text.length, h);
      for (const v of byText.get(h) ?? []) insVec.run(id, v.model, v.dims, v.vector, h, iso(at));
    });
    db.raw.prepare('UPDATE context_sources SET sha256 = ?, version = ?, updated_at = ? WHERE id = ?').run(digest, version, iso(at), sourceId);
  })();
  forgetCounts(db);
  return { chunks: chunks.length, version, changed };
}

/* ---------- Seeding from the workspace ---------- */

/** Honest about the source (F22): the backlog is a workspace file imported at start or reload, not a live Jira. */
const jiraSubtitle = (db: HorizonDb, app: string) => {
  const f = db.getFilter(app);
  return `filter: project = ${f.project} AND status in (${f.statuses.map((s) => `"${s}"`).join(', ')}) · workspace backlog, no live Jira connection`;
};
const JIRA_NOTE = 'Stories come from the workspace backlog (stories.json), imported when the server starts or an owner reloads the workspace; they are not split into passages here.';

const UPSERT = `
  INSERT INTO context_sources (id, application_id, scope_type, scope_ref, type, title, subtitle, trust, status, stage, content, note, href, location, created_by, created_at, updated_at, synced_at)
  VALUES (@id, @app, 'app', NULL, @type, @title, @subtitle, @trust, @status, NULL, @content, @note, @href, @location, NULL, @at, @at, @at)
  ON CONFLICT(id) DO UPDATE SET title = excluded.title, subtitle = excluded.subtitle, status = CASE WHEN context_sources.status = 'review' THEN 'review' ELSE excluded.status END,
    content = excluded.content, note = excluded.note, href = excluded.href, location = excluded.location, updated_at = excluded.updated_at, synced_at = excluded.synced_at`;

/** "26 passages from 1 documentation file and 12 build files": says what was read, so nobody assumes the code was (R19). */
const describeDocs = (docs: Doc[], chunks: number) => {
  if (!chunks) return 'No documentation or build files found to index';
  const builds = docs.filter((d) => d.build).length;
  const files = docs.length - builds;
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
  const from = [files ? plural(files, 'documentation file') : '', builds ? plural(builds, 'build file') : ''].filter(Boolean).join(' and ');
  return `${plural(chunks, 'passage')} from ${from}`;
};

/**
 * Seeds one Repository source per team repo (its documentation indexed from the clone when there
 * is one) and one Jira source per application. Idempotent: rows are updated in place, passages are
 * re-read on every seed so edits are picked up, decided exclusions are kept. Nothing is removed.
 */
export function seedContext(db: HorizonDb, ws: Workspace, at = Date.now()) {
  const counts = { repos: 0, indexed: 0, chunks: 0, jira: 0 };
  const upsert = db.raw.prepare(UPSERT);
  for (const team of ws.teams) {
    if (!db.getApp(team.id)) continue;
    for (const repo of team.repos) {
      const cloneDir = join(team.dir, 'repos', repo.name);
      const cloned = repo.clone && existsSync(cloneDir);
      const id = repoSourceId(team.id, repo.name);
      const parts = [repo.languages.length ? `Languages: ${repo.languages.join(', ')}` : '', repo.testFrameworks.length ? `Tests: ${repo.testFrameworks.join(', ')}` : ''].filter(Boolean);
      const docs = cloned ? collectDocs(cloneDir) : [];
      const chunks = chunkDocs(docs);
      upsert.run({
        id,
        app: team.id,
        type: 'Repository',
        title: repo.name,
        subtitle: `GitHub · ${repo.github}${parts.length ? ` · ${parts.join(' · ')}` : ''}`,
        trust: 'Code',
        status: cloned ? 'indexed' : 'ready',
        content: cloned ? describeDocs(docs, chunks.length) : 'Not indexed',
        note: cloned ? (repo.note ?? null) : ['Scanned through GitHub only; there is no local clone to index.', repo.note].filter(Boolean).join(' '),
        href: null,
        location: cloned ? cloneDir : null,
        at: iso(at),
      });
      counts.repos++;
      if (cloned) {
        counts.indexed++;
        counts.chunks += indexSource(db, id, chunks, at).chunks;
      }
    }
    upsert.run({
      id: jiraSourceId(team.id),
      app: team.id,
      type: 'Jira',
      title: `Jira · project ${team.jiraProject}`,
      subtitle: jiraSubtitle(db, team.id),
      trust: 'Tickets',
      status: 'ready',
      content: `${db.listStories(team.id).length} tickets in the filter`,
      note: JIRA_NOTE,
      href: '/tickets',
      location: null,
      at: iso(at),
    });
    counts.jira++;
  }
  return counts;
}

/* ---------- Adding context ---------- */

interface Scope {
  kind: ScopeKind;
  ref: string | null;
}

function scopeOf(app: AppRecord, kind: unknown, workspace: unknown): Scope {
  if (kind === 'chat') throw new RequestError(400, 'Files for one chat go with the message: use the attach button in the composer.');
  if (kind !== 'app' && kind !== 'workspace') throw new RequestError(400, 'scope must be app or workspace.');
  if (kind !== 'workspace') return { kind, ref: null };
  if (typeof workspace !== 'string' || !app.workspaces.includes(workspace)) {
    throw new RequestError(400, `Choose one of this application's workspaces: ${app.workspaces.join(', ')}.`);
  }
  return { kind, ref: workspace };
}

export const scopeLabel = (app: AppRecord, scope: string) => `${app.name} · ${scope === 'App' ? 'whole app' : scope}`;

const typeForUpload = (name: string, readable: boolean): SourceType => {
  const e = name.split('.').pop()?.toLowerCase() ?? '';
  if (readable) return 'Text';
  if (e === 'pdf') return 'PDF';
  if (e === 'doc' || e === 'docx') return 'Word';
  if (e === 'png' || e === 'jpg' || e === 'jpeg') return 'Image';
  if (e === 'zip') return 'ZIP';
  return 'File';
};

export interface UploadInput {
  filename: string;
  data: Buffer;
}

/**
 * Stores uploads for an application or one of its workspaces. Text formats are read and split
 * into passages at once (status ready); other formats are kept with their bytes and marked
 * stored, with the reason they cannot be read. Returns one message per refused file.
 */
export async function addUploads(db: HorizonDb, store: BlobStore, app: AppRecord, user: PersonRecord, files: UploadInput[], kind: unknown, workspace: unknown, at = Date.now()) {
  const scope = scopeOf(app, kind, workspace);
  if (files.length === 0) throw new RequestError(400, 'Choose at least one file.');
  if (files.length > 10) throw new RequestError(400, 'Add at most 10 files at a time.');
  const errors: string[] = [];
  const sources: SourceView[] = [];
  for (const f of files) {
    const name = f.filename.replace(/[\\/]/g, '_').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 200) || 'file';
    if (f.data.length === 0) {
      errors.push(`${name}: the file is empty.`);
      continue;
    }
    if (f.data.length > MAX_ATTACHMENT_BYTES) {
      errors.push(`${name} is over the ${MAX_UPLOAD_MB} MB limit.`);
      continue;
    }
    const id = `src-${randomUUID().slice(0, 8)}`;
    const key = `${app.id}/${id}`;
    const { text, mime, status, note } = extractText(name, f.data);
    // F05: a file that holds what looks like a secret is not kept at all.
    if (text && containsSecret(text)) {
      errors.push(`${name}: contains what looks like a password, key or token, so it was not kept. Remove it (and rotate it if it is real), then upload again.`);
      continue;
    }
    try {
      await store.put(key, f.data);
    } catch (e) {
      errors.push(`${name}: could not be stored (${(e as Error).message}).`);
      continue;
    }
    const chunks = text ? chunkDocs([{ path: name, text }]) : [];
    const type = typeForUpload(name, status === 'ready');
    db.raw.transaction(() => {
      db.raw
        .prepare(
          `INSERT INTO context_sources (id, application_id, scope_type, scope_ref, type, title, subtitle, trust, status, stage, content, note, href, location, size_bytes, created_by, created_at, updated_at, synced_at, storage_key, mime)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'Team upload', ?, NULL, ?, ?, NULL, NULL, ?, ?, ?, ?, NULL, ?, ?)`,
        )
        .run(id, app.id, scope.kind, scope.ref, type, name, `${type === 'Text' ? 'Upload' : `${type} upload`} · ${user.name}`, status === 'ready' ? 'ready' : 'stored', status === 'ready' ? `${chunks.length} passage${chunks.length === 1 ? '' : 's'}` : 'Kept, not readable', note, f.data.length, user.id, iso(at), iso(at), key, mime);
      db.audit('user', user.id, 'context.upload', 'context_source', id, { app: app.id, filename: name, status, size: f.data.length });
    })();
    if (chunks.length) indexSource(db, id, chunks, at);
    sources.push(getSource(db, app.id, id)!);
  }
  return { sources, errors, notice: sources.length ? `Added ${sources.map((s) => s.title).join(', ')}.` : '' };
}

/** Confluence is not connected in this build; this says so instead of pretending. */
export function addConfluence(): never {
  throw new RequestError(501, 'Confluence is not connected in this build. Export the page as Markdown or text and upload it, so Catalyzt can read it.');
}

/** Re-syncs a source: a repository re-reads its documentation, Jira records the sync. Uploads have nothing to sync. */
export function syncSource(db: HorizonDb, app: string, id: string, at = Date.now()) {
  const s = mustGet(db, app, id);
  const location = (db.raw.prepare('SELECT location FROM context_sources WHERE id = ?').get(id) as { location: string | null }).location;
  let notice: string;
  if (s.type === 'Repository') {
    if (!location || !existsSync(location)) notice = `${s.title} is scanned through GitHub only; there is nothing local to re-index.`;
    else {
      const docs = collectDocs(location);
      const r = indexSource(db, id, chunkDocs(docs), at);
      db.raw.prepare('UPDATE context_sources SET content = ? WHERE id = ?').run(describeDocs(docs, r.chunks), id);
      notice = `${s.title} synced: ${r.chunks} passage${r.chunks === 1 ? '' : 's'}${r.changed ? `, now version ${r.version}` : ', unchanged'}.`;
    }
  } else if (s.type === 'Jira') {
    // No live Jira: the row is refreshed from what the workspace import left in the database (F22).
    db.raw.prepare('UPDATE context_sources SET subtitle = ?, content = ?, note = ? WHERE id = ?').run(jiraSubtitle(db, app), `${db.listStories(app).length} tickets in the filter`, JIRA_NOTE, id);
    notice = `${s.title}: ${db.listStories(app).length} tickets from the workspace backlog; there is no live Jira to sync.`;
  } else {
    throw new RequestError(400, `${s.title} is an upload and has nothing to sync. Upload a new version instead.`);
  }
  db.raw.prepare('UPDATE context_sources SET synced_at = ?, updated_at = ? WHERE id = ?').run(iso(at), iso(at), id);
  return { source: getSource(db, app, id)!, notice };
}

/* ---------- Retrieval ---------- */

const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

function exclusionReason(r: Row): string | null {
  if (r.excluded_reason) return `Excluded: ${lowerFirst(str(r.excluded_reason))}`;
  if (r.conflicted) return 'Excluded: unresolved conflict';
  if (r.status === 'processing') return 'Excluded: not ready';
  if (r.status === 'failed') return 'Excluded: the source failed';
  if (r.status === 'stored') return 'Excluded: not readable';
  if (r.status === 'review') return 'Excluded: needs review';
  return null;
}

interface Cand extends Candidate {
  chunkId: string | null;
  sourceId: string | null;
  sourceTitle: string;
  sourceType: SourceType;
  version: number;
  locator: string;
  reason: string | null;
  href: string | null;
  scope: string;
}

/** How many candidates a question may bring in from each side before ranking (F24). */
const LEXICAL_CANDIDATES = 200;
const VECTOR_CANDIDATES = 60;

/**
 * The rowids of the passages worth ranking for a question: the best lexical matches from the
 * full-text index (porter stemming, bm25 order) plus the nearest vectors. Null when the full-text
 * index cannot answer (missing or a query it rejects), which means "consider every passage".
 */
function candidateRowids(db: HorizonDb, app: string, models: RetrievalModels, query: string, queryVector: Float32Array | null): number[] | null {
  const qw = words(query);
  const ids = new Set<number>();
  if (qw.length) {
    try {
      const match = qw.map((w) => `"${w.replace(/"/g, '')}"`).join(' OR ');
      const rows = db.raw
        .prepare(
          `SELECT c.rowid AS rid FROM source_chunks_fts f JOIN source_chunks c ON c.rowid = f.rowid JOIN context_sources s ON s.id = c.source_id
           WHERE source_chunks_fts MATCH ? AND s.application_id = ? AND c.retired_at IS NULL ORDER BY bm25(source_chunks_fts) LIMIT ?`,
        )
        .all(match, app, LEXICAL_CANDIDATES) as { rid: number }[];
      for (const r of rows) ids.add(r.rid);
    } catch {
      return null;
    }
  }
  for (const rid of vectorCandidates(db, app, models.embedder, queryVector, VECTOR_CANDIDATES)) ids.add(rid);
  return [...ids];
}

/**
 * Rebuilds the full-text index when it disagrees with the passages (rowids of a text-keyed table can
 * move under VACUUM). Called at start-up; cheap when nothing is wrong.
 */
export function ensureFts(db: HorizonDb) {
  try {
    // An external-content index reads rows from source_chunks, so a COUNT never disagrees; the strict
    // integrity check (rank = 1) compares the index with the table and fails when they differ. On a
    // SQLite without it the statement itself fails, which also ends in a rebuild: always safe.
    db.raw.exec("INSERT INTO source_chunks_fts(source_chunks_fts, rank) VALUES ('integrity-check', 1)");
    return false;
  } catch {
    try {
      db.raw.exec("INSERT INTO source_chunks_fts(source_chunks_fts) VALUES ('rebuild')");
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * The passages of the application worth considering, with their vector for the given embedding
 * model when it was computed from the passage's current text (F25) and has the model's dimensions.
 * With a question, only its candidates are loaded (F24); without one, every current passage.
 */
function candidates(db: HorizonDb, app: string, models: RetrievalModels, dims = 0, question?: { query: string; queryVector: Float32Array | null }): Cand[] {
  const model = models.embedder?.id ?? null;
  const rowids = question ? candidateRowids(db, app, models, question.query, question.queryVector) : null;
  if (rowids !== null && rowids.length === 0) return [];
  const select = `SELECT c.id, c.seq, c.locator, c.text, c.excluded_reason, s.id AS sid, s.title, s.type, s.status, s.version, s.scope_type, s.scope_ref,
         (SELECT 1 FROM conflicts k WHERE k.source_id = s.id AND k.status = 'open' LIMIT 1) AS conflicted,
         e.vector AS vector
       FROM source_chunks c JOIN context_sources s ON s.id = c.source_id
       LEFT JOIN chunk_embeddings e ON e.chunk_id = c.id AND e.model = ? AND e.text_sha = c.text_sha
       WHERE s.application_id = ? AND c.retired_at IS NULL`;
  const rows = (rowids === null ? db.raw.prepare(select).all(model ?? '', app) : db.raw.prepare(`${select} AND c.rowid IN (${rowids.map(() => '?').join(', ')})`).all(model ?? '', app, ...rowids)) as Row[];
  const usable = (v: unknown): v is Buffer => Buffer.isBuffer(v) && v.byteLength > 0 && v.byteLength % 4 === 0 && (!dims || v.byteLength === dims * 4);
  return rows.map((r) => ({
    key: str(r.id),
    chunkId: str(r.id),
    sourceId: str(r.sid),
    sourceTitle: str(r.title),
    sourceType: r.type as SourceType,
    version: Number(r.version ?? 1),
    locator: str(r.locator),
    where: `${str(r.title)} · ${str(r.locator)}`,
    text: str(r.text),
    vector: usable(r.vector) ? fromBlob(r.vector) : null,
    reason: exclusionReason(r),
    href: chunkHref(str(r.sid), Number(r.seq), Number(r.version ?? 1)),
    scope: r.scope_type === 'workspace' ? str(r.scope_ref) : 'App',
  }));
}

export interface RetrievalOptions {
  limit?: number;
  workspace?: string | null;
  minRelevance?: number;
  /** The embedder and reranker to use; none means keyword-only. */
  models?: RetrievalModels;
}

export interface Retrieval {
  passages: ContextPassage[];
  mode: RetrievalMode;
  reranked: boolean;
  /** Passages of the application with a current vector, out of all; below total while the embedding job runs. */
  embedded: number;
  total: number;
  /** How many passages were loaded and ranked for the question (bounded, F24). */
  candidates: number;
}

/** Relevance (0 to 1) a passage needs before an answer may use it. */
const MIN_RELEVANCE = 0.2;

/** What the step line and the API say about how passages were found. */
export const describeRetrieval = (r: { mode: RetrievalMode; reranked: boolean; embedded: number; total: number }) => {
  if (r.mode === 'keyword') return 'keyword match';
  const left = r.total - r.embedded;
  return `hybrid: keyword and meaning${r.reranked ? ', reranked' : ''}${left > 0 ? `; ${left} passage${left === 1 ? '' : 's'} not embedded yet` : ''}`;
};

/**
 * "Test a question": the top passages for a question, including the ones Catalyzt would not use
 * and why, plus Jira stories and Hexa test titles so the person sees everything considered.
 */
export async function testQuestion(db: HorizonDb, app: AppRecord, question: string, models: RetrievalModels = NO_MODELS) {
  const queryVector = await embedQuery(models, question);
  const cands: Cand[] = candidates(db, app.id, models, models.embedder?.dims ?? 0, { query: question, queryVector });
  const stories = db.listStories(app.id);
  for (const s of stories) cands.push({ key: `jira:${s.key}`, chunkId: null, sourceId: jiraSourceId(app.id), sourceTitle: 'Jira', sourceType: 'Jira', version: 1, locator: s.key, where: `Jira · ${s.key}`, text: [s.summary, ...s.acceptanceCriteria].join(' '), reason: null, href: `/tickets/${s.key}`, scope: 'App' });
  const tests = db.listTests(app.id, { limit: 200 }).rows;
  for (const t of tests) cands.push({ key: `hexa:${t.id}`, chunkId: null, sourceId: null, sourceTitle: 'Hexa', sourceType: 'File', version: 1, locator: t.id, where: `Hexa · ${t.id}`, text: t.suite ? `${t.title} (${t.suite})` : t.title, reason: null, href: `/hexa/test/${t.id}`, scope: 'App' });
  const counts = embeddingCounts(db, models.embedder?.id ?? null, app.id);
  const considered = { passages: counts.embedded + counts.pending, candidates: cands.filter((c) => c.chunkId).length, stories: stories.length, tests: tests.length };
  if (words(question).length === 0 && !models.embedder) return { results: [] as RankedChunk[], considered, mode: 'keyword' as RetrievalMode, reranked: false, how: describeRetrieval({ mode: 'keyword', reranked: false, embedded: 0, total: 0 }) };
  const r = await rank(models, question, cands, { limit: 5, minRelevance: 0.01, queryVector });
  // "Used" means an answer would take it: usable source and above the same relevance bar retrieveContext applies.
  const results: RankedChunk[] = r.ranked.map(({ item: c, relevance }) => {
    const reason = c.reason ?? (relevance < MIN_RELEVANCE ? 'Below the relevance bar' : null);
    return { chunkId: c.chunkId, sourceId: c.sourceId, sourceTitle: c.sourceTitle, where: c.where, text: c.text, relevance: Math.round(relevance * 100) / 100, used: !reason, reason, href: c.href };
  });
  return { results, considered, mode: r.mode, reranked: r.reranked, how: describeRetrieval({ ...r, embedded: counts.embedded, total: counts.embedded + counts.pending }) };
}

/**
 * The passages an answer may use for a request: usable ones only (no excluded, review, stored or
 * failed sources), scoped to the whole application or the given workspace, best first. Empty when
 * nothing clears the relevance bar, so the specialist is not fed noise. Hybrid when the models are
 * given and passages have vectors; keyword-only otherwise, and the result says which.
 */
export async function retrieveContext(db: HorizonDb, app: string, query: string, opts: RetrievalOptions = {}): Promise<Retrieval> {
  const models = opts.models ?? NO_MODELS;
  const queryVector = await embedQuery(models, query);
  const usable = candidates(db, app, models, models.embedder?.dims ?? 0, { query, queryVector }).filter((c) => !c.reason && c.chunkId && (c.scope === 'App' || !opts.workspace || c.scope === opts.workspace));
  const r = await rank(models, query, usable, { limit: opts.limit ?? 4, minRelevance: opts.minRelevance ?? MIN_RELEVANCE, queryVector });
  const counts = embeddingCounts(db, models.embedder?.id ?? null, app);
  return {
    passages: r.ranked.map(({ item: c }) => ({ chunkId: c.chunkId!, sourceId: c.sourceId!, sourceTitle: c.sourceTitle, sourceType: c.sourceType, version: c.version, locator: c.locator, text: c.text, href: c.href! })),
    // Keyword mode is honest about the application, not just this question's candidates.
    mode: models.embedder && counts.embedded > 0 ? r.mode : 'keyword',
    reranked: r.reranked,
    embedded: counts.embedded,
    total: counts.embedded + counts.pending,
    candidates: usable.length,
  };
}

/* ---------- Conflicts ---------- */

function toConflict(r: Row): ConflictView {
  let compare: CompareRow[] = [];
  try {
    compare = JSON.parse(str(r.compare) || '[]') as CompareRow[];
  } catch {
    compare = [];
  }
  return {
    id: str(r.id),
    sourceId: str(r.source_id),
    sourceTitle: str(r.source_title),
    otherSourceId: str(r.other_source_id),
    otherTitle: str(r.other_title),
    huddleItemId: nullable(r.huddle_item_id),
    title: str(r.title),
    detail: str(r.detail),
    compare,
    status: r.status as ConflictView['status'],
    resolution: (nullable(r.resolution) as ConflictView['resolution']) ?? null,
    createdAt: str(r.created_at),
  };
}

const CONFLICT_SELECT = `
  SELECT k.*, s.title AS source_title, o.title AS other_title FROM conflicts k
  JOIN context_sources s ON s.id = k.source_id LEFT JOIN context_sources o ON o.id = k.other_source_id`;

export function listConflicts(db: HorizonDb, app: string, status: 'open' | 'all' = 'open'): ConflictView[] {
  const rows = db.raw.prepare(`${CONFLICT_SELECT} WHERE s.application_id = ? ${status === 'open' ? "AND k.status = 'open'" : ''} ORDER BY k.created_at DESC`).all(app) as Row[];
  return rows.map(toConflict);
}

export function getConflict(db: HorizonDb, app: string, id: string): ConflictView | null {
  const r = db.raw.prepare(`${CONFLICT_SELECT} WHERE s.application_id = ? AND k.id = ?`).get(app, id) as Row | undefined;
  return r ? toConflict(r) : null;
}

export interface ConflictInput {
  sourceId: string;
  otherSourceId: string;
  title: string;
  detail: string;
  compare: Partial<CompareRow>[];
}

const finalStatus = (type: SourceType): SourceStatus => (type === 'Repository' ? 'indexed' : 'ready');

/**
 * Raises a conflict between a source and a higher-trust source. The source goes to review with
 * its passages excluded (plus one passage for the disputed claim, so a question shows it), and a
 * Huddle item of kind conflict is created with two options: keep the higher-trust source, or use
 * the upload. Deciding the item resolves the conflict.
 */
export function raiseConflict(db: HorizonDb, app: AppRecord, user: PersonRecord, input: ConflictInput, at = Date.now()) {
  const source = mustGet(db, app.id, str(input.sourceId));
  const other = getSource(db, app.id, str(input.otherSourceId));
  if (!other) throw new RequestError(400, 'Choose the higher-trust source this one disagrees with.');
  if (other.id === source.id) throw new RequestError(400, 'A source cannot conflict with itself.');
  if (TRUST_RANK[other.trust] <= TRUST_RANK[source.trust]) throw new RequestError(400, `${other.title} (${other.trust}) does not rank above ${source.title} (${source.trust}); a conflict is always with a higher-trust source.`);
  if (source.status === 'processing' || source.status === 'failed' || source.status === 'stored') throw new RequestError(400, `${source.title} is ${source.status === 'stored' ? 'not readable' : source.status}; a conflict can only be raised on a readable source.`);
  if (source.conflictId) throw new RequestError(409, `${source.title} already has an open conflict. Decide it in Huddle first.`);
  const title = str(input.title).trim().slice(0, 200);
  if (!title) throw new RequestError(400, 'Say what the conflict is about (title).');
  const detail = str(input.detail).trim().slice(0, 2000);
  const rows = Array.isArray(input.compare) ? input.compare : [];
  const compare: CompareRow[] = [source, other].map((s, i) => {
    const c = (rows[i] ?? {}) as Partial<CompareRow>;
    return { label: str(c.label).trim().slice(0, 120) || s.title, value: str(c.value).trim().slice(0, 300), where: str(c.where).trim().slice(0, 200) };
  });
  if (!compare[0].value || !compare[1].value) throw new RequestError(400, 'Give what each source says (two compare rows with a value).');

  const id = `cf-${randomUUID().slice(0, 8)}`;
  const reason = `Unresolved conflict with ${other.title}`;
  let itemId = '';
  db.raw.transaction(() => {
    const claimLocator = compare[0].where || 'disputed claim';
    const exists = db.raw.prepare('SELECT 1 FROM source_chunks WHERE source_id = ? AND retired_at IS NULL AND text = ?').get(source.id, compare[0].value);
    if (!exists) {
      const { n } = db.raw.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM source_chunks WHERE source_id = ? AND retired_at IS NULL').get(source.id) as { n: number };
      db.raw.prepare('INSERT INTO source_chunks (id, source_id, locator, text, excluded_reason, seq, source_version, chars, text_sha) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?)').run(chunkId(source.id, source.version, n), source.id, claimLocator, compare[0].value, n, source.version, compare[0].value.length, textSha(compare[0].value));
    }
    db.raw.prepare('UPDATE source_chunks SET excluded_reason = ? WHERE source_id = ? AND retired_at IS NULL').run(reason, source.id);
    db.raw.prepare("UPDATE context_sources SET status = 'review', updated_at = ? WHERE id = ?").run(iso(at), source.id);
    db.raw
      .prepare('INSERT INTO conflicts (id, source_id, other_source_id, summary, huddle_item_id, status, title, detail, compare, created_at) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)')
      .run(id, source.id, other.id, detail || title, 'open', title, detail, JSON.stringify(compare), iso(at));
    const excluded = (db.raw.prepare('SELECT COUNT(*) AS n FROM source_chunks WHERE source_id = ? AND retired_at IS NULL').get(source.id) as { n: number }).n;
    const item = createItem(
      db,
      app,
      { type: 'user', ref: user.id },
      {
        kind: 'conflict',
        title,
        summary: detail || `${source.title} disagrees with ${other.title}. ${excluded} passage${excluded === 1 ? '' : 's'} excluded until decided.`,
        scope: scopeLabel(app, source.scope),
        aiSummary: `${compare[0].label}: ${compare[0].value} [1]. ${compare[1].label}: ${compare[1].value} [2]. ${source.title} (${lowerFirst(source.trust)}) ranks below ${other.title} (${lowerFirst(other.trust)}), so Catalyzt keeps using ${other.title} and leaves ${excluded} passage${excluded === 1 ? '' : 's'} of ${source.title} out until this is decided.`,
        citations: [
          { n: 1, title: compare[0].label, detail: [compare[0].where, lowerFirst(source.trust)].filter(Boolean).join(' · '), href: sourceHref(source.id) },
          { n: 2, title: compare[1].label, detail: [compare[1].where, lowerFirst(other.trust)].filter(Boolean).join(' · '), href: other.href ?? sourceHref(other.id) },
        ],
        options: [
          { title: `Keep ${other.title}: ${compare[1].value}`, detail: `${source.title} stays excluded for this point; ask its author to update it.`, keepsUpload: false },
          { title: `Use ${source.title}: ${compare[0].value}`, detail: `Its passages are used again; ask the owners of ${other.title} to update.`, keepsUpload: true },
        ],
        affects: [
          { label: source.title, href: sourceHref(source.id) },
          { label: other.title, href: other.href ?? sourceHref(other.id) },
        ],
        sourceId: source.id,
      },
      iso(at),
    );
    itemId = item.id;
    db.raw.prepare('UPDATE conflicts SET huddle_item_id = ? WHERE id = ?').run(itemId, id);
    db.audit('user', user.id, 'context.conflict', 'context_source', source.id, { conflictId: id, huddleItemId: itemId, other: other.id });
  })();
  return { conflict: getConflict(db, app.id, id)!, huddleItemId: itemId };
}

/**
 * Applies a Huddle decision to the conflict it came from. When the upload wins its passages are
 * used again; otherwise they stay excluded. The source leaves review either way. Returns the
 * conflict, or null when the item has none.
 */
export function resolveConflictForItem(db: HorizonDb, itemId: string, keepsUpload: boolean, at = Date.now()): ConflictView | null {
  const r = db.raw.prepare("SELECT k.id, k.source_id, s.application_id, s.type FROM conflicts k JOIN context_sources s ON s.id = k.source_id WHERE k.huddle_item_id = ? AND k.status = 'open'").get(itemId) as Row | undefined;
  if (!r) return null;
  const sourceId = str(r.source_id);
  db.raw.transaction(() => {
    db.raw.prepare("UPDATE conflicts SET status = 'resolved', resolution = ?, resolved_at = ? WHERE id = ?").run(keepsUpload ? 'use_upload' : 'keep_higher', iso(at), r.id);
    if (keepsUpload) db.raw.prepare('UPDATE source_chunks SET excluded_reason = NULL WHERE source_id = ? AND retired_at IS NULL AND excluded_reason IS NOT ?').run(sourceId, SECRET_REASON);
    db.raw.prepare('UPDATE context_sources SET status = ?, updated_at = ? WHERE id = ?').run(finalStatus(r.type as SourceType), iso(at), sourceId);
  })();
  return getConflict(db, str(r.application_id), str(r.id));
}
