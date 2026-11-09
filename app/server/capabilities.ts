/**
 * The capability map (docs/FLOWS.md › Regression): what an application does, as a list of capabilities
 * with the checks a UI test can verify. The agent drafts it from App Context (the repositories'
 * documentation); people edit and confirm it; it lives with the application, not with a flow.
 *
 * Coverage is read against it: a check counts as covered when an automated test a person linked to it
 * (capability_check_tests) passed in the target build of its repository. Tests that share a check's
 * words are suggested, never counted, exactly as in the flows.
 */
import { randomUUID } from 'node:crypto';

import type { Capability, CapabilityCheck, CapabilityMap, CheckStatus, CheckTest } from '../src/lib/capabilityTypes';
import { listChunks, listSources } from './context';
import type { AppRecord, HorizonDb } from './db';
import { completeJson, type DeepSeekConfig } from './deepseek';
import { asAgent } from './ingest';

export class CapabilityError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

type Row = Record<string, unknown>;
const now = () => new Date().toISOString();
const clean = (s: unknown, max: number) => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim().slice(0, max) : '');

/* ---------- What the documentation says the application does ---------- */

/** Documents about internals, plans and history, not about what the application does for its users. */
const SKIP_DOC = /(FINDINGS|ISSUES|PROGRESS|PLAN|DEPLOYMENT|DATA_MODEL|MIGRATION|BRIEF|CHANGELOG|CONTRIBUTING|LICENSE|SECURITY|DESIGN)/i;

