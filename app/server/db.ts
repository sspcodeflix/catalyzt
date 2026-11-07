/**
 * Horizon's database (SQLite). Opens, migrates and seeds it, and exposes small repositories.
 * The schema is in schema.ts and the design in DATA_MODEL.md. Server only.
 */
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import type { Ticket } from '../src/lib/types';
import { COVERAGE } from '../src/lib/uat';
import { MIGRATIONS } from './schema';

export const STATUSES = ['To Do', 'In Progress', 'Ready for UAT', 'Done'] as const;
export type StoryStatus = (typeof STATUSES)[number];
export const STORY_TYPES = ['Story', 'Bug', 'Task'] as const;

export const DEFAULT_APP = 'App-abcd';
export const DEFAULT_USER = 'u-priya';

export interface JiraFilter {
  project: string;
  statuses: StoryStatus[];
  everyMinutes: number;
  lastSyncAt: string;
}

/** A story as stored. `original` keeps what the author first wrote. */
export interface StoredStory extends Omit<Ticket, 'uat'> {
  source: 'jira_sync' | 'horizon';
  createdBy: string;
  createdAt: string;
  original: { summary: string; description: string; acceptanceCriteria: string } | null;
  refinementId: number | null;
}

export interface RefinementOutput {
  summary: string;
  description: string;
  acceptanceCriteria: string[];
  questions: string[];
}

export interface NewStory {
  summary: string;
  description: string;
  type: StoredStory['type'];
  status: StoryStatus;
  fixVersion: string;
  components: string[];
  acceptanceCriteria: string[];
  original: StoredStory['original'];
  refinementId: number | null;
  createdBy: string;
}

export type AgentKind = 'orchestrator' | 'guard' | 'router' | 'specialist' | 'tool_agent' | 'refiner';
export type RunStatus = 'running' | 'done' | 'failed' | 'rejected' | 'stopped';

export interface AgentActivity {
  id: string;
  workflowRunId: string;
  parentId: string | null;
  parentAgent: string | null;
  agent: string;
  kind: AgentKind;
  task: string;
  status: RunStatus;
  model: string | null;
  result: string | null;
  error: string | null;
  tokens: number | null;
  startedAt: string;
  endedAt: string | null;
  requestedBy: { id: string; name: string; initials: string };
  chat: { id: string; title: string } | null;
  steps: { seq: number; kind: string; label: string; detail: string | null; status: string }[];
}

type Row = Record<string, unknown>;
const now = () => new Date().toISOString();
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
const json = <T>(v: unknown, fallback: T): T => {
  try {
    return typeof v === 'string' ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
};

/* ---------- Seed data (placeholders, as in the mock-ups) ---------- */

const SEED_USERS = [
  { id: 'u-priya', name: 'Priya N.', initials: 'PN', email: 'priya.n@example.com', roles: ['member', 'app_owner'] },
  { id: 'u-omar', name: 'Omar K.', initials: 'OK', email: 'omar.k@example.com', roles: ['member'] },
  { id: 'u-sara', name: 'Sara R.', initials: 'SR', email: 'sara.r@example.com', roles: ['member', 'security_champion'] },
  { id: 'u-jun', name: 'Jun T.', initials: 'JT', email: 'jun.t@example.com', roles: ['member'] },
];

const SEED_STORIES: (Omit<StoredStory, 'createdAt' | 'createdBy' | 'original' | 'refinementId' | 'source'> & { ago: number })[] = [
  { key: 'PAY-1482', summary: 'Partial refunds for card payments', type: 'Story', status: 'Ready for UAT', fixVersion: '24.11', components: ['refund-service', 'merchant-portal-ui'], assignee: 'Omar K.', ago: 35, updated: '', description: 'Merchants can refund part of a settled card payment from the portal, up to the original amount.', acceptanceCriteria: ['A merchant can refund part of a settled card payment', 'A refund above the original amount is rejected with a clear message', 'A card refund needs a reason', 'Partial refunds are allowed for 45 days from settlement'], requirements: ['FR-0231', 'FR-0233'] },
  { key: 'PAY-1490', summary: 'Show refund status on the payment timeline', type: 'Story', status: 'Ready for UAT', fixVersion: '24.11', components: ['merchant-portal-ui'], assignee: 'Sara R.', ago: 80, updated: '', description: 'Each refund appears on the payment timeline with its status and amount.', acceptanceCriteria: ['Refunds appear on the timeline in date order', 'Each refund shows amount and status', 'Failed refunds show the reason'], requirements: ['FR-0240'] },
  { key: 'PAY-1495', summary: 'Refund webhooks for merchants', type: 'Story', status: 'Ready for UAT', fixVersion: '24.11', components: ['payments-api'], assignee: 'Jun T.', ago: 130, updated: '', description: 'Send a webhook when a refund succeeds or fails.', acceptanceCriteria: ['A webhook is sent when a refund succeeds', 'A webhook is sent when a refund fails', 'Webhooks retry 3 times with backoff', 'Payloads are signed'], requirements: ['FR-0244', 'NFR-0012'] },
  { key: 'PAY-1501', summary: 'Refund limit per merchant per day', type: 'Story', status: 'Ready for UAT', fixVersion: '24.12', components: ['refund-service'], assignee: 'Omar K.', ago: 200, updated: '', description: 'Cap the total refunded per merchant per day, configurable by risk.', acceptanceCriteria: ['Refunds over the daily limit are rejected', 'Risk can change the limit per merchant'], requirements: ['FR-0250'] },
  { key: 'PAY-1503', summary: 'Refund button disabled after settlement window', type: 'Bug', status: 'Ready for UAT', fixVersion: '24.11', components: ['merchant-portal-ui'], assignee: 'Sara R.', ago: 260, updated: '', description: 'The refund button stays enabled after the 45-day window and the API then rejects the request.', acceptanceCriteria: ['The refund button is disabled after 45 days, with a tooltip'], requirements: ['FR-0231'] },
  { key: 'PAY-1507', summary: 'Export refunds to CSV', type: 'Story', status: 'Ready for UAT', fixVersion: '24.12', components: ['merchant-portal-ui', 'payments-api'], assignee: 'Priya N.', ago: 400, updated: '', description: 'Merchants can export refunds for a date range.', acceptanceCriteria: ['Export covers the chosen date range', 'Amounts use the merchant currency', 'Exports over 50,000 rows are emailed'], requirements: ['FR-0252'] },
  { key: 'PAY-1511', summary: 'Refund reason codes from a fixed list', type: 'Story', status: 'In Progress', fixVersion: '24.12', components: ['refund-service', 'merchant-portal-ui'], assignee: 'Jun T.', ago: 20, updated: '', description: 'Replace the free-text refund reason with codes agreed with Risk.', acceptanceCriteria: ['The reason is chosen from the agreed list', 'Old free-text reasons still display'], requirements: ['FR-0255'] },
];

const SEED_COMPONENTS = [
  { name: 'refund-service', repo: 'payments/pay-hub-api' },
  { name: 'payments-api', repo: 'payments/pay-hub-api' },
  { name: 'merchant-portal-ui', repo: 'payments/pay-hub-web' },
  { name: 'card-gateway', repo: 'payments/pay-hub-api' },
];

/**
 * Runs pending migrations. Foreign keys are switched off while a migration runs, so a table can
 * be rebuilt (SQLite cannot alter a CHECK constraint) without cascading deletes, and checked after.
 */
function migrate(db: Database.Database) {
  const version = db.pragma('user_version', { simple: true }) as number;
  if (version >= MIGRATIONS.length) return;
  db.pragma('foreign_keys = OFF');
  try {
    for (let v = version; v < MIGRATIONS.length; v++) {
      db.transaction(() => {
        db.exec(MIGRATIONS[v]);
        const broken = db.pragma('foreign_key_check') as unknown[];
        if (broken.length) throw new Error(`Migration ${v + 1} broke ${broken.length} foreign keys`);
        db.pragma(`user_version = ${v + 1}`);
      })();
    }
  } finally {
    db.pragma('foreign_keys = ON');
  }
}

function seed(db: Database.Database) {
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number };
  if (n > 0) return;
  const t = now();
  db.transaction(() => {
    db.prepare('INSERT INTO applications (id, name, jira_project) VALUES (?, ?, ?)').run(DEFAULT_APP, 'Payments Hub', 'PAY');
    for (const w of ['web-ui', 'api', 'batch']) db.prepare('INSERT INTO workspaces (id, application_id, name) VALUES (?, ?, ?)').run(`${DEFAULT_APP}-${w}`, DEFAULT_APP, w);
    for (const u of SEED_USERS) {
      db.prepare('INSERT INTO users (id, name, initials, email, created_at) VALUES (?, ?, ?, ?, ?)').run(u.id, u.name, u.initials, u.email, t);
      for (const r of u.roles) db.prepare('INSERT INTO memberships (user_id, application_id, role) VALUES (?, ?, ?)').run(u.id, DEFAULT_APP, r);
    }
    for (const c of SEED_COMPONENTS) db.prepare('INSERT INTO components (id, application_id, name, repo) VALUES (?, ?, ?, ?)').run(c.name, DEFAULT_APP, c.name, c.repo);
    const reqs = new Set(SEED_STORIES.flatMap((s) => s.requirements));
    for (const r of reqs) db.prepare('INSERT INTO requirements (id, application_id) VALUES (?, ?)').run(r, DEFAULT_APP);
    for (const s of SEED_STORIES) {
      const [project, num] = s.key.split('-');
      const at = minutesAgo(s.ago);
      db.prepare(
        `INSERT INTO stories (key, application_id, project, number, summary, description, type, status, fix_version, assignee, source, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'jira_sync', ?, ?, ?)`,
      ).run(s.key, DEFAULT_APP, project, Number(num), s.summary, s.description, s.type, s.status, s.fixVersion, s.assignee, DEFAULT_USER, at, at);
      insertChildren(db, s.key, s.acceptanceCriteria, s.components, s.requirements);
    }
    db.prepare('INSERT INTO jira_sync (application_id, project, statuses, every_minutes, last_sync_at) VALUES (?, ?, ?, ?, ?)').run(
      DEFAULT_APP,
      'PAY',
      JSON.stringify(['Ready for UAT']),
      15,
      minutesAgo(4),
    );
  })();
}