/** The passages of the application's repositories that describe it, overview first, bounded for the model. */
export function knowledgePassages(db: HorizonDb, app: string, maxChars = 28_000): { locator: string; text: string }[] {
  const out: { locator: string; text: string }[] = [];
  let used = 0;
  const repos = listSources(db, app).filter((s) => s.type === 'Repository');
  const chunks = repos.flatMap((s) => listChunks(db, app, s.id).filter((c) => !c.retiredAt && !c.excludedReason && (c.kind === 'overview' || c.kind === 'guide')));
  const file = (locator: string) => locator.split(' ¶')[0];
  const rank = (c: { kind: string | null; locator: string }) => (c.kind === 'overview' ? 0 : /^README\.md/i.test(c.locator) ? 1 : /^docs\//i.test(c.locator) ? 2 : 3);
  for (const c of chunks.filter((c) => !SKIP_DOC.test(file(c.locator))).sort((a, b) => rank(a) - rank(b) || a.locator.localeCompare(b.locator))) {
    const text = c.text.trim();
    if (!text) continue;
    if (used + text.length > maxChars) break;
    out.push({ locator: c.locator, text });
    used += text.length;
  }
  return out;
}

interface Proposed {
  name: string;
  summary: string;
  component: string | null;
  sources: string[];
  checks: string[];
}

export function mapMessages(appName: string, components: string[], passages: { locator: string; text: string }[]) {
  const system = `You map what an application does, for a QA team that will test it through its user interface. Reply with json only.
Rules:
- Only what the passages say the application does today. Never invent features, numbers or behaviour they do not describe.
- 6 to 12 capabilities. Each is a user-facing area in the application's own words: a name of 2 to 4 words and a one-sentence summary.
- component: the given component whose test folder the capability's tests belong in, or null when none fits.
- checks: 3 to 6 per capability. Each is one observable behaviour a UI test can verify, written as one plain sentence with a concrete outcome ("Starting a UAT flow from the Start page shows the chosen stories at Analyse"). No implementation details.
- sources: the locators of the passages each capability came from.
Return exactly this json shape:
{"capabilities":[{"name":"Validation Flows","summary":"A team takes stories through UAT or regression, every step derived from records.","component":"flows","sources":["docs/FLOWS.md ¶3"],"checks":["Starting a UAT flow from the Start page shows the chosen stories at Analyse"]}]}`;
  const user = `Application: ${appName}\nComponents (test folders): ${components.join(', ') || '(none)'}\n\nPassages:\n${passages.map((p) => `[${p.locator}]\n${p.text}`).join('\n\n')}`;
  return [
    { role: 'system' as const, content: system },
    { role: 'user' as const, content: user },
  ];
}

export function parseProposal(raw: unknown, components: string[]): Proposed[] {
  const list = raw && typeof raw === 'object' && Array.isArray((raw as { capabilities?: unknown }).capabilities) ? ((raw as { capabilities: unknown[] }).capabilities as unknown[]) : [];
  const out: Proposed[] = [];
  for (const x of list.slice(0, 20)) {
    const r = (x ?? {}) as Record<string, unknown>;
    const name = clean(r.name, 60);
    if (!name) continue;
    const checks = Array.isArray(r.checks) ? r.checks.map((c) => clean(c, 220)).filter(Boolean).slice(0, 8) : [];
    const component = typeof r.component === 'string' && components.includes(r.component) ? r.component : null;
    const sources = Array.isArray(r.sources) ? r.sources.map((s) => clean(s, 120)).filter(Boolean).slice(0, 12) : [];
    out.push({ name, summary: clean(r.summary, 240), component, sources, checks });
  }
  if (!out.length) throw new CapabilityError(502, 'The model returned no capabilities.');
  return out;
}

const titleOf = (name: string) => name.replace(/[-_]+/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase());

/** Without a model: one capability per component, with one check that a UI test can always start from. */
function rulesProposal(app: AppRecord): Proposed[] {
  return app.components.map((c) => ({
    name: titleOf(c.name),
    summary: `The ${c.name} part of ${app.name}.`,
    component: c.name,
    sources: [],
    checks: [`${titleOf(c.name)} opens and shows its main content without an error`],
  }));
}

/** Adds the proposal to the map: new capabilities are created, known ones (by name) get their missing checks; nothing a person wrote is changed or removed. */
function mergeProposal(db: HorizonDb, app: string, proposed: Proposed[], userId: string) {
  const at = now();
  const existing = db.raw.prepare('SELECT id, name, origin, component, position FROM capabilities WHERE application_id = ? AND removed_at IS NULL').all(app) as Row[];
  let position = existing.reduce((m, r) => Math.max(m, Number(r.position)), 0);
  const r = { added: 0, updated: 0, checksAdded: 0 };
  const tx = db.raw.transaction(() => {
    for (const p of proposed) {
      const found = existing.find((e) => String(e.name).toLowerCase() === p.name.toLowerCase());
      let capId: string;
      if (found) {
        capId = String(found.id);
        if (found.origin === 'agent') db.raw.prepare('UPDATE capabilities SET summary = ?, component = COALESCE(component, ?), sources = ?, updated_at = ? WHERE id = ?').run(p.summary, p.component, JSON.stringify(p.sources), at, capId);
        r.updated++;
      } else {
        capId = randomUUID();
        db.raw
          .prepare('INSERT INTO capabilities (id, application_id, name, summary, component, position, origin, sources, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .run(capId, app, p.name, p.summary, p.component, ++position, 'agent', JSON.stringify(p.sources), userId, at, at);
        r.added++;
      }
      const have = new Set((db.raw.prepare('SELECT text FROM capability_checks WHERE capability_id = ? AND removed_at IS NULL').all(capId) as { text: string }[]).map((x) => x.text.toLowerCase()));
      let pos = have.size;
      for (const text of p.checks) {
        if (have.has(text.toLowerCase())) continue;
        db.raw.prepare('INSERT INTO capability_checks (id, capability_id, text, position, origin, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(randomUUID(), capId, text, ++pos, 'agent', at);
        have.add(text.toLowerCase());
        r.checksAdded++;
      }
    }
  });
  tx();
  return r;
}

/** The agent: reads App Context, proposes capabilities and checks, merges them into the map. Recorded as an agent run. */
export async function mapCapabilities(db: HorizonDb, cfg: DeepSeekConfig | null, app: AppRecord, user: { id: string; name: string }, signal?: AbortSignal) {
  return asAgent(db, app.id, user.id, 'Capability mapper', `Map what ${app.name} does from App Context`, async (step) => {
    const read = step("Read the application's documentation", 'context.passages');
    const passages = knowledgePassages(db, app.id);
    read('done', `${passages.length} passages from ${new Set(passages.map((p) => p.locator.split(' ¶')[0])).size} documents`);
    const components = app.components.map((c) => c.name);
    let proposed: Proposed[];
    let source: 'model' | 'rules';
    if (cfg && passages.length) {
      const think = step('Propose capabilities and checks', 'model');
      try {
        // A map is a long answer: the token budget is sized for a dozen capabilities with their checks.
        const raw = await completeJson(cfg, mapMessages(app.name, components, passages), signal, undefined, 6000);
        if (raw === null) throw new CapabilityError(502, 'The model gave no readable JSON for the map (its answer may have been cut short). Try again.');
        proposed = parseProposal(raw, components);
        source = 'model';
        think('done', `${proposed.length} capabilities, ${proposed.reduce((n, p) => n + p.checks.length, 0)} checks`);
      } catch (e) {
        think('failed', (e as Error).message);
        throw e;
      }
    } else {
      proposed = rulesProposal(app);
      source = 'rules';
    }
    const save = step('Merge into the capability map', 'db.capabilities');
    const merged = mergeProposal(db, app.id, proposed, user.id);
    save('done', `${merged.added} added, ${merged.updated} already known, ${merged.checksAdded} checks added`);
    return { summary: `${proposed.length} capabilities from ${source === 'model' ? 'App Context' : 'the components'}: ${merged.added} new, ${merged.updated} already known, ${merged.checksAdded} checks added`, ...merged, source, passages: passages.length };
  });
}

/* ---------- The map, with coverage ---------- */

const STOP = new Set(['the', 'and', 'with', 'that', 'this', 'from', 'when', 'then', 'into', 'returns', 'return', 'shows', 'show', 'still', 'test', 'tests', 'should', 'http', 'only', 'have', 'does', 'their', 'there', 'which', 'after', 'before', 'without', 'page', 'user', 'users']);
const words = (s: string) => new Set((s.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((x) => x.length > 3 && !STOP.has(x)));

interface PoolTest {
  id: string;
  title: string;
  suite: string | null;
  repo: string | null;
}

export function capabilityMap(db: HorizonDb, app: AppRecord): CapabilityMap {
  const caps = db.raw.prepare('SELECT c.*, u.name AS confirmed_name, b.name AS created_name FROM capabilities c LEFT JOIN users u ON u.id = c.confirmed_by LEFT JOIN users b ON b.id = c.created_by WHERE c.application_id = ? AND c.removed_at IS NULL ORDER BY c.position, c.created_at').all(app.id) as Row[];
  const checksOf = db.raw.prepare('SELECT id, text, origin FROM capability_checks WHERE capability_id = ? AND removed_at IS NULL ORDER BY position, created_at');
  const linkedOf = db.raw.prepare("SELECT t.id, t.title, t.repo FROM capability_check_tests l JOIN test_cases t ON t.id = l.test_case_id WHERE l.check_id = ? AND t.status = 'active' ORDER BY t.title");
  const inRun = db.raw.prepare('SELECT status FROM test_results WHERE run_id = ? AND test_case_id = ?');
  const builds = new Map<string, ReturnType<HorizonDb['targetBuild']>>();
  const buildFor = (repo: string | null) => {
    const key = repo ?? '';
    if (!builds.has(key)) builds.set(key, db.targetBuild(app.id, repo));
    return builds.get(key) ?? null;
  };
  const RANK: Record<string, number> = { failed: 3, passed: 2, skipped: 1 };
  const resultOf = (t: { id: string; repo: string | null }): string | null => {
    const b = buildFor(t.repo);
    if (!b) return null;
    let best: string | null = null;
    for (const runId of b.runIds) {
      const r = inRun.get(runId, t.id) as { status: string } | undefined;
      if (r && (!best || (RANK[r.status] ?? 0) > (RANK[best] ?? 0))) best = r.status;
    }
    return best;
  };
  const pools = new Map<string, PoolTest[]>();
  const poolFor = (component: string | null): PoolTest[] => {
    if (!component) return [];
    if (!pools.has(component)) {
      const w = db.componentTestsWhere(app.id, component);
      const rows = w ? (db.raw.prepare(`SELECT t.id, t.title, t.suite, t.repo FROM test_cases t WHERE t.application_id = ? AND t.status = 'active' AND t.kind = 'automated' AND (${w.sql})`).all(app.id, ...w.args) as Row[]) : [];
      pools.set(
        component,
        rows.map((r) => ({ id: String(r.id), title: String(r.title), suite: (r.suite as string) ?? null, repo: (r.repo as string) ?? null })),
      );
    }
    return pools.get(component)!;
  };
  const totals: CapabilityMap['totals'] = { covered: 0, failing: 0, 'not-run': 0, none: 0, checks: 0 };
  let mappedAt: string | null = null;
  let mappedBy: string | null = null;
  const capabilities: Capability[] = caps.map((c) => {
    const component = (c.component as string) ?? null;
    const pool = poolFor(component);
    const counts: Record<CheckStatus, number> = { covered: 0, failing: 0, 'not-run': 0, none: 0 };
    const checks: CapabilityCheck[] = (checksOf.all(c.id) as Row[]).map((k) => {
      const linked: CheckTest[] = (linkedOf.all(k.id) as Row[]).map((t) => ({ id: String(t.id), title: String(t.title), result: resultOf({ id: String(t.id), repo: (t.repo as string) ?? null }) }));
      const status: CheckStatus = linked.some((t) => t.result === 'passed') ? 'covered' : linked.some((t) => t.result === 'failed') ? 'failing' : linked.length ? 'not-run' : 'none';
      const cw = words(String(k.text));
      const taken = new Set(linked.map((t) => t.id));
      const suggestions: CheckTest[] = pool
        .filter((t) => !taken.has(t.id))
        .map((t) => {
          const shared = [...words(`${t.title} ${(t.suite ?? '').split(/[./]/).pop() ?? ''}`)].filter((x) => cw.has(x));
          return { t, score: shared.length, shared };
        })
        .filter((x) => x.score >= 3)
        .sort((a, b) => b.score - a.score || a.t.title.localeCompare(b.t.title))
        .slice(0, 3)
        .map((x) => ({ id: x.t.id, title: x.t.title, result: resultOf(x.t), why: `shares ${x.shared.slice(0, 4).join(', ')}` }));
      counts[status]++;
      totals[status]++;
      totals.checks++;
      return { id: String(k.id), text: String(k.text), origin: k.origin as 'agent' | 'person', status, tests: linked, suggestions };
    });
    if (c.origin === 'agent' && (!mappedAt || String(c.updated_at) > mappedAt)) {
      mappedAt = String(c.updated_at);
      mappedBy = (c.created_name as string) ?? null;
    }
    return {
      id: String(c.id),
      name: String(c.name),
      summary: String(c.summary ?? ''),
      component,
      origin: c.origin as 'agent' | 'person',
      sources: safeJson<string[]>(c.sources, []),
      confirmedBy: (c.confirmed_name as string) ?? null,
      confirmedAt: (c.confirmed_at as string) ?? null,
      checks,
      counts,
    };
  });
  // The automation repository's target build: the one the capabilities' components live in.
  const repoName = app.components.find((c) => capabilities.some((x) => x.component === c.name))?.repo ?? null;
  const build = repoName ? buildFor(repoName) : null;
  return {
    capabilities,
    totals,
    mappedAt,
    mappedBy,
    confirmed: capabilities.length > 0 && capabilities.every((c) => !!c.confirmedAt),
    build: build ? { label: build.label, at: build.at } : null,
  };
}

function safeJson<T>(v: unknown, fallback: T): T {
  try {
    return typeof v === 'string' ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
}

/* ---------- People edit the map ---------- */

function requireCapability(db: HorizonDb, app: string, id: string) {
  const r = db.raw.prepare('SELECT id, position FROM capabilities WHERE id = ? AND application_id = ? AND removed_at IS NULL').get(id, app) as Row | undefined;
  if (!r) throw new CapabilityError(404, 'This capability does not exist in this application.');
  return r;
}

export function addCapability(db: HorizonDb, app: AppRecord, user: { id: string }, input: { name?: unknown; summary?: unknown; component?: unknown; checks?: unknown }) {
  const name = clean(input.name, 60);
  if (!name) throw new CapabilityError(400, 'Give the capability a name.');
  const component = typeof input.component === 'string' && app.components.some((c) => c.name === input.component) ? input.component : null;
  const checks = Array.isArray(input.checks) ? input.checks.map((c) => clean(c, 220)).filter(Boolean).slice(0, 20) : [];
  const at = now();
  const id = randomUUID();
  const position = ((db.raw.prepare('SELECT MAX(position) AS p FROM capabilities WHERE application_id = ?').get(app.id) as { p: number | null }).p ?? 0) + 1;
  db.raw.transaction(() => {
    db.raw
      .prepare('INSERT INTO capabilities (id, application_id, name, summary, component, position, origin, sources, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, app.id, name, clean(input.summary, 240), component, position, 'person', '[]', user.id, at, at);
    checks.forEach((text, i) => db.raw.prepare('INSERT INTO capability_checks (id, capability_id, text, position, origin, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(randomUUID(), id, text, i + 1, 'person', at));
  })();
  return id;
}

export function updateCapability(db: HorizonDb, app: AppRecord, id: string, input: { name?: unknown; summary?: unknown; component?: unknown; remove?: unknown }) {
  requireCapability(db, app.id, id);
  const at = now();
  if (input.remove === true) {
    db.raw.prepare('UPDATE capabilities SET removed_at = ?, updated_at = ? WHERE id = ?').run(at, at, id);
    return;
  }
  if (input.name !== undefined) {
    const name = clean(input.name, 60);
    if (!name) throw new CapabilityError(400, 'A capability needs a name.');
    db.raw.prepare('UPDATE capabilities SET name = ?, updated_at = ? WHERE id = ?').run(name, at, id);
  }
  if (input.summary !== undefined) db.raw.prepare('UPDATE capabilities SET summary = ?, updated_at = ? WHERE id = ?').run(clean(input.summary, 240), at, id);
  if (input.component !== undefined) {
    const component = typeof input.component === 'string' && app.components.some((c) => c.name === input.component) ? input.component : null;
    db.raw.prepare('UPDATE capabilities SET component = ?, updated_at = ? WHERE id = ?').run(component, at, id);
  }
}

export function addCheck(db: HorizonDb, app: AppRecord, id: string, text: unknown) {
  requireCapability(db, app.id, id);
  const t = clean(text, 220);
  if (t.length < 8) throw new CapabilityError(400, 'Say what a test should verify, in one sentence.');
  const position = ((db.raw.prepare('SELECT MAX(position) AS p FROM capability_checks WHERE capability_id = ?').get(id) as { p: number | null }).p ?? 0) + 1;
  const checkId = randomUUID();
  db.raw.prepare('INSERT INTO capability_checks (id, capability_id, text, position, origin, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(checkId, id, t, position, 'person', now());
  db.raw.prepare('UPDATE capabilities SET updated_at = ? WHERE id = ?').run(now(), id);
  return checkId;
}

export function removeCheck(db: HorizonDb, app: AppRecord, checkId: string) {
  const r = db.raw.prepare('SELECT k.id FROM capability_checks k JOIN capabilities c ON c.id = k.capability_id WHERE k.id = ? AND c.application_id = ? AND k.removed_at IS NULL').get(checkId, app.id) as Row | undefined;
  if (!r) throw new CapabilityError(404, 'This check does not exist in this application.');
  db.raw.prepare('UPDATE capability_checks SET removed_at = ? WHERE id = ?').run(now(), checkId);
}

/** Every capability now on the map is confirmed by this person; the agent's later additions arrive unconfirmed. */
export function confirmMap(db: HorizonDb, app: AppRecord, user: { id: string }) {
  const at = now();
  return db.raw.prepare('UPDATE capabilities SET confirmed_by = ?, confirmed_at = ?, updated_at = ? WHERE application_id = ? AND removed_at IS NULL AND confirmed_at IS NULL').run(user.id, at, at, app.id).changes;
}

/** A person links an automated test to a check (or unlinks it): from then on the test's result is the check's evidence. */
export function linkCheck(db: HorizonDb, app: AppRecord, user: { id: string }, checkId: string, testId: unknown, remove: boolean) {
  const r = db.raw.prepare('SELECT k.id FROM capability_checks k JOIN capabilities c ON c.id = k.capability_id WHERE k.id = ? AND c.application_id = ? AND k.removed_at IS NULL').get(checkId, app.id) as Row | undefined;
  if (!r) throw new CapabilityError(404, 'This check does not exist in this application.');
  const tid = clean(testId, 64);
  const t = db.raw.prepare("SELECT id, kind FROM test_cases WHERE id = ? AND application_id = ? AND status = 'active'").get(tid, app.id) as Row | undefined;
  if (!t) throw new CapabilityError(404, 'This test does not exist in this application.');
  if (t.kind !== 'automated') throw new CapabilityError(400, 'Only an automated test can be the evidence for a regression check.');
  if (remove) db.raw.prepare('DELETE FROM capability_check_tests WHERE check_id = ? AND test_case_id = ?').run(checkId, tid);
  else db.raw.prepare('INSERT OR IGNORE INTO capability_check_tests (check_id, test_case_id, linked_by, linked_at) VALUES (?, ?, ?, ?)').run(checkId, tid, user.id, now());
}