function insertChildren(db: Database.Database, key: string, criteria: string[], components: string[], requirements: string[]) {
  const ac = db.prepare('INSERT INTO story_criteria (story_key, seq, text) VALUES (?, ?, ?)');
  criteria.forEach((c, i) => ac.run(key, i + 1, c));
  const sc = db.prepare('INSERT OR IGNORE INTO story_components (story_key, component_id) VALUES (?, ?)');
  for (const c of components) sc.run(key, c);
  const sr = db.prepare('INSERT OR IGNORE INTO story_requirements (story_key, requirement_id) VALUES (?, ?)');
  for (const r of requirements) sr.run(key, r);
}

/**
 * Seeds Hexa with the payment tests the UAT data refers to: a test for each criterion that is
 * covered or has a test not yet run. Runs once, on a database with no test cases yet.
 */
function seedTests(db: Database.Database) {
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM test_cases').get() as { n: number };
  if (n > 0) return;
  const t = now();
  const ins = db.prepare(
    `INSERT INTO test_cases (id, application_id, title, suite, code_name, kind, purpose, framework, origin, repo, path, line, last_result, last_run_at, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'automated', 'regression', 'JUnit', 'repo_scan', 'payments/pay-hub-automation', ?, ?, ?, ?, ?, ?, ?)`,
  );
  const link = db.prepare('INSERT OR IGNORE INTO test_case_links (test_case_id, entity_type, entity_ref) VALUES (?, ?, ?)');
  db.transaction(() => {
    for (const s of SEED_STORIES) {
      const cov = COVERAGE[s.key] ?? [];
      const suite = s.summary.replace(/[^A-Za-z ]/g, '').split(' ').filter(Boolean).slice(0, 3).map((w) => w[0].toUpperCase() + w.slice(1)).join('') + 'Test';
      s.acceptanceCriteria.forEach((c, i) => {
        if (cov[i] !== 'passing' && cov[i] !== 'not-run') return;
        const id = `TC-${s.key.split('-')[1]}-${i + 1}`;
        const words = c.replace(/[^A-Za-z0-9 ]/g, '').split(' ').filter(Boolean);
        const codeName = words.map((w, k) => (k === 0 ? w.toLowerCase() : w[0].toUpperCase() + w.slice(1).toLowerCase())).join('');
        ins.run(id, DEFAULT_APP, c, suite, codeName, `src/test/java/payments/${suite}.java`, 20 + i * 12, cov[i] === 'passing' ? 'passed' : 'not_run', cov[i] === 'passing' ? minutesAgo(600) : null, DEFAULT_USER, t, t);
        link.run(id, 'story', s.key);
        link.run(id, 'criterion', `${s.key}#AC${i + 1}`);
        for (const r of s.requirements) link.run(id, 'requirement', r);
        for (const c2 of s.components) link.run(id, 'component', c2);
      });
    }
  })();
}

export interface TestCaseRow {
  id: string;
  title: string;
  suite: string | null;
  kind: 'automated' | 'manual' | 'proposed';
  framework: string | null;
  origin: 'repo_scan' | 'uat_analyst' | 'authoring' | 'manual';
  repo: string | null;
  path: string | null;
  line: number | null;
  url: string | null;
  lastResult: 'passed' | 'failed' | 'skipped' | 'not_run' | null;
  lastRunAt: string | null;
  purpose: 'uat' | 'regression' | null;
  externalId: string | null;
  phase: string | null;
  owner: string | null;
  steps: number;
  updatedAt: string;
  links: { type: string; ref: string }[];
}

export interface RunMeta {
  source: 'github_actions' | 'webhook' | 'upload';
  repo: string | null;
  workflow: string | null;
  externalRunId: string | null;
  runUrl: string | null;
  event: string | null;
  branch: string | null;
  sha: string | null;
  prNumber: number | null;
  isMerge: boolean;
  startedAt: string | null;
}

export interface ScanRow {
  id: string;
  repo: string;
  ref: string | null;
  status: 'running' | 'done' | 'failed';
  filesFound: number | null;
  filesScanned: number | null;
  testsFound: number | null;
  testsNew: number | null;
  testsRemoved: number | null;
  truncated: boolean;
  error: string | null;
  startedBy: string;
  startedAt: string;
  endedAt: string | null;
}

export type HorizonDb = ReturnType<typeof openDb>;

/** Opens the database, migrating and seeding as needed. Use ':memory:' in tests. */
export function openDb(path: string) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  seed(db);
  seedTests(db);

  const q = {
    criteria: db.prepare('SELECT text FROM story_criteria WHERE story_key = ? ORDER BY seq'),
    components: db.prepare('SELECT component_id AS c FROM story_components WHERE story_key = ? ORDER BY component_id'),
    requirements: db.prepare('SELECT requirement_id AS r FROM story_requirements WHERE story_key = ? ORDER BY requirement_id'),
    story: db.prepare('SELECT * FROM stories WHERE key = ?'),
    user: db.prepare('SELECT id, name, initials FROM users WHERE id = ?'),
  };

  function toStory(r: Row): StoredStory {
    const key = String(r.key);
    return {
      key,
      summary: String(r.summary),
      description: String(r.description),
      type: r.type as StoredStory['type'],
      status: String(r.status),
      fixVersion: String(r.fix_version),
      assignee: String(r.assignee),
      updated: String(r.updated_at),
      acceptanceCriteria: (q.criteria.all(key) as { text: string }[]).map((x) => x.text),
      components: (q.components.all(key) as { c: string }[]).map((x) => x.c),
      requirements: (q.requirements.all(key) as { r: string }[]).map((x) => x.r),
      source: r.source as StoredStory['source'],
      createdBy: String(r.created_by),
      createdAt: String(r.created_at),
      original: json(r.original, null),
      refinementId: r.refinement_id == null ? null : Number(r.refinement_id),
    };
  }

  function getStory(key: string) {
    const r = q.story.get(key) as Row | undefined;
    return r ? toStory(r) : undefined;
  }

  function getFilter(app = DEFAULT_APP): JiraFilter {
    const r = db.prepare('SELECT * FROM jira_sync WHERE application_id = ?').get(app) as Row;
    return { project: String(r.project), statuses: json(r.statuses, []), everyMinutes: Number(r.every_minutes), lastSyncAt: String(r.last_sync_at) };
  }

  function audit(actorType: 'user' | 'agent' | 'system', actorRef: string, action: string, entityType: string, entityRef: string, detail: object = {}) {
    db.prepare('INSERT INTO audit_log (at, actor_type, actor_ref, action, entity_type, entity_ref, detail) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      now(),
      actorType,
      actorRef,
      action,
      entityType,
      entityRef,
      JSON.stringify(detail),
    );
  }

  return {
    raw: db,
    audit,

    /* ---------- People ---------- */
    getUser(id: string) {
      return q.user.get(id) as { id: string; name: string; initials: string } | undefined;
    },

    /* ---------- Jira ---------- */
    getFilter,
    setFilter(f: { statuses: StoryStatus[]; everyMinutes: number }, by: string, app = DEFAULT_APP) {
      db.prepare('UPDATE jira_sync SET statuses = ?, every_minutes = ?, updated_by = ? WHERE application_id = ?').run(JSON.stringify(f.statuses), f.everyMinutes, by, app);
      audit('user', by, 'jira_filter.update', 'application', app, f);
      return getFilter(app);
    },
    /** In production this pulls from Jira; the dummy Jira is this database, so a sync only records the time. */
    markSynced(app = DEFAULT_APP) {
      db.prepare('UPDATE jira_sync SET last_sync_at = ? WHERE application_id = ?').run(now(), app);
      return getFilter(app);
    },
    listStories(filter: JiraFilter = getFilter()): StoredStory[] {
      if (filter.statuses.length === 0) return [];
      const marks = filter.statuses.map(() => '?').join(', ');
      return (db.prepare(`SELECT * FROM stories WHERE project = ? AND status IN (${marks}) ORDER BY updated_at DESC`).all(filter.project, ...filter.statuses) as Row[]).map(toStory);
    },
    getStory,
    createStory(s: NewStory, app = DEFAULT_APP): StoredStory {
      const { project } = getFilter(app);
      const key = db.transaction(() => {
        const { n } = db.prepare('SELECT COALESCE(MAX(number), 1500) + 1 AS n FROM stories WHERE project = ?').get(project) as { n: number };
        const k = `${project}-${n}`;
        const t = now();
        const user = q.user.get(s.createdBy) as { name: string } | undefined;
        db.prepare(
          `INSERT INTO stories (key, application_id, project, number, summary, description, type, status, fix_version, assignee, original, refinement_id, source, created_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'horizon', ?, ?, ?)`,
        ).run(k, app, project, n, s.summary, s.description, s.type, s.status, s.fixVersion, user?.name ?? '', s.original ? JSON.stringify(s.original) : null, s.refinementId, s.createdBy, t, t);
        insertChildren(db, k, s.acceptanceCriteria, s.components, []);
        if (s.refinementId) db.prepare('UPDATE refinements SET story_key = ? WHERE id = ?').run(k, s.refinementId);
        audit('user', s.createdBy, 'story.create', 'story', k, { refined: !!s.refinementId });
        return k;
      })();
      return getStory(key)!;
    },
    saveRefinement(r: { input: object; output: RefinementOutput; source: 'model' | 'rules'; model: string | null; agentRunId: string | null; createdBy: string }) {
      const info = db
        .prepare('INSERT INTO refinements (input, output, source, model, agent_run_id, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(JSON.stringify(r.input), JSON.stringify(r.output), r.source, r.model, r.agentRunId, r.createdBy, now());
      return Number(info.lastInsertRowid);
    },
    getRefinement(id: number) {
      const r = db.prepare('SELECT * FROM refinements WHERE id = ?').get(id) as Row | undefined;
      return r ? { id, storyKey: (r.story_key as string) ?? null, output: json<RefinementOutput | null>(r.output, null), source: String(r.source) } : undefined;
    },

    /* ---------- Chats (recorded with each request so agent runs link to them) ---------- */
    upsertChat(c: { id: string; title: string; agent: string; workspace: string; userId: string }, app = DEFAULT_APP) {
      const t = now();
      const ws = db.prepare('SELECT id FROM workspaces WHERE application_id = ? AND name = ?').get(app, c.workspace) as { id: string } | undefined;
      db.prepare(
        `INSERT INTO chats (id, application_id, workspace_id, title, agent, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET agent = excluded.agent, updated_at = excluded.updated_at`,
      ).run(c.id, app, ws?.id ?? null, c.title.slice(0, 200), c.agent, c.userId, t, t);
    },
    addUserMessage(m: { id: string; chatId: string; text: string; testType: string | null; testTypeSource: string | null; userId: string; items: { type: string; ref: string }[] }) {
      const exists = db.prepare('SELECT 1 FROM messages WHERE id = ?').get(m.id);
      if (exists) return;
      const { seq } = db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM messages WHERE chat_id = ?').get(m.chatId) as { seq: number };
      db.prepare('INSERT INTO messages (id, chat_id, seq, role, text, test_type, test_type_source, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
        m.id,
        m.chatId,
        seq,
        'user',
        m.text,
        m.testType,
        m.testTypeSource,
        m.userId,
        now(),
      );
      const it = db.prepare('INSERT OR IGNORE INTO message_items (message_id, item_type, item_ref) VALUES (?, ?, ?)');
      for (const i of m.items) it.run(m.id, i.type, i.ref);
    },
    /** A guard removed the message: keep the row, drop the text. */
    removeMessageText(id: string, reason: string) {
      db.prepare("UPDATE messages SET text = '', removed_reason = ? WHERE id = ?").run(reason, id);
    },

    /* ---------- Workflow, agents, steps, guards ---------- */
    startWorkflow(w: { id: string; chatId: string | null; messageId: string | null; revision: number; userId: string }) {
      db.prepare("INSERT INTO workflow_runs (id, chat_id, message_id, revision, requested_by, status, started_at) VALUES (?, ?, ?, ?, ?, 'running', ?)").run(
        w.id,
        w.chatId,
        w.messageId,
        w.revision,
        w.userId,
        now(),
      );
    },
    finishWorkflow(id: string, status: RunStatus, summary: string) {
      db.prepare('UPDATE workflow_runs SET status = ?, summary = ?, ended_at = ? WHERE id = ?').run(status, summary, now(), id);
    },
    startAgent(a: { id: string; workflowRunId: string; parentId: string | null; agent: string; kind: AgentKind; task: string; model: string | null }) {
      db.prepare("INSERT INTO agent_runs (id, workflow_run_id, parent_id, agent, kind, task, status, model, started_at) VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?)").run(
        a.id,
        a.workflowRunId,
        a.parentId,
        a.agent,
        a.kind,
        a.task,
        a.model,
        now(),
      );
    },
    finishAgent(id: string, f: { status: RunStatus; result?: string; error?: string; model?: string | null; promptTokens?: number; completionTokens?: number }) {
      db.prepare(
        'UPDATE agent_runs SET status = ?, result = ?, error = ?, model = COALESCE(?, model), prompt_tokens = ?, completion_tokens = ?, ended_at = ? WHERE id = ?',
      ).run(f.status, f.result ?? null, f.error ?? null, f.model ?? null, f.promptTokens ?? null, f.completionTokens ?? null, now(), id);
    },
    addStep(s: { id: string; agentRunId: string; kind: 'rule' | 'model' | 'tool'; tool?: string; label: string }) {
      const { seq } = db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM agent_steps WHERE agent_run_id = ?').get(s.agentRunId) as { seq: number };
      db.prepare("INSERT INTO agent_steps (id, agent_run_id, seq, kind, tool, label, status, started_at) VALUES (?, ?, ?, ?, ?, ?, 'running', ?)").run(
        s.id,
        s.agentRunId,
        seq,
        s.kind,
        s.tool ?? null,
        s.label,
        now(),
      );
    },
    finishStep(id: string, f: { status: 'done' | 'failed'; label?: string; detail?: string }) {
      db.prepare('UPDATE agent_steps SET status = ?, label = COALESCE(?, label), detail = ?, ended_at = ? WHERE id = ?').run(f.status, f.label ?? null, f.detail ?? null, now(), id);
    },
    guardEvent(g: { workflowRunId: string | null; agentRunId: string | null; layer: 'input' | 'router' | 'output' | 'story'; policy: string; userId: string }) {
      db.prepare('INSERT INTO guard_events (workflow_run_id, agent_run_id, layer, policy, user_id, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
        g.workflowRunId,
        g.agentRunId,
        g.layer,
        g.policy,
        g.userId,
        now(),
      );
      audit('agent', g.layer === 'story' ? 'Story guard' : `${g.layer} guard`, 'guard.reject', 'policy', g.policy, {});
    },
    /** Token ledger: one row per model call. */
    recordModelCall(c: {
      workflowRunId: string | null;
      agentRunId: string | null;
      agent: string;
      userId: string;
      model: string;
      purpose: 'intent' | 'answer' | 'refine';
      status: 'ok' | 'error' | 'stopped';
      promptTokens: number | null;
      completionTokens: number | null;
      latencyMs: number;
    }) {
      db.prepare(
        `INSERT INTO model_calls (workflow_run_id, agent_run_id, agent, user_id, model, purpose, status, prompt_tokens, completion_tokens, latency_ms, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(c.workflowRunId, c.agentRunId, c.agent, c.userId, c.model, c.purpose, c.status, c.promptTokens, c.completionTokens, Math.round(c.latencyMs), now());
    },

    /** Token totals: all time, today, and broken down by agent, model, user and day. */
    usage() {
      const sum = `COUNT(*) AS calls, COALESCE(SUM(prompt_tokens), 0) AS prompt, COALESCE(SUM(completion_tokens), 0) AS completion,
                   COALESCE(SUM(prompt_tokens), 0) + COALESCE(SUM(completion_tokens), 0) AS total,
                   SUM(CASE WHEN prompt_tokens IS NULL THEN 1 ELSE 0 END) AS unreported`;
      const startOfDay = new Date();
      startOfDay.setHours(0, 0, 0, 0);
      type Tot = { calls: number; prompt: number; completion: number; total: number; unreported: number };
      return {
        allTime: db.prepare(`SELECT ${sum} FROM model_calls`).get() as Tot,
        today: db.prepare(`SELECT ${sum} FROM model_calls WHERE created_at >= ?`).get(startOfDay.toISOString()) as Tot,
        byAgent: db.prepare(`SELECT agent AS key, ${sum} FROM model_calls GROUP BY agent ORDER BY total DESC`).all() as (Tot & { key: string })[],
        byModel: db.prepare(`SELECT model AS key, ${sum} FROM model_calls GROUP BY model ORDER BY total DESC`).all() as (Tot & { key: string })[],
        byUser: db
          .prepare(`SELECT COALESCE(u.name, 'Unknown') AS key, ${sum.replace(/prompt_tokens/g, 'm.prompt_tokens').replace(/completion_tokens/g, 'm.completion_tokens')} FROM model_calls m LEFT JOIN users u ON u.id = m.user_id GROUP BY u.id ORDER BY total DESC`)
          .all() as (Tot & { key: string })[],
        byDay: db.prepare(`SELECT substr(created_at, 1, 10) AS key, ${sum} FROM model_calls GROUP BY key ORDER BY key DESC LIMIT 14`).all() as (Tot & { key: string })[],
      };
    },

    /* ---------- Hexa: test case inventory ---------- */

    listTests(f: { q?: string; kind?: string; kinds?: string[]; purpose?: string; result?: string; origin?: string; framework?: string; repo?: string; limit?: number; offset?: number } = {}) {
      const where = ["t.status = 'active'"];
      const args: unknown[] = [];
      if (f.kind) (where.push('t.kind = ?'), args.push(f.kind));
      if (f.kinds?.length) (where.push(`t.kind IN (${f.kinds.map(() => '?').join(', ')})`), args.push(...f.kinds));
      if (f.purpose) (where.push('t.purpose = ?'), args.push(f.purpose));
      if (f.result === 'none') where.push('t.last_result IS NULL');
      else if (f.result) (where.push('t.last_result = ?'), args.push(f.result));
      if (f.origin) (where.push('t.origin = ?'), args.push(f.origin));
      if (f.framework) (where.push('t.framework = ?'), args.push(f.framework));
      if (f.repo) (where.push('t.repo = ?'), args.push(f.repo));
      if (f.q) {
        const like = `%${f.q.replace(/[%_]/g, (m) => `\\${m}`)}%`;
        where.push(
          `(t.title LIKE ? ESCAPE '\\' OR t.suite LIKE ? ESCAPE '\\' OR t.path LIKE ? ESCAPE '\\' OR t.id LIKE ? ESCAPE '\\' OR t.external_id LIKE ? ESCAPE '\\' OR t.code_name LIKE ? ESCAPE '\\'
            OR EXISTS (SELECT 1 FROM test_case_links l WHERE l.test_case_id = t.id AND l.entity_ref LIKE ? ESCAPE '\\')
            OR EXISTS (SELECT 1 FROM test_steps st WHERE st.test_case_id = t.id AND st.description LIKE ? ESCAPE '\\'))`,
        );
        args.push(like, like, like, like, like, like, like, like);
      }
      const w = where.join(' AND ');
      const total = (db.prepare(`SELECT COUNT(*) AS n FROM test_cases t WHERE ${w}`).get(...args) as { n: number }).n;
      const rows = db
        .prepare(`SELECT * FROM test_cases t WHERE ${w} ORDER BY t.updated_at DESC, t.repo, t.path, t.line LIMIT ? OFFSET ?`)
        .all(...args, Math.min(f.limit ?? 50, 200), f.offset ?? 0) as Row[];
      const links = db.prepare('SELECT entity_type AS type, entity_ref AS ref FROM test_case_links WHERE test_case_id = ? ORDER BY entity_type, entity_ref');
      const stepCount = db.prepare('SELECT COUNT(*) AS n FROM test_steps WHERE test_case_id = ?');
      const out: TestCaseRow[] = rows.map((r) => ({
        id: String(r.id),
        title: String(r.title),
        suite: (r.suite as string) ?? null,
        kind: r.kind as TestCaseRow['kind'],
        framework: (r.framework as string) ?? null,
        origin: r.origin as TestCaseRow['origin'],
        repo: (r.repo as string) ?? null,
        path: (r.path as string) ?? null,
        line: r.line == null ? null : Number(r.line),
        url: (r.url as string) ?? null,
        lastResult: (r.last_result as TestCaseRow['lastResult']) ?? null,
        lastRunAt: (r.last_run_at as string) ?? null,
        purpose: (r.purpose as TestCaseRow['purpose']) ?? null,
        externalId: (r.external_id as string) ?? null,
        phase: (r.phase as string) ?? null,
        owner: (r.owner as string) ?? null,
        steps: (stepCount.get(r.id) as { n: number }).n,
        updatedAt: String(r.updated_at),
        links: links.all(r.id) as { type: string; ref: string }[],
      }));
      return { rows: out, total };
    },

    testStats() {
      const one = (sql: string) => db.prepare(sql).all() as { key: string; n: number }[];
      return {
        total: (db.prepare("SELECT COUNT(*) AS n FROM test_cases WHERE status = 'active'").get() as { n: number }).n,
        byKind: one("SELECT kind AS key, COUNT(*) AS n FROM test_cases WHERE status = 'active' GROUP BY kind"),
        byOrigin: one("SELECT origin AS key, COUNT(*) AS n FROM test_cases WHERE status = 'active' GROUP BY origin"),
        byFramework: one("SELECT COALESCE(framework, 'Manual') AS key, COUNT(*) AS n FROM test_cases WHERE status = 'active' GROUP BY key ORDER BY n DESC"),
        byRepo: one("SELECT COALESCE(repo, 'No repository') AS key, COUNT(*) AS n FROM test_cases WHERE status = 'active' GROUP BY key ORDER BY n DESC"),
        byResult: one("SELECT COALESCE(last_result, 'none') AS key, COUNT(*) AS n FROM test_cases WHERE status = 'active' AND kind = 'automated' GROUP BY key"),
        byPurpose: one("SELECT COALESCE(purpose, 'none') AS key, COUNT(*) AS n FROM test_cases WHERE status = 'active' GROUP BY key"),
        runs: (db.prepare('SELECT COUNT(*) AS n FROM test_runs').get() as { n: number }).n,
        storiesWithoutTests: (db.prepare("SELECT COUNT(*) AS n FROM stories s WHERE NOT EXISTS (SELECT 1 FROM test_case_links l JOIN test_cases t ON t.id = l.test_case_id AND t.status = 'active' WHERE l.entity_type = 'story' AND l.entity_ref = s.key)").get() as { n: number }).n,
      };
    },

    startScan(s: { id: string; repo: string; ref: string | null; workflowRunId: string; userId: string }) {
      db.prepare("INSERT INTO repo_scans (id, application_id, repo, ref, status, workflow_run_id, started_by, started_at) VALUES (?, ?, ?, ?, 'running', ?, ?, ?)").run(
        s.id,
        DEFAULT_APP,
        s.repo,
        s.ref,
        s.workflowRunId,
        s.userId,
        now(),
      );
    },
    runningScan(repo: string) {
      return db.prepare("SELECT id FROM repo_scans WHERE repo = ? AND status = 'running'").get(repo) as { id: string } | undefined;
    },
    failScan(id: string, error: string) {
      db.prepare("UPDATE repo_scans SET status = 'failed', error = ?, ended_at = ? WHERE id = ?").run(error, now(), id);
    },

    /**
     * Replaces a repo's scanned tests with what this scan found: new tests are added, known ones
     * updated, and tests no longer in the repo marked removed (kept for history).
     */
    completeScan(s: { id: string; repo: string; ref: string; sha: string; htmlUrl: string; filesFound: number; filesScanned: number; truncated: boolean; tests: { path: string; title: string; name?: string; suite: string | null; framework: string; line: number }[]; userId: string }) {
      return db.transaction(() => {
        const t = now();
        const seen = new Set<string>();
        let added = 0;
        const exists = db.prepare('SELECT 1 FROM test_cases WHERE id = ?');
        const up = db.prepare(
          `INSERT INTO test_cases (id, application_id, title, suite, code_name, kind, framework, origin, repo, ref, path, line, url, status, scan_id, created_by, created_at, updated_at)
           VALUES (@id, @app, @title, @suite, @code, 'automated', @framework, 'repo_scan', @repo, @ref, @path, @line, @url, 'active', @scan, @user, @t, @t)
           ON CONFLICT(id) DO UPDATE SET title = excluded.title, suite = excluded.suite, code_name = excluded.code_name, framework = excluded.framework, ref = excluded.ref, line = excluded.line, url = excluded.url, status = 'active', scan_id = excluded.scan_id, updated_at = excluded.updated_at`,
        );
        for (const x of s.tests) {
          const id = testId(s.repo, x.path, x.suite, x.title);
          if (seen.has(id)) continue;
          seen.add(id);
          if (!exists.get(id)) added++;
          up.run({ id, app: DEFAULT_APP, title: x.title.slice(0, 300), suite: x.suite, code: x.name ?? null, framework: x.framework, repo: s.repo, ref: s.ref, path: x.path, line: x.line, url: `${s.htmlUrl}/blob/${s.sha}/${x.path}#L${x.line}`, scan: s.id, user: s.userId, t });
        }
        const old = db.prepare("SELECT id FROM test_cases WHERE repo = ? AND origin = 'repo_scan' AND status = 'active'").all(s.repo) as { id: string }[];
        const gone = old.filter((o) => !seen.has(o.id));
        const rm = db.prepare("UPDATE test_cases SET status = 'removed', updated_at = ? WHERE id = ?");
        for (const g of gone) rm.run(t, g.id);
        db.prepare(
          "UPDATE repo_scans SET status = 'done', sha = ?, ref = ?, files_found = ?, files_scanned = ?, tests_found = ?, tests_new = ?, tests_removed = ?, truncated = ?, ended_at = ? WHERE id = ?",
        ).run(s.sha, s.ref, s.filesFound, s.filesScanned, seen.size, added, gone.length, s.truncated ? 1 : 0, t, s.id);
        audit('user', s.userId, 'hexa.scan', 'repository', s.repo, { found: seen.size, added, removed: gone.length });
        return { found: seen.size, added, removed: gone.length };
      })();
    },

    listScans(limit = 10): ScanRow[] {
      return (db.prepare('SELECT s.*, u.name AS user_name FROM repo_scans s JOIN users u ON u.id = s.started_by ORDER BY s.started_at DESC, s.rowid DESC LIMIT ?').all(limit) as Row[]).map((r) => ({
        id: String(r.id),
        repo: String(r.repo),
        ref: (r.ref as string) ?? null,
        status: r.status as ScanRow['status'],
        filesFound: r.files_found == null ? null : Number(r.files_found),
        filesScanned: r.files_scanned == null ? null : Number(r.files_scanned),
        testsFound: r.tests_found == null ? null : Number(r.tests_found),
        testsNew: r.tests_new == null ? null : Number(r.tests_new),
        testsRemoved: r.tests_removed == null ? null : Number(r.tests_removed),
        truncated: Number(r.truncated) === 1,
        error: (r.error as string) ?? null,
        startedBy: String(r.user_name),
        startedAt: String(r.started_at),
        endedAt: (r.ended_at as string) ?? null,
      }));
    },

    /**
     * Manual tests in Octane format: created, or updated when a test with the same Octane
     * unique_id exists. Steps are replaced. Covered stories and requirements become links.
     */
    upsertManualTests(
      tests: {
        externalId: string;
        name: string;
        description: string;
        testType: string;
        purpose: 'uat' | 'regression' | null;
        phase: string;
        owner: string;
        designer: string;
        productAreas: string;
        applicationModules: string;
        userTags: string;
        estimatedMinutes: number | null;
        covers: string[];
        steps: { type: 'simple' | 'validation' | 'call'; description: string }[];
      }[],
      o: { origin: 'upload' | 'uat_analyst'; purposeDefault: 'uat' | 'regression' | null; filename: string; format: string; problems: { row: number; message: string }[]; userId: string },
    ) {
      return db.transaction(() => {
        const t = now();
        const uploadId = createHash('sha1').update(`${o.filename}|${t}|${Math.random()}`).digest('hex').slice(0, 16);
        const find = db.prepare('SELECT id FROM test_cases WHERE application_id = ? AND external_id = ?');
        const storyExists = db.prepare('SELECT 1 FROM stories WHERE key = ?');
        const reqExists = db.prepare('SELECT 1 FROM requirements WHERE id = ?');
        const problems = [...o.problems];
        let created = 0;
        let updated = 0;
        for (const x of tests) {
          const existing = find.get(DEFAULT_APP, x.externalId) as { id: string } | undefined;
          const id = existing?.id ?? `MT-${createHash('sha1').update(`${DEFAULT_APP}|${x.externalId}`).digest('hex').slice(0, 10).toUpperCase()}`;
          const purpose = x.purpose ?? o.purposeDefault;
          if (existing) {
            db.prepare(
              `UPDATE test_cases SET title = ?, description = ?, test_type = ?, purpose = ?, phase = ?, owner = ?, designer = ?, product_areas = ?, application_modules = ?, user_tags = ?, estimated_minutes = ?, status = 'active', upload_id = ?, updated_at = ? WHERE id = ?`,
            ).run(x.name, x.description, x.testType, purpose, x.phase, x.owner, x.designer, x.productAreas, x.applicationModules, x.userTags, x.estimatedMinutes, uploadId, t, id);
            updated++;
          } else {
            db.prepare(
              `INSERT INTO test_cases (id, application_id, title, kind, purpose, origin, external_id, description, test_type, phase, owner, designer, product_areas, application_modules, user_tags, estimated_minutes, upload_id, created_by, created_at, updated_at)
               VALUES (?, ?, ?, 'manual', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            ).run(id, DEFAULT_APP, x.name, purpose, o.origin, x.externalId, x.description, x.testType, x.phase, x.owner, x.designer, x.productAreas, x.applicationModules, x.userTags, x.estimatedMinutes, uploadId, o.userId, t, t);
            created++;
          }
          db.prepare('DELETE FROM test_steps WHERE test_case_id = ?').run(id);
          const st = db.prepare('INSERT INTO test_steps (test_case_id, seq, step_type, description) VALUES (?, ?, ?, ?)');
          x.steps.forEach((s2, i) => st.run(id, i + 1, s2.type, s2.description));
          const link = db.prepare('INSERT OR IGNORE INTO test_case_links (test_case_id, entity_type, entity_ref) VALUES (?, ?, ?)');
          for (const ref of x.covers) {
            const crit = /^([A-Z][A-Z0-9]+-\d+)#(AC\d+)$/.exec(ref);
            if (crit && storyExists.get(crit[1])) {
              link.run(id, 'story', crit[1]);
              link.run(id, 'criterion', ref);
            } else if (storyExists.get(ref)) link.run(id, 'story', ref);
            else if (reqExists.get(ref) || /^N?FR-\d+$/.test(ref)) link.run(id, 'requirement', ref);
            else problems.push({ row: 0, message: `"${x.name}" covers "${ref}", which is not a known story or requirement; not linked.` });
          }
        }
        db.prepare('INSERT INTO hexa_uploads (id, application_id, kind, filename, format, created, updated, problems, uploaded_by, uploaded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
          uploadId,
          DEFAULT_APP,
          'manual_tests',
          o.filename.slice(0, 200),
          o.format,
          created,
          updated,
          JSON.stringify(problems.slice(0, 100)),
          o.userId,
          t,
        );
        audit('user', o.userId, 'hexa.upload_manual', 'upload', uploadId, { created, updated, problems: problems.length });
        return { uploadId, created, updated, problems };
      })();
    },

    /** Automated tests in a repo (or all), for matching CI results. */
    automatedCandidates(repo: string | null) {
      const rows = (
        repo
          ? db.prepare("SELECT id, suite, code_name, title, path FROM test_cases WHERE kind = 'automated' AND status = 'active' AND repo = ?").all(repo)
          : db.prepare("SELECT id, suite, code_name, title, path FROM test_cases WHERE kind = 'automated' AND status = 'active'").all()
      ) as Row[];
      return rows.map((r) => ({ id: String(r.id), suite: (r.suite as string) ?? null, codeName: (r.code_name as string) ?? null, title: String(r.title), path: (r.path as string) ?? null }));
    },

    runExists(source: string, repo: string | null, externalRunId: string) {
      return !!db.prepare('SELECT 1 FROM test_runs WHERE source = ? AND repo IS ? AND external_run_id = ?').get(source, repo, externalRunId);
    },

    /**
     * Stores one run: its results, matched to known tests or added as new tests, and each test's
     * latest result (a run never overwrites a newer one).
     */
    ingestRun(
      meta: RunMeta,
      results: { testCaseId: string | null; create?: { id: string; title: string; suite: string | null; codeName: string; path: string | null }; status: 'passed' | 'failed' | 'skipped'; durationMs: number | null; message: string | null }[],
      userId: string,
    ) {
      return db.transaction(() => {
        const t = now();
        const runId = createHash('sha1').update(`${meta.source}|${meta.repo}|${meta.externalRunId ?? t}|${Math.random()}`).digest('hex').slice(0, 16);
        const runAt = meta.startedAt ?? t;
        let created = 0;
        let matched = 0;
        const counts = { passed: 0, failed: 0, skipped: 0 };
        const seen = new Map<string, (typeof results)[number]>();
        for (const r of results) {
          let id = r.testCaseId;
          if (!id && r.create) {
            id = r.create.id;
            const ins = db
              .prepare(
                `INSERT OR IGNORE INTO test_cases (id, application_id, title, suite, code_name, kind, framework, origin, repo, path, created_by, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, 'automated', NULL, 'ci_results', ?, ?, ?, ?, ?)`,
              )
              .run(id, DEFAULT_APP, r.create.title.slice(0, 300), r.create.suite, r.create.codeName, meta.repo, r.create.path, userId, t, t);
            if (ins.changes) created++;
          } else if (id) matched++;
          if (!id) continue;
          // A test reported twice in one run (retries) keeps its worst result.
          const prev = seen.get(id);
          if (!prev || r.status === 'failed' || (r.status === 'passed' && prev.status === 'skipped')) seen.set(id, { ...r, testCaseId: id });
        }
        for (const r of seen.values()) counts[r.status]++;
        const total = seen.size;
        const duration = [...seen.values()].reduce((a, r) => a + (r.durationMs ?? 0), 0);
        db.prepare(
          `INSERT INTO test_runs (id, application_id, source, repo, workflow, external_run_id, run_url, event, branch, sha, pr_number, is_merge, status, total, passed, failed, skipped, duration_ms, started_at, ingested_by, ingested_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(runId, DEFAULT_APP, meta.source, meta.repo, meta.workflow, meta.externalRunId, meta.runUrl, meta.event, meta.branch, meta.sha, meta.prNumber, meta.isMerge ? 1 : 0, counts.failed ? 'failed' : 'passed', total, counts.passed, counts.failed, counts.skipped, duration, runAt, userId, t);
        const res = db.prepare('INSERT INTO test_results (run_id, test_case_id, status, duration_ms, message) VALUES (?, ?, ?, ?, ?)');
        const last = db.prepare("UPDATE test_cases SET last_result = ?, last_run_at = ?, updated_at = ? WHERE id = ? AND (last_run_at IS NULL OR last_run_at <= ?)");
        for (const r of seen.values()) {
          res.run(runId, r.testCaseId, r.status, r.durationMs, r.message);
          last.run(r.status, runAt, t, r.testCaseId, runAt);
        }
        audit('user', userId, 'hexa.ingest_run', 'test_run', runId, { source: meta.source, repo: meta.repo, total, failed: counts.failed, created });
        return { runId, total, matched, created, ...counts };
      })();
    },

    listRuns(limit = 20) {
      return (db.prepare('SELECT r.*, u.name AS user_name FROM test_runs r LEFT JOIN users u ON u.id = r.ingested_by ORDER BY COALESCE(r.started_at, r.ingested_at) DESC, r.rowid DESC LIMIT ?').all(limit) as Row[]).map((r) => ({
        id: String(r.id),
        source: String(r.source),
        repo: (r.repo as string) ?? null,
        workflow: (r.workflow as string) ?? null,
        runUrl: (r.run_url as string) ?? null,
        branch: (r.branch as string) ?? null,
        sha: (r.sha as string) ?? null,
        prNumber: r.pr_number == null ? null : Number(r.pr_number),
        isMerge: Number(r.is_merge) === 1,
        status: String(r.status),
        total: Number(r.total),
        passed: Number(r.passed),
        failed: Number(r.failed),
        skipped: Number(r.skipped),
        durationMs: r.duration_ms == null ? null : Number(r.duration_ms),
        at: String(r.started_at ?? r.ingested_at),
        by: (r.user_name as string) ?? null,
        failures: db
          .prepare("SELECT t.id, t.title, res.message FROM test_results res JOIN test_cases t ON t.id = res.test_case_id WHERE res.run_id = ? AND res.status = 'failed' ORDER BY t.title LIMIT 20")
          .all(r.id) as { id: string; title: string; message: string | null }[],
      }));
    },

    /** One test with its steps, links and result history. */
    getTest(id: string) {
      const r = db.prepare('SELECT * FROM test_cases WHERE id = ?').get(id) as Row | undefined;
      if (!r) return undefined;
      return {
        id,
        title: String(r.title),
        kind: String(r.kind),
        purpose: (r.purpose as string) ?? null,
        origin: String(r.origin),
        status: String(r.status),
        suite: (r.suite as string) ?? null,
        codeName: (r.code_name as string) ?? null,
        framework: (r.framework as string) ?? null,
        repo: (r.repo as string) ?? null,
        path: (r.path as string) ?? null,
        line: r.line == null ? null : Number(r.line),
        url: (r.url as string) ?? null,
        lastResult: (r.last_result as string) ?? null,
        lastRunAt: (r.last_run_at as string) ?? null,
        externalId: (r.external_id as string) ?? null,
        description: (r.description as string) ?? null,
        testType: (r.test_type as string) ?? null,
        phase: (r.phase as string) ?? null,
        owner: (r.owner as string) ?? null,
        designer: (r.designer as string) ?? null,
        productAreas: (r.product_areas as string) ?? null,
        applicationModules: (r.application_modules as string) ?? null,
        userTags: (r.user_tags as string) ?? null,
        estimatedMinutes: r.estimated_minutes == null ? null : Number(r.estimated_minutes),
        createdAt: String(r.created_at),
        updatedAt: String(r.updated_at),
        steps: db.prepare('SELECT seq, step_type AS type, description FROM test_steps WHERE test_case_id = ? ORDER BY seq').all(id) as { seq: number; type: 'simple' | 'validation' | 'call'; description: string }[],
        links: db.prepare('SELECT entity_type AS type, entity_ref AS ref FROM test_case_links WHERE test_case_id = ? ORDER BY entity_type, entity_ref').all(id) as { type: string; ref: string }[],
        history: (
          db
            .prepare(
              `SELECT res.status, res.duration_ms, res.message, run.id AS run_id, run.source, run.workflow, run.run_url, run.branch, run.sha, run.pr_number, run.is_merge, COALESCE(run.started_at, run.ingested_at) AS at
               FROM test_results res JOIN test_runs run ON run.id = res.run_id WHERE res.test_case_id = ? ORDER BY at DESC LIMIT 20`,
            )
            .all(id) as Row[]
        ).map((h) => ({
          status: String(h.status),
          durationMs: h.duration_ms == null ? null : Number(h.duration_ms),
          message: (h.message as string) ?? null,
          runId: String(h.run_id),
          source: String(h.source),
          workflow: (h.workflow as string) ?? null,
          runUrl: (h.run_url as string) ?? null,
          branch: (h.branch as string) ?? null,
          sha: (h.sha as string) ?? null,
          prNumber: h.pr_number == null ? null : Number(h.pr_number),
          isMerge: Number(h.is_merge) === 1,
          at: String(h.at),
        })),
      };
    },

    /** Manual tests as rows for the Octane export. */
    manualForExport(ids?: string[]) {
      const rows = (
        ids?.length
          ? db.prepare(`SELECT * FROM test_cases WHERE kind = 'manual' AND status = 'active' AND id IN (${ids.map(() => '?').join(', ')}) ORDER BY external_id`).all(...ids)
          : db.prepare("SELECT * FROM test_cases WHERE kind = 'manual' AND status = 'active' ORDER BY external_id").all()
      ) as Row[];
      const steps = db.prepare('SELECT step_type AS type, description FROM test_steps WHERE test_case_id = ? ORDER BY seq');
      const covers = db.prepare("SELECT entity_ref AS ref FROM test_case_links WHERE test_case_id = ? AND entity_type IN ('story', 'requirement', 'criterion') ORDER BY entity_type, entity_ref");
      return rows.map((r) => ({
        id: String(r.id),
        externalId: (r.external_id as string) ?? null,
        title: String(r.title),
        description: (r.description as string) ?? null,
        testType: (r.test_type as string) ?? null,
        phase: (r.phase as string) ?? null,
        owner: (r.owner as string) ?? null,
        designer: (r.designer as string) ?? null,
        productAreas: (r.product_areas as string) ?? null,
        applicationModules: (r.application_modules as string) ?? null,
        userTags: (r.user_tags as string) ?? null,
        estimatedMinutes: r.estimated_minutes == null ? null : Number(r.estimated_minutes),
        covers: (covers.all(r.id) as { ref: string }[]).map((c) => c.ref),
        steps: steps.all(r.id) as { type: 'simple' | 'validation' | 'call'; description: string }[],
      }));
    },

    listUploads(limit = 8) {
      return (db.prepare('SELECT h.*, u.name AS user_name FROM hexa_uploads h JOIN users u ON u.id = h.uploaded_by ORDER BY uploaded_at DESC, h.rowid DESC LIMIT ?').all(limit) as Row[]).map((r) => ({
        id: String(r.id),
        kind: String(r.kind),
        filename: String(r.filename),
        created: Number(r.created),
        updated: Number(r.updated),
        problems: json<{ row: number; message: string }[]>(r.problems, []),
        by: String(r.user_name),
        at: String(r.uploaded_at),
      }));
    },

    /** UAT cases the UAT analyst proposed for a story's gaps, kept in Hexa as proposed until someone adds them. */
    upsertProposedCases(storyKey: string, cases: { id: string; title: string; criterion: string }[], userId: string) {
      const t = now();
      const story = getStory(storyKey);
      db.transaction(() => {
        const up = db.prepare(
          `INSERT INTO test_cases (id, application_id, title, kind, origin, status, created_by, created_at, updated_at)
           VALUES (?, ?, ?, 'proposed', 'uat_analyst', 'active', ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET title = excluded.title, updated_at = excluded.updated_at`,
        );
        const link = db.prepare('INSERT OR IGNORE INTO test_case_links (test_case_id, entity_type, entity_ref) VALUES (?, ?, ?)');
        for (const c of cases) {
          up.run(c.id, DEFAULT_APP, c.title, userId, t, t);
          link.run(c.id, 'story', storyKey);
          link.run(c.id, 'criterion', `${storyKey}#${c.criterion}`);
          for (const comp of story?.components ?? []) link.run(c.id, 'component', comp);
        }
      })();
    },

    /** Marks anything left running (for example after a crash or restart) as stopped. */
    stopOrphans() {
      const t = now();
      db.prepare("UPDATE agent_runs SET status = 'stopped', ended_at = ? WHERE status = 'running'").run(t);
      db.prepare("UPDATE workflow_runs SET status = 'stopped', ended_at = ? WHERE status = 'running'").run(t);
      db.prepare("UPDATE agent_steps SET status = 'failed', ended_at = ? WHERE status = 'running'").run(t);
      db.prepare("UPDATE repo_scans SET status = 'failed', error = 'The server stopped during the scan', ended_at = ? WHERE status = 'running'").run(t);
    },

    /** Agent activity: everything running now, plus the most recent finished runs. */
    listAgentActivity(opts: { recent?: number } = {}): AgentActivity[] {
      const rows = db
        .prepare(
          `SELECT a.*, p.agent AS parent_agent, u.id AS user_id, u.name AS user_name, u.initials AS user_initials, c.id AS chat_id, c.title AS chat_title
           FROM agent_runs a
           JOIN workflow_runs w ON w.id = a.workflow_run_id
           JOIN users u ON u.id = w.requested_by
           LEFT JOIN agent_runs p ON p.id = a.parent_id
           LEFT JOIN chats c ON c.id = w.chat_id
           WHERE a.status = 'running'
              OR a.id IN (SELECT id FROM agent_runs WHERE status != 'running' ORDER BY started_at DESC, rowid DESC LIMIT ?)
           ORDER BY a.started_at DESC, a.rowid DESC`,
        )
        .all(opts.recent ?? 60) as Row[];
      const steps = db.prepare('SELECT seq, kind, label, detail, status FROM agent_steps WHERE agent_run_id = ? ORDER BY seq');
      return rows.map((r) => ({
        id: String(r.id),
        workflowRunId: String(r.workflow_run_id),
        parentId: (r.parent_id as string) ?? null,
        parentAgent: (r.parent_agent as string) ?? null,
        agent: String(r.agent),
        kind: r.kind as AgentKind,
        task: String(r.task),
        status: r.status as RunStatus,
        model: (r.model as string) ?? null,
        result: (r.result as string) ?? null,
        error: (r.error as string) ?? null,
        tokens: r.prompt_tokens == null && r.completion_tokens == null ? null : Number(r.prompt_tokens ?? 0) + Number(r.completion_tokens ?? 0),
        startedAt: String(r.started_at),
        endedAt: (r.ended_at as string) ?? null,
        requestedBy: { id: String(r.user_id), name: String(r.user_name), initials: String(r.user_initials) },
        chat: r.chat_id ? { id: String(r.chat_id), title: String(r.chat_title) } : null,
        steps: steps.all(r.id) as AgentActivity['steps'],
      }));
    },
  };
}

/** Stable id for a scanned test, so a re-scan updates it instead of adding a duplicate. */
function testId(repo: string, path: string, suite: string | null, title: string) {
  return `TC-${createHash('sha1').update(`${repo}|${path}|${suite ?? ''}|${title}`).digest('hex').slice(0, 10).toUpperCase()}`;
}
