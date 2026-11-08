/**
 * Catalyzt's database (SQLite). Opens and migrates it, seeds it from the workspace, and exposes
 * small repositories. Every repository is scoped to an application. The schema is in schema.ts,
 * the design in DATA_MODEL.md. Server only.
 */
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import type { Intent } from '../src/lib/intent';
import type { Artifact, Block, Citation, CriterionStatus, Message, Ticket } from '../src/lib/types';
import { MIGRATIONS } from './schema';
import type { Workspace } from './workspace';

export const STATUSES = ['To Do', 'In Progress', 'Ready for UAT', 'Done'] as const;
export type StoryStatus = (typeof STATUSES)[number];
export const STORY_TYPES = ['Story', 'Bug', 'Task'] as const;
export type Role = 'member' | 'app_owner' | 'component_manager' | 'security_champion';

export interface JiraFilter {
  project: string;
  statuses: StoryStatus[];
  everyMinutes: number;
  lastSyncAt: string;
}

/** A story as stored. `original` keeps what the author first wrote. */
export interface StoredStory extends Omit<Ticket, 'uat'> {
  applicationId: string;
  source: 'jira_sync' | 'horizon';
  purpose: 'uat' | 'regression' | null;
  assigneeId: string | null;
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
  /** Component names within the application. */
  components: string[];
  acceptanceCriteria: string[];
  purpose: 'uat' | 'regression' | null;
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

export interface PersonRecord {
  id: string;
  name: string;
  initials: string;
  email: string;
}

export interface ComponentRecord {
  id: string;
  name: string;
  managerId: string | null;
  managerName: string | null;
  workspace: string | null;
  repo: string | null;
  path: string | null;
  language: string | null;
  tests: string | null;
}

export interface AppRecord {
  id: string;
  name: string;
  description: string;
  jiraProject: string;
  roles: Role[];
  workspaces: string[];
  components: ComponentRecord[];
}

export interface TestCaseRow {
  id: string;
  title: string;
  suite: string | null;
  kind: 'automated' | 'manual' | 'proposed';
  framework: string | null;
  origin: 'repo_scan' | 'uat_analyst' | 'authoring' | 'manual' | 'upload' | 'ci_results';
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
  app: string;
  source: 'github_actions' | 'webhook' | 'upload';
  repo: string | null;
  workflow: string | null;
  externalRunId: string | null;
  /** CI attempt of the same run (a rerun is a new attempt). 1 for uploads. */
  attempt: number;
  runUrl: string | null;
  event: string | null;
  branch: string | null;
  sha: string | null;
  prNumber: number | null;
  isMerge: boolean;
  startedAt: string | null;
  /** The test framework the results came from (JUnit, go test, Jest…); 'JUnit XML' when the delivery did not say. */
  framework?: string | null;
}

/** Words in a component name or path that say nothing about which tests belong to it. */
const GENERIC_WORDS = new Set(['service', 'services', 'svc', 'api', 'app', 'application', 'core', 'lib', 'library', 'client', 'server', 'web', 'ui', 'module', 'component', 'backend']);
/** Path words that would match every test (src/main/test, language and vendor segments). */
const NOISE_WORDS = new Set(['src', 'main', 'test', 'tests', 'java', 'go', 'com', 'org', 'io', 'net', 'pkg', 'internal', 'cmd']);
const escapeLike = (s: string) => s.replace(/[%_\\]/g, (m) => `\\${m}`);

/** The distinctive words of a component ("account-service" → account; "ach-core" → ach; "frontend" → frontend). */
export function componentKeywords(name: string, path: string | null): string[] {
  const raw = [name, ...(path ?? '').split('/')].flatMap((s) => s.toLowerCase().split(/[^a-z0-9]+/)).filter((w) => w.length >= 3 && !NOISE_WORDS.has(w));
  const specific = raw.filter((w) => !GENERIC_WORDS.has(w));
  return [...new Set(specific.length ? specific : raw)];
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
  /** Files the scan could not read. */
  filesFailed: number | null;
  /** True when every test file was listed and read; only then can absent tests be removed. */
  complete: boolean | null;
  error: string | null;
  startedBy: string;
  startedAt: string;
  endedAt: string | null;
}

/** The run a criterion's evidence is read from: the latest merge-commit run of the test's repository. */
export interface EvidenceBuild {
  runId: string;
  repo: string | null;
  sha: string | null;
  branch: string | null;
  prNumber: number | null;
  attempt: number;
  at: string;
  /** For people: "PR #1482 (abc1234, main)". */
  label: string;
}

/** A linked test's result in the target build. `missing`: the test was not in that run, so an older pass does not count. */
export type EvidenceResult = 'passed' | 'failed' | 'skipped' | 'missing' | 'not_run' | 'manual';

/** What Hexa knows about one acceptance criterion. */
export interface CriterionCoverage {
  status: CriterionStatus;
  evidence: string;
  tests: { id: string; title: string; kind: string; result: EvidenceResult }[];
  /** The builds the evidence comes from, one per repository with a recorded run. */
  builds: EvidenceBuild[];
}

type Row = Record<string, unknown>;
const now = () => new Date().toISOString();
const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();
const json = <T>(v: unknown, fallback: T): T => {
  try {
    return typeof v === 'string' ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
};

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

/** Component ids are "<application>/<name>", so two applications can both have a "frontend". */
export const componentId = (app: string, name: string) => `${app}/${name}`;

/** A write that would cross an application or chat boundary. The API turns it into a 404 or 409. */
export class OwnershipError extends Error {}

export type ApprovalStatus = 'pending' | 'approved' | 'declined' | 'expired';
/** What an approved add_uat_cases action does, frozen when the approval was shown. */
export interface ApprovalPayload {
  storyKey?: string;
  artifactId?: string;
  cases?: { id: string; title: string; criterion: string; steps: string[] }[];
  /** The components the change targets, frozen with the approval (F19: who may approve is decided from these). */
  components?: string[];
}
export interface ApprovalOutcome {
  ok: boolean;
  text: string;
}

/** Stable id for a manual or proposed test from its Octane unique_id within an application. */
const manualId = (app: string, externalId: string) => `MT-${createHash('sha1').update(`${app}|${externalId}`).digest('hex').slice(0, 10).toUpperCase()}`;

/** Stable id for a scanned test, so a re-scan updates it instead of adding a duplicate. */
function testId(app: string, repo: string, path: string, suite: string | null, title: string) {
  return `TC-${createHash('sha1').update(`${app}|${repo}|${path}|${suite ?? ''}|${title}`).digest('hex').slice(0, 10).toUpperCase()}`;
}

export type HorizonDb = ReturnType<typeof openDb>;

/** Opens the database and migrates it. It starts empty; seedWorkspace fills it. Use ':memory:' in tests. */
export function openDb(path: string) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  // WAL: readers never block the one writer. synchronous=NORMAL is durable against an application crash
  // (the WAL is synced at every checkpoint); a bounded busy timeout instead of an immediate SQLITE_BUSY.
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
  migrate(db);

  const q = {
    criteria: db.prepare('SELECT text FROM story_criteria WHERE story_key = ? ORDER BY seq'),
    components: db.prepare('SELECT c.name FROM story_components sc JOIN components c ON c.id = sc.component_id WHERE sc.story_key = ? ORDER BY c.name'),
    requirements: db.prepare('SELECT requirement_id AS r FROM story_requirements WHERE story_key = ? ORDER BY requirement_id'),
    story: db.prepare('SELECT * FROM stories WHERE key = ?'),
    user: db.prepare('SELECT id, name, initials, email FROM users WHERE id = ?'),
    componentByName: db.prepare('SELECT id FROM components WHERE application_id = ? AND name = ?'),
  };

  function toStory(r: Row): StoredStory {
    const key = String(r.key);
    return {
      key,
      applicationId: String(r.application_id),
      summary: String(r.summary),
      description: String(r.description),
      type: r.type as StoredStory['type'],
      status: String(r.status),
      fixVersion: String(r.fix_version),
      assignee: String(r.assignee),
      assigneeId: (r.assignee_id as string) ?? null,
      purpose: (r.purpose as StoredStory['purpose']) ?? null,
      updated: String(r.updated_at),
      acceptanceCriteria: (q.criteria.all(key) as { text: string }[]).map((x) => x.text),
      components: (q.components.all(key) as { name: string }[]).map((x) => x.name),
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

  function getUser(id: string) {
    return q.user.get(id) as PersonRecord | undefined;
  }

  function getFilter(app: string): JiraFilter {
    const r = db.prepare('SELECT * FROM jira_sync WHERE application_id = ?').get(app) as Row | undefined;
    if (!r) {
      const a = db.prepare('SELECT jira_project FROM applications WHERE id = ?').get(app) as { jira_project: string } | undefined;
      return { project: a?.jira_project ?? app, statuses: ['Ready for UAT'], everyMinutes: 15, lastSyncAt: now() };
    }
    return { project: String(r.project), statuses: json(r.statuses, []), everyMinutes: Number(r.every_minutes), lastSyncAt: String(r.last_sync_at) };
  }

  function rolesFor(userId: string, app: string): Role[] {
    return (db.prepare('SELECT role FROM memberships WHERE user_id = ? AND application_id = ?').all(userId, app) as { role: Role }[]).map((r) => r.role);
  }

  function listComponents(app: string): ComponentRecord[] {
    return (
      db
        .prepare(
          `SELECT c.*, u.name AS manager_name, w.name AS workspace_name FROM components c
           LEFT JOIN users u ON u.id = c.manager_id LEFT JOIN workspaces w ON w.id = c.workspace_id
           WHERE c.application_id = ? ORDER BY c.name`,
        )
        .all(app) as Row[]
    ).map((r) => ({
      id: String(r.id),
      name: String(r.name),
      managerId: (r.manager_id as string) ?? null,
      managerName: (r.manager_name as string) ?? null,
      workspace: (r.workspace_name as string) ?? null,
      repo: (r.repo as string) ?? null,
      path: (r.path as string) ?? null,
      language: (r.language as string) ?? null,
      tests: (r.tests as string) ?? null,
    }));
  }

  function getApp(id: string, forUser?: string): AppRecord | undefined {
    const r = db.prepare('SELECT * FROM applications WHERE id = ?').get(id) as Row | undefined;
    if (!r) return undefined;
    return {
      id,
      name: String(r.name),
      description: String(r.description ?? ''),
      jiraProject: String(r.jira_project),
      roles: forUser ? rolesFor(forUser, id) : [],
      workspaces: (db.prepare('SELECT name FROM workspaces WHERE application_id = ? ORDER BY rowid').all(id) as { name: string }[]).map((w) => w.name),
      components: listComponents(id),
    };
  }

  /** Links a story to components by name within its application. */
  function linkStory(key: string, app: string, criteria: string[], components: string[], requirements: string[]) {
    const ac = db.prepare('INSERT INTO story_criteria (story_key, seq, text) VALUES (?, ?, ?)');
    criteria.forEach((c, i) => ac.run(key, i + 1, c));
    const sc = db.prepare('INSERT OR IGNORE INTO story_components (story_key, component_id) VALUES (?, ?)');
    for (const name of components) {
      const c = q.componentByName.get(app, name) as { id: string } | undefined;
      if (c) sc.run(key, c.id);
    }
    const req = db.prepare('INSERT OR IGNORE INTO requirements (id, application_id) VALUES (?, ?)');
    const sr = db.prepare('INSERT OR IGNORE INTO story_requirements (story_key, requirement_id) VALUES (?, ?)');
    for (const r of requirements) {
      req.run(r, app);
      sr.run(key, r);
    }
  }

  function getChat(id: string) {
    const r = db.prepare('SELECT id, application_id, title, agent, created_by FROM chats WHERE id = ?').get(id) as Row | undefined;
    return r ? { id, applicationId: String(r.application_id), title: String(r.title), agent: String(r.agent), createdBy: String(r.created_by) } : undefined;
  }

  function getApproval(id: string) {
    const r = db
      .prepare(
        `SELECT a.*, ar.revision, m.chat_id, c.application_id FROM approvals a JOIN answer_revisions ar ON ar.id = a.revision_id
         JOIN messages m ON m.id = ar.message_id JOIN chats c ON c.id = m.chat_id WHERE a.id = ?`,
      )
      .get(id) as Row | undefined;
    if (!r) return undefined;
    const decidedBy = (r.decided_by as string) ?? null;
    return {
      id,
      revisionId: String(r.revision_id),
      revision: Number(r.revision),
      action: String(r.action),
      target: json<{ artifactId?: string | null; storyKey?: string | null }>(r.target, {}),
      payload: json<ApprovalPayload>(r.payload, {}),
      status: r.status as ApprovalStatus,
      chatId: String(r.chat_id),
      app: String(r.application_id),
      decidedBy,
      decidedByName: decidedBy ? (getUser(decidedBy)?.name ?? decidedBy) : null,
      decidedAt: (r.decided_at as string) ?? null,
      outcome: json<ApprovalOutcome | null>(r.outcome, null),
      supersededBy: (r.superseded_by as string) ?? null,
    };
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

    /* ---------- People and applications ---------- */
    getUser,
    /** The person a sign-in proxy names by email. */
    getUserByEmail(email: string) {
      return db.prepare('SELECT id, name, initials, email FROM users WHERE lower(email) = lower(?)').get(email.trim()) as PersonRecord | undefined;
    },
    rolesFor,
    getApp,
    listComponents,
    /** True when the database has no people: no workspace was loaded. */
    isEmpty() {
      return (db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n === 0;
    },
    /** The first person, for requests that carry no user (there is no sign-in in this preview). */
    defaultUser() {
      return db.prepare('SELECT id, name, initials, email FROM users ORDER BY rowid LIMIT 1').get() as PersonRecord | undefined;
    },
    /** Everyone, with their apps and roles, for the "Sign in as" picker. */
    listPeople() {
      const people = db.prepare('SELECT id, name, initials, email FROM users ORDER BY rowid').all() as PersonRecord[];
      const roles = db.prepare("SELECT application_id AS id, role FROM memberships WHERE user_id = ? AND role != 'member' ORDER BY application_id").all.bind(
        db.prepare("SELECT application_id AS id, role FROM memberships WHERE user_id = ? AND role != 'member' ORDER BY application_id"),
      );
      return people.map((p) => ({ ...p, apps: roles(p.id) as { id: string; role: string }[] }));
    },
    appsFor(userId: string): AppRecord[] {
      const ids = (db.prepare('SELECT DISTINCT application_id AS id FROM memberships WHERE user_id = ? ORDER BY application_id').all(userId) as { id: string }[]).map((r) => r.id);
      return ids.map((id) => getApp(id, userId)!).filter(Boolean);
    },
    isMember(userId: string, app: string) {
      return !!db.prepare('SELECT 1 FROM memberships WHERE user_id = ? AND application_id = ?').get(userId, app);
    },

    /* ---------- Jira ---------- */
    getFilter,
    setFilter(f: { statuses: StoryStatus[]; everyMinutes: number }, by: string, app: string) {
      const cur = getFilter(app);
      db.prepare(
        `INSERT INTO jira_sync (application_id, project, statuses, every_minutes, last_sync_at, updated_by) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(application_id) DO UPDATE SET statuses = excluded.statuses, every_minutes = excluded.every_minutes, updated_by = excluded.updated_by`,
      ).run(app, cur.project, JSON.stringify(f.statuses), f.everyMinutes, cur.lastSyncAt, by);
      audit('user', by, 'jira_filter.update', 'application', app, f);
      return getFilter(app);
    },
    /** In production this pulls from Jira; the dummy Jira is this database, so a sync only records the time. */
    markSynced(app: string) {
      db.prepare('UPDATE jira_sync SET last_sync_at = ? WHERE application_id = ?').run(now(), app);
      return getFilter(app);
    },
    listStories(app: string, filter: JiraFilter = getFilter(app)): StoredStory[] {
      if (filter.statuses.length === 0) return [];
      const marks = filter.statuses.map(() => '?').join(', ');
      return (db.prepare(`SELECT * FROM stories WHERE application_id = ? AND status IN (${marks}) ORDER BY updated_at DESC`).all(app, ...filter.statuses) as Row[]).map(toStory);
    },
    getStory,
    createStory(s: NewStory, app: string): StoredStory {
      const { project } = getFilter(app);
      const key = db.transaction(() => {
        const { n } = db.prepare('SELECT COALESCE(MAX(number), 1000) + 1 AS n FROM stories WHERE project = ?').get(project) as { n: number };
        const k = `${project}-${n}`;
        const t = now();
        const user = getUser(s.createdBy);
        db.prepare(
          `INSERT INTO stories (key, application_id, project, number, summary, description, type, status, fix_version, assignee, assignee_id, purpose, original, refinement_id, source, created_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'horizon', ?, ?, ?)`,
        ).run(k, app, project, n, s.summary, s.description, s.type, s.status, s.fixVersion, user?.name ?? '', s.createdBy, s.purpose, s.original ? JSON.stringify(s.original) : null, s.refinementId, s.createdBy, t, t);
        linkStory(k, app, s.acceptanceCriteria, s.components, []);
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
    /** Creates the chat, or touches it. A chat never changes application or owner: that is an OwnershipError. */
    upsertChat(c: { id: string; title: string; agent: string; workspace: string; userId: string }, app: string) {
      const t = now();
      const existing = getChat(c.id);
      if (existing && existing.applicationId !== app) throw new OwnershipError(`Chat ${c.id} belongs to another application.`);
      if (existing && existing.createdBy !== c.userId) throw new OwnershipError(`Chat ${c.id} was started by someone else.`);
      const ws = db.prepare('SELECT id FROM workspaces WHERE application_id = ? AND name = ?').get(app, c.workspace) as { id: string } | undefined;
      db.prepare(
        `INSERT INTO chats (id, application_id, workspace_id, title, agent, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET agent = excluded.agent, updated_at = excluded.updated_at`,
      ).run(c.id, app, ws?.id ?? null, c.title.slice(0, 200), c.agent, c.userId, t, t);
    },
    /** A person's recent chats in an application. */
    listChats(app: string, userId: string, limit = 12) {
      return (db.prepare('SELECT id, title, updated_at FROM chats WHERE application_id = ? AND created_by = ? ORDER BY updated_at DESC LIMIT ?').all(app, userId, limit) as Row[]).map((r) => ({
        id: String(r.id),
        title: String(r.title),
        updatedAt: String(r.updated_at),
      }));
    },
    getChat,
    /**
     * Stores the user's message once (a retry of the same message is not a new turn). A message
     * already stored in another chat, or stored as an answer, is an OwnershipError. `removedReason`
     * stores the row without its text, for a message a guard rejected before anything was kept.
     */
    addUserMessage(m: { id: string; chatId: string; text: string; testType: string | null; testTypeSource: string | null; userId: string; items: { type: string; ref: string }[]; removedReason?: string | null }) {
      const exists = db.prepare('SELECT chat_id, role FROM messages WHERE id = ?').get(m.id) as Row | undefined;
      if (exists) {
        if (exists.chat_id !== m.chatId || exists.role !== 'user') throw new OwnershipError(`Message ${m.id} is not a message of chat ${m.chatId}.`);
        return;
      }
      if (!getChat(m.chatId)) throw new OwnershipError(`Chat ${m.chatId} does not exist.`);
      const { seq } = db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM messages WHERE chat_id = ?').get(m.chatId) as { seq: number };
      db.prepare('INSERT INTO messages (id, chat_id, seq, role, text, test_type, test_type_source, removed_reason, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
        m.id,
        m.chatId,
        seq,
        'user',
        m.removedReason ? '' : m.text,
        m.testType,
        m.testTypeSource,
        m.removedReason ?? null,
        m.userId,
        now(),
      );
      if (m.removedReason) return;
      const it = db.prepare('INSERT OR IGNORE INTO message_items (message_id, item_type, item_ref) VALUES (?, ?, ?)');
      for (const i of m.items) it.run(m.id, i.type, i.ref);
    },
    /** A guard removed the message: keep the row, drop the text. */
    removeMessageText(id: string, reason: string) {
      db.prepare("UPDATE messages SET text = '', removed_reason = ? WHERE id = ?").run(reason, id);
    },
    /** The chat a message belongs to and its role, for ownership checks before a run. */
    messageChat(id: string) {
      const r = db.prepare('SELECT chat_id, role FROM messages WHERE id = ?').get(id) as Row | undefined;
      return r ? { chatId: String(r.chat_id), role: String(r.role) as 'user' | 'assistant' } : undefined;
    },
    /** The revision the next answer to this message will get. saveAnswer allocates it again inside its transaction. */
    nextRevision(answerId: string) {
      return (db.prepare('SELECT COALESCE(MAX(revision), 0) + 1 AS n FROM answer_revisions WHERE message_id = ?').get(answerId) as { n: number }).n;
    },

    /* ---------- Workflow, agents, steps, guards ---------- */
    startWorkflow(w: { id: string; app: string | null; chatId: string | null; messageId: string | null; revision: number; userId: string }) {
      db.prepare("INSERT INTO workflow_runs (id, application_id, chat_id, message_id, revision, requested_by, status, started_at) VALUES (?, ?, ?, ?, ?, ?, 'running', ?)").run(
        w.id,
        w.app,
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

    /** Token totals for an application (or everything): all time, today, by agent, model, user and day. */
    usage(app: string | null = null) {
      const sum = `COUNT(*) AS calls, COALESCE(SUM(m.prompt_tokens), 0) AS prompt, COALESCE(SUM(m.completion_tokens), 0) AS completion,
                   COALESCE(SUM(m.prompt_tokens), 0) + COALESCE(SUM(m.completion_tokens), 0) AS total,
                   SUM(CASE WHEN m.prompt_tokens IS NULL THEN 1 ELSE 0 END) AS unreported`;
      const from = `FROM model_calls m LEFT JOIN workflow_runs w ON w.id = m.workflow_run_id WHERE (? IS NULL OR w.application_id = ?)`;
      const startOfDay = new Date();
      startOfDay.setHours(0, 0, 0, 0);
      type Tot = { calls: number; prompt: number; completion: number; total: number; unreported: number };
      return {
        allTime: db.prepare(`SELECT ${sum} ${from}`).get(app, app) as Tot,
        today: db.prepare(`SELECT ${sum} ${from} AND m.created_at >= ?`).get(app, app, startOfDay.toISOString()) as Tot,
        byAgent: db.prepare(`SELECT m.agent AS key, ${sum} ${from} GROUP BY m.agent ORDER BY total DESC`).all(app, app) as (Tot & { key: string })[],
        byModel: db.prepare(`SELECT m.model AS key, ${sum} ${from} GROUP BY m.model ORDER BY total DESC`).all(app, app) as (Tot & { key: string })[],
        byUser: db
          .prepare(`SELECT COALESCE(u.name, 'Unknown') AS key, ${sum} FROM model_calls m LEFT JOIN workflow_runs w ON w.id = m.workflow_run_id LEFT JOIN users u ON u.id = m.user_id WHERE (? IS NULL OR w.application_id = ?) GROUP BY u.id ORDER BY total DESC`)
          .all(app, app) as (Tot & { key: string })[],
        byDay: db.prepare(`SELECT substr(m.created_at, 1, 10) AS key, ${sum} ${from} GROUP BY key ORDER BY key DESC LIMIT 14`).all(app, app) as (Tot & { key: string })[],
      };
    },

    /* ---------- Hexa: test case inventory ---------- */

    /**
     * SQL for "tests that belong to this component": linked to it, under its path in the repository,
     * in a package or directory named after it (CI-imported tests have no path, only a suite such as
     * com.piggymetrics.account.AccountControllerTest), or mentioning it by name. Null for an unknown component.
     */
    componentTestsWhere(app: string, name: string): { sql: string; args: unknown[] } | null {
      const comp = db.prepare('SELECT name, repo, path FROM components WHERE application_id = ? AND LOWER(name) = LOWER(?)').get(app, name) as { name: string; repo: string | null; path: string | null } | undefined;
      if (!comp) return null;
      const parts: string[] = [];
      const args: unknown[] = [];
      parts.push("EXISTS (SELECT 1 FROM test_case_links l WHERE l.test_case_id = t.id AND l.entity_type = 'component' AND l.entity_ref = ?)");
      args.push(`${app}/${comp.name}`);
      const p = (comp.path ?? '').replace(/^\.?\/+/, '').replace(/\/+$/, '');
      if (p) {
        parts.push("(t.path = ? OR t.path LIKE ? ESCAPE '\\' OR t.path LIKE ? ESCAPE '\\')");
        args.push(p, `${escapeLike(p)}/%`, `%/${escapeLike(p)}/%`);
      }
      for (const kw of componentKeywords(comp.name, comp.path)) {
        parts.push("(t.suite LIKE ? ESCAPE '\\' OR t.suite LIKE ? ESCAPE '\\' OR t.suite LIKE ? ESCAPE '\\' OR t.suite LIKE ? ESCAPE '\\')");
        args.push(`%.${escapeLike(kw)}.%`, `${escapeLike(kw)}.%`, `%/${escapeLike(kw)}/%`, `%/${escapeLike(kw)}`);
      }
      const like = `%${escapeLike(comp.name)}%`;
      parts.push("(t.title LIKE ? ESCAPE '\\' OR t.path LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM test_case_links l WHERE l.test_case_id = t.id AND l.entity_ref LIKE ? ESCAPE '\\'))");
      args.push(like, like, like);
      return { sql: `(${parts.join(' OR ')})`, args };
    },

    listTests(app: string, f: { q?: string; kind?: string; kinds?: string[]; purpose?: string; result?: string; origin?: string; framework?: string; repo?: string; component?: string; limit?: number; offset?: number } = {}) {
      const where = ["t.status = 'active'", 't.application_id = ?'];
      const args: unknown[] = [app];
      // A component filter, or a search that is exactly a component's name, means "its tests" (see componentTestsWhere).
      const comp = f.component ? this.componentTestsWhere(app, f.component) : f.q ? this.componentTestsWhere(app, f.q.trim()) : null;
      if (f.component) {
        if (!comp) return { rows: [] as TestCaseRow[], total: 0 };
        where.push(comp.sql);
        args.push(...comp.args);
      }
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
        const text = `(t.title LIKE ? ESCAPE '\\' OR t.suite LIKE ? ESCAPE '\\' OR t.path LIKE ? ESCAPE '\\' OR t.id LIKE ? ESCAPE '\\' OR t.external_id LIKE ? ESCAPE '\\' OR t.code_name LIKE ? ESCAPE '\\'
            OR EXISTS (SELECT 1 FROM test_case_links l WHERE l.test_case_id = t.id AND l.entity_ref LIKE ? ESCAPE '\\')
            OR EXISTS (SELECT 1 FROM test_steps st WHERE st.test_case_id = t.id AND st.description LIKE ? ESCAPE '\\'))`;
        args.push(like, like, like, like, like, like, like, like);
        if (comp && !f.component) {
          where.push(`(${text} OR ${comp.sql})`);
          args.push(...comp.args);
        } else where.push(text);
      }
      const w = where.join(' AND ');
      const total = (db.prepare(`SELECT COUNT(*) AS n FROM test_cases t WHERE ${w}`).get(...args) as { n: number }).n;
      // F26: the repository enforces the bounds too; a negative or non-finite limit never means "all".
      const limit = Number.isFinite(f.limit) && (f.limit as number) >= 1 ? Math.min(Math.trunc(f.limit as number), 200) : 50;
      const offset = Number.isFinite(f.offset) && (f.offset as number) >= 0 ? Math.trunc(f.offset as number) : 0;
      const rows = db.prepare(`SELECT * FROM test_cases t WHERE ${w} ORDER BY t.updated_at DESC, t.repo, t.path, t.line LIMIT ? OFFSET ?`).all(...args, limit, offset) as Row[];
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

    testStats(app: string) {
      const one = (sql: string) => db.prepare(sql).all(app) as { key: string; n: number }[];
      const A = "status = 'active' AND application_id = ?";
      return {
        total: (db.prepare(`SELECT COUNT(*) AS n FROM test_cases WHERE ${A}`).get(app) as { n: number }).n,
        byKind: one(`SELECT kind AS key, COUNT(*) AS n FROM test_cases WHERE ${A} GROUP BY kind`),
        byOrigin: one(`SELECT origin AS key, COUNT(*) AS n FROM test_cases WHERE ${A} GROUP BY origin`),
        // Automated tests without a recorded framework are "Unknown", never "Manual".
        byFramework: one(`SELECT CASE WHEN kind = 'automated' THEN COALESCE(framework, 'Unknown') ELSE 'Manual' END AS key, COUNT(*) AS n FROM test_cases WHERE ${A} GROUP BY key ORDER BY n DESC`),
        byRepo: one(`SELECT COALESCE(repo, 'No repository') AS key, COUNT(*) AS n FROM test_cases WHERE ${A} GROUP BY key ORDER BY n DESC`),
        byResult: one(`SELECT COALESCE(last_result, 'none') AS key, COUNT(*) AS n FROM test_cases WHERE ${A} AND kind = 'automated' GROUP BY key`),
        byPurpose: one(`SELECT COALESCE(purpose, 'none') AS key, COUNT(*) AS n FROM test_cases WHERE ${A} GROUP BY key`),
        runs: (db.prepare('SELECT COUNT(*) AS n FROM test_runs WHERE application_id = ?').get(app) as { n: number }).n,
        storiesWithoutTests: (
          db
            .prepare(
              `SELECT COUNT(*) AS n FROM stories s WHERE s.application_id = ? AND NOT EXISTS (
                 SELECT 1 FROM test_case_links l JOIN test_cases t ON t.id = l.test_case_id AND t.status = 'active' WHERE l.entity_type = 'story' AND l.entity_ref = s.key)`,
            )
            .get(app) as { n: number }
        ).n,
      };
    },

    startScan(s: { id: string; app: string; repo: string; ref: string | null; workflowRunId: string; userId: string }) {
      db.prepare("INSERT INTO repo_scans (id, application_id, repo, ref, status, workflow_run_id, started_by, started_at) VALUES (?, ?, ?, ?, 'running', ?, ?, ?)").run(
        s.id,
        s.app,
        s.repo,
        s.ref,
        s.workflowRunId,
        s.userId,
        now(),
      );
    },
    runningScan(app: string, repo: string) {
      return db.prepare("SELECT id FROM repo_scans WHERE application_id = ? AND repo = ? AND status = 'running'").get(app, repo) as { id: string } | undefined;
    },
    failScan(id: string, error: string) {
      db.prepare("UPDATE repo_scans SET status = 'failed', error = ?, ended_at = ? WHERE id = ?").run(error, now(), id);
    },

    /**
     * Records what a scan found: new tests are added, known ones updated. A test is marked removed
     * (kept for history) only when the scan establishes it is gone: its file was read in this scan
     * and no longer holds it, or the complete file listing no longer has its file. Tests in files
     * the scan could not read, or beyond a truncated listing, are left as they are.
     */
    completeScan(s: {
      id: string;
      app: string;
      repo: string;
      ref: string;
      sha: string;
      htmlUrl: string;
      filesFound: number;
      filesScanned: number;
      filesFailed: number;
      /** True when the scan did not read every listed file (limit or failures). */
      truncated: boolean;
      /** Paths read successfully in this scan. */
      readPaths: string[];
      /** Every test file in the tree, or null when the listing itself was cut short. */
      listedPaths: string[] | null;
      tests: { path: string; title: string; name?: string; suite: string | null; framework: string; line: number }[];
      userId: string;
    }) {
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
          const id = testId(s.app, s.repo, x.path, x.suite, x.title);
          if (seen.has(id)) continue;
          seen.add(id);
          if (!exists.get(id)) added++;
          up.run({ id, app: s.app, title: x.title.slice(0, 300), suite: x.suite, code: x.name ?? null, framework: x.framework, repo: s.repo, ref: s.ref, path: x.path, line: x.line, url: `${s.htmlUrl}/blob/${s.sha}/${x.path}#L${x.line}`, scan: s.id, user: s.userId, t });
        }
        const read = new Set(s.readPaths);
        const listed = s.listedPaths ? new Set(s.listedPaths) : null;
        const old = db.prepare("SELECT id, path FROM test_cases WHERE application_id = ? AND repo = ? AND origin = 'repo_scan' AND status = 'active'").all(s.app, s.repo) as { id: string; path: string | null }[];
        const gone = old.filter((o) => !seen.has(o.id) && !!o.path && (read.has(o.path) || (listed !== null && !listed.has(o.path))));
        const rm = db.prepare("UPDATE test_cases SET status = 'removed', updated_at = ? WHERE id = ?");
        for (const g of gone) rm.run(t, g.id);
        const complete = !s.truncated && s.filesFailed === 0 && listed !== null;
        db.prepare(
          "UPDATE repo_scans SET status = 'done', sha = ?, ref = ?, files_found = ?, files_scanned = ?, files_failed = ?, tests_found = ?, tests_new = ?, tests_removed = ?, truncated = ?, complete = ?, ended_at = ? WHERE id = ?",
        ).run(s.sha, s.ref, s.filesFound, s.filesScanned, s.filesFailed, seen.size, added, gone.length, s.truncated ? 1 : 0, complete ? 1 : 0, t, s.id);
        audit('user', s.userId, 'hexa.scan', 'repository', s.repo, { app: s.app, found: seen.size, added, removed: gone.length, complete });
        return { found: seen.size, added, removed: gone.length, complete };
      })();
    },

    listScans(app: string, limit = 10): ScanRow[] {
      return (
        db
          .prepare('SELECT s.*, u.name AS user_name FROM repo_scans s JOIN users u ON u.id = s.started_by WHERE s.application_id = ? ORDER BY s.started_at DESC, s.rowid DESC LIMIT ?')
          .all(app, limit) as Row[]
      ).map((r) => ({
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
        filesFailed: r.files_failed == null ? null : Number(r.files_failed),
        complete: r.complete == null ? null : Number(r.complete) === 1,
        error: (r.error as string) ?? null,
        startedBy: String(r.user_name),
        startedAt: String(r.started_at),
        endedAt: (r.ended_at as string) ?? null,
      }));
    },

    hasUpload(app: string, filename: string) {
      return !!db.prepare('SELECT 1 FROM hexa_uploads WHERE application_id = ? AND filename = ?').get(app, filename);
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
      o: { app: string; origin: 'upload' | 'uat_analyst'; purposeDefault: 'uat' | 'regression' | null; filename: string; format: string; problems: { row: number; message: string }[]; userId: string },
    ) {
      return db.transaction(() => {
        const t = now();
        const uploadId = createHash('sha1').update(`${o.app}|${o.filename}|${t}|${Math.random()}`).digest('hex').slice(0, 16);
        const find = db.prepare('SELECT id, kind FROM test_cases WHERE application_id = ? AND external_id = ?');
        const storyExists = db.prepare('SELECT 1 FROM stories WHERE key = ? AND application_id = ?');
        const problems = [...o.problems];
        let created = 0;
        let updated = 0;
        for (const x of tests) {
          const existing = find.get(o.app, x.externalId) as { id: string; kind: string } | undefined;
          const id = existing?.id ?? manualId(o.app, x.externalId);
          const purpose = x.purpose ?? o.purposeDefault;
          if (existing) {
            // A proposed UAT case with this id becomes the manual test: the proposal is accepted in place,
            // keeping its id and links, so it is counted as created rather than updated.
            db.prepare(
              `UPDATE test_cases SET title = ?, description = ?, test_type = ?, purpose = ?, phase = ?, owner = ?, designer = ?, product_areas = ?, application_modules = ?, user_tags = ?, estimated_minutes = ?, status = 'active', upload_id = ?, updated_at = ?,
                 origin = CASE WHEN kind = 'proposed' THEN ? ELSE origin END, kind = 'manual' WHERE id = ?`,
            ).run(x.name, x.description, x.testType, purpose, x.phase, x.owner, x.designer, x.productAreas, x.applicationModules, x.userTags, x.estimatedMinutes, uploadId, t, o.origin, id);
            if (existing.kind === 'proposed') created++;
            else updated++;
          } else {
            db.prepare(
              `INSERT INTO test_cases (id, application_id, title, kind, purpose, origin, external_id, description, test_type, phase, owner, designer, product_areas, application_modules, user_tags, estimated_minutes, upload_id, created_by, created_at, updated_at)
               VALUES (?, ?, ?, 'manual', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            ).run(id, o.app, x.name, purpose, o.origin, x.externalId, x.description, x.testType, x.phase, x.owner, x.designer, x.productAreas, x.applicationModules, x.userTags, x.estimatedMinutes, uploadId, o.userId, t, t);
            created++;
          }
          db.prepare('DELETE FROM test_steps WHERE test_case_id = ?').run(id);
          const st = db.prepare('INSERT INTO test_steps (test_case_id, seq, step_type, description) VALUES (?, ?, ?, ?)');
          x.steps.forEach((s2, i) => st.run(id, i + 1, s2.type, s2.description));
          const link = db.prepare('INSERT OR IGNORE INTO test_case_links (test_case_id, entity_type, entity_ref) VALUES (?, ?, ?)');
          for (const ref of x.covers) {
            const crit = /^([A-Z][A-Z0-9]+-\d+)#(AC\d+)$/.exec(ref);
            if (crit && storyExists.get(crit[1], o.app)) {
              link.run(id, 'story', crit[1]);
              link.run(id, 'criterion', ref);
            } else if (storyExists.get(ref, o.app)) link.run(id, 'story', ref);
            else if (/^N?FR-\d+$/.test(ref)) {
              db.prepare('INSERT OR IGNORE INTO requirements (id, application_id) VALUES (?, ?)').run(ref, o.app);
              link.run(id, 'requirement', ref);
            } else if (q.componentByName.get(o.app, ref)) link.run(id, 'component', componentId(o.app, ref));
            else problems.push({ row: 0, message: `"${x.name}" covers "${ref}", which is not a known story, requirement or component of this application; not linked.` });
          }
        }
        db.prepare('INSERT INTO hexa_uploads (id, application_id, kind, filename, format, created, updated, problems, uploaded_by, uploaded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
          uploadId,
          o.app,
          'manual_tests',
          o.filename.slice(0, 200),
          o.format,
          created,
          updated,
          JSON.stringify(problems.slice(0, 100)),
          o.userId,
          t,
        );
        audit('user', o.userId, 'hexa.upload_manual', 'upload', uploadId, { app: o.app, created, updated, problems: problems.length });
        return { uploadId, created, updated, problems };
      })();
    },

    /** Automated tests in an application's repo (or all its repos), for matching CI results. */
    automatedCandidates(app: string, repo: string | null) {
      const rows = (
        repo
          ? db.prepare("SELECT id, suite, code_name, title, path FROM test_cases WHERE application_id = ? AND kind = 'automated' AND status = 'active' AND repo = ?").all(app, repo)
          : db.prepare("SELECT id, suite, code_name, title, path FROM test_cases WHERE application_id = ? AND kind = 'automated' AND status = 'active'").all(app)
      ) as Row[];
      return rows.map((r) => ({ id: String(r.id), suite: (r.suite as string) ?? null, codeName: (r.code_name as string) ?? null, title: String(r.title), path: (r.path as string) ?? null }));
    },

    /** Whether this delivery was already recorded: the same application, source, repository, run and attempt. */
    runExists(app: string, source: string, repo: string | null, externalRunId: string, attempt = 1) {
      return !!db.prepare('SELECT 1 FROM test_runs WHERE application_id = ? AND source = ? AND repo IS ? AND external_run_id = ? AND attempt = ?').get(app, source, repo, externalRunId, attempt);
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
        const runId = createHash('sha1').update(`${meta.app}|${meta.source}|${meta.repo}|${meta.externalRunId ?? t}|${meta.attempt}|${Math.random()}`).digest('hex').slice(0, 16);
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
                 VALUES (?, ?, ?, ?, ?, 'automated', ?, 'ci_results', ?, ?, ?, ?, ?)`,
              )
              .run(id, meta.app, r.create.title.slice(0, 300), r.create.suite, r.create.codeName, meta.framework?.trim() || 'JUnit XML', meta.repo, r.create.path, userId, t, t);
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
          `INSERT INTO test_runs (id, application_id, source, repo, workflow, external_run_id, attempt, run_url, event, branch, sha, pr_number, is_merge, status, total, passed, failed, skipped, duration_ms, started_at, ingested_by, ingested_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(runId, meta.app, meta.source, meta.repo, meta.workflow, meta.externalRunId, meta.attempt, meta.runUrl, meta.event, meta.branch, meta.sha, meta.prNumber, meta.isMerge ? 1 : 0, counts.failed ? 'failed' : 'passed', total, counts.passed, counts.failed, counts.skipped, duration, runAt, userId, t);
        const res = db.prepare('INSERT INTO test_results (run_id, test_case_id, status, duration_ms, message) VALUES (?, ?, ?, ?, ?)');
        const last = db.prepare('UPDATE test_cases SET last_result = ?, last_run_at = ?, updated_at = ? WHERE id = ? AND (last_run_at IS NULL OR last_run_at <= ?)');
        for (const r of seen.values()) {
          res.run(runId, r.testCaseId, r.status, r.durationMs, r.message);
          last.run(r.status, runAt, t, r.testCaseId, runAt);
        }
        audit('user', userId, 'hexa.ingest_run', 'test_run', runId, { app: meta.app, source: meta.source, repo: meta.repo, total, failed: counts.failed, created });
        return { runId, total, matched, created, ...counts };
      })();
    },

    listRuns(app: string, limit = 20) {
      return (
        db
          .prepare('SELECT r.*, u.name AS user_name FROM test_runs r LEFT JOIN users u ON u.id = r.ingested_by WHERE r.application_id = ? ORDER BY COALESCE(r.started_at, r.ingested_at) DESC, r.rowid DESC LIMIT ?')
          .all(app, limit) as Row[]
      ).map((r) => ({
        id: String(r.id),
        source: String(r.source),
        repo: (r.repo as string) ?? null,
        workflow: (r.workflow as string) ?? null,
        runUrl: (r.run_url as string) ?? null,
        branch: (r.branch as string) ?? null,
        sha: (r.sha as string) ?? null,
        prNumber: r.pr_number == null ? null : Number(r.pr_number),
        attempt: Number(r.attempt ?? 1),
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
        applicationId: String(r.application_id),
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

    /** Links a test to a story, criterion, requirement or component; `remove` unlinks. */
    linkTest(testCaseId: string, type: 'story' | 'criterion' | 'requirement' | 'component', ref: string, by: string, remove = false) {
      if (remove) db.prepare('DELETE FROM test_case_links WHERE test_case_id = ? AND entity_type = ? AND entity_ref = ?').run(testCaseId, type, ref);
      else db.prepare('INSERT OR IGNORE INTO test_case_links (test_case_id, entity_type, entity_ref) VALUES (?, ?, ?)').run(testCaseId, type, ref);
      // A criterion link implies the story link.
      if (!remove && type === 'criterion') db.prepare('INSERT OR IGNORE INTO test_case_links (test_case_id, entity_type, entity_ref) VALUES (?, ?, ?)').run(testCaseId, 'story', ref.split('#')[0]);
      db.prepare('UPDATE test_cases SET updated_at = ? WHERE id = ?').run(now(), testCaseId);
      audit('user', by, remove ? 'hexa.unlink' : 'hexa.link', 'test_case', testCaseId, { type, ref });
    },

    /**
     * The build evidence is read from for a repository: its latest merge-commit run (the latest
     * attempt), or the latest run of any kind when no merge run was recorded. Null when nothing ran.
     */
    targetBuild(app: string, repo: string | null): EvidenceBuild | null {
      const r = db
        .prepare(
          `SELECT id, repo, sha, branch, pr_number, external_run_id, attempt, COALESCE(started_at, ingested_at) AS at
           FROM test_runs WHERE application_id = ? AND repo IS ? ORDER BY is_merge DESC, at DESC, attempt DESC, rowid DESC LIMIT 1`,
        )
        .get(app, repo) as Row | undefined;
      if (!r) return null;
      const pr = r.pr_number == null ? null : Number(r.pr_number);
      const attempt = Number(r.attempt ?? 1);
      const sha = (r.sha as string) ?? null;
      const branch = (r.branch as string) ?? null;
      const where = [sha ? sha.slice(0, 7) : null, branch].filter(Boolean).join(', ');
      const label = `${pr ? `PR #${pr}` : `run ${(r.external_run_id as string) ?? String(r.id).slice(0, 7)}`}${attempt > 1 ? ` attempt ${attempt}` : ''}${where ? ` (${where})` : ''}`;
      return { runId: String(r.id), repo: (r.repo as string) ?? null, sha, branch, prNumber: pr, attempt, at: String(r.at), label };
    },

    /**
     * What Hexa knows about each acceptance criterion of a story, read against the target build of
     * each linked test's repository, never from a cached last result:
     *   failing   a linked automated test failed in the target build (a failure is never hidden by another test's pass)
     *   passing   a linked automated test passed in the target build
     *   not-run   linked tests exist but none passed there: skipped, missing from that build (an older pass does not
     *             count), no run recorded for the repository, or only manual tests
     *   no-test   nothing linked. Proposed UAT cases are drafts and never count.
     */
    coverageFor(storyKey: string): CriterionCoverage[] {
      const story = getStory(storyKey);
      if (!story) return [];
      const linked = db.prepare(
        `SELECT t.id, t.title, t.kind, t.repo FROM test_case_links l JOIN test_cases t ON t.id = l.test_case_id
         WHERE l.entity_type = 'criterion' AND l.entity_ref = ? AND t.status = 'active' AND t.kind != 'proposed' ORDER BY t.kind, t.title`,
      );
      const inRun = db.prepare('SELECT status FROM test_results WHERE run_id = ? AND test_case_id = ?');
      const builds = new Map<string, EvidenceBuild | null>();
      const buildFor = (repo: string | null) => {
        const key = repo ?? '';
        if (!builds.has(key)) builds.set(key, this.targetBuild(story.applicationId, repo));
        return builds.get(key) ?? null;
      };
      const one = (list: { id: string }[]) => (list.length === 1 ? list[0].id : `${list.length} tests`);
      return story.acceptanceCriteria.map((_, i) => {
        const rows = linked.all(`${storyKey}#AC${i + 1}`) as Row[];
        const tests = rows.map((r) => {
          const kind = String(r.kind);
          if (kind !== 'automated') return { id: String(r.id), title: String(r.title), kind, result: 'manual' as EvidenceResult, build: null };
          const build = buildFor((r.repo as string) ?? null);
          const res = build ? (inRun.get(build.runId, r.id) as { status: EvidenceResult } | undefined) : undefined;
          const result: EvidenceResult = !build ? 'not_run' : (res?.status ?? 'missing');
          return { id: String(r.id), title: String(r.title), kind, result, build };
        });
        const used = [...new Map(tests.flatMap((t) => (t.build ? [[t.build.runId, t.build] as const] : []))).values()];
        const out = (status: CriterionStatus, evidence: string): CriterionCoverage => ({ status, evidence, tests: tests.map(({ build: _b, ...t }) => t), builds: used });
        const by = (result: EvidenceResult) => tests.filter((t) => t.result === result);
        const label = (t: { build: EvidenceBuild | null }) => t.build?.label ?? 'the target build';
        const failed = by('failed');
        if (failed.length) return out('failing', `${one(failed)} failed in ${label(failed[0])}`);
        const passed = by('passed');
        const missing = by('missing');
        const skipped = by('skipped');
        if (passed.length) {
          const rest = [missing.length && `${one(missing)} not in that run`, skipped.length && `${one(skipped)} skipped`].filter(Boolean).join('; ');
          return out('passing', `${one(passed)} passed in ${label(passed[0])}${rest ? ` (${rest})` : ''}`);
        }
        if (missing.length) return out('not-run', `${one(missing)} not in ${label(missing[0])}; an earlier pass does not count`);
        if (skipped.length) return out('not-run', `${one(skipped)} skipped in ${label(skipped[0])}`);
        const noRun = by('not_run');
        if (noRun.length) return out('not-run', `${one(noRun)} exist${noRun.length === 1 ? 's' : ''} but no run has been recorded for the repository`);
        const manual = by('manual');
        if (manual.length) return out('not-run', `${one(manual)} manual, no automated result`);
        return out('no-test', 'No test linked to this criterion');
      });
    },

    /** Manual tests as rows for the Octane export. */
    manualForExport(app: string, ids?: string[]) {
      const rows = (
        ids?.length
          ? db.prepare(`SELECT * FROM test_cases WHERE application_id = ? AND kind = 'manual' AND status = 'active' AND id IN (${ids.map(() => '?').join(', ')}) ORDER BY external_id`).all(app, ...ids)
          : db.prepare("SELECT * FROM test_cases WHERE application_id = ? AND kind = 'manual' AND status = 'active' ORDER BY external_id").all(app)
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

    listUploads(app: string, limit = 8) {
      return (
        db.prepare('SELECT h.*, u.name AS user_name FROM hexa_uploads h JOIN users u ON u.id = h.uploaded_by WHERE h.application_id = ? ORDER BY uploaded_at DESC, h.rowid DESC LIMIT ?').all(app, limit) as Row[]
      ).map((r) => ({
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

    /**
     * UAT cases the UAT analyst proposed for a story's gaps, kept in Hexa as proposed until someone
     * approves them. The case id (UAT-<story key>-<criterion>) is the Octane unique_id, so the row id
     * is the same one the accepted manual test gets, and approval converts the row in place. A row
     * already accepted is never touched by a later proposal.
     */
    upsertProposedCases(storyKey: string, cases: { id: string; title: string; criterion: string; steps?: string[] }[], userId: string) {
      const t = now();
      const story = getStory(storyKey);
      if (!story) return [];
      return db.transaction(() => {
        const up = db.prepare(
          `INSERT INTO test_cases (id, application_id, title, kind, purpose, origin, status, external_id, test_type, created_by, created_at, updated_at)
           VALUES (?, ?, ?, 'proposed', 'uat', 'uat_analyst', 'active', ?, 'Acceptance', ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET title = excluded.title, status = 'active', updated_at = excluded.updated_at WHERE test_cases.kind = 'proposed'`,
        );
        const kind = db.prepare('SELECT kind FROM test_cases WHERE id = ?');
        const link = db.prepare('INSERT OR IGNORE INTO test_case_links (test_case_id, entity_type, entity_ref) VALUES (?, ?, ?)');
        const st = db.prepare('INSERT INTO test_steps (test_case_id, seq, step_type, description) VALUES (?, ?, ?, ?)');
        const ids: string[] = [];
        for (const c of cases) {
          const id = manualId(story.applicationId, c.id);
          up.run(id, story.applicationId, c.title, c.id, userId, t, t);
          if ((kind.get(id) as { kind: string } | undefined)?.kind !== 'proposed') continue;
          ids.push(id);
          link.run(id, 'story', storyKey);
          link.run(id, 'criterion', `${storyKey}#${c.criterion}`);
          for (const comp of story.components) link.run(id, 'component', componentId(story.applicationId, comp));
          if (c.steps?.length) {
            db.prepare('DELETE FROM test_steps WHERE test_case_id = ?').run(id);
            c.steps.forEach((s, i) => st.run(id, i + 1, i === c.steps!.length - 1 || /^check\b/i.test(s) ? 'validation' : 'simple', s));
          }
        }
        return ids;
      })();
    },

    /* ---------- Answers, ratings, approvals ---------- */

    /**
     * Saves the final answer to a user message as a new, immutable revision, with its citations,
     * artifact and approvals. The revision number is allocated here, inside the transaction, so two
     * runs for the same answer never share one. Each approval freezes the exact payload it was shown
     * with, and the artifact is stored under this revision. Earlier pending approvals of the same
     * answer are superseded: only the revision the person can see is actionable.
     */
    saveAnswer(a: {
      app: string;
      chatId: string;
      answerId: string;
      userMessageId: string;
      workflowRunId: string | null;
      userId: string;
      status: string;
      intent: Intent | undefined;
      blocks: Block[];
      citations: Citation[];
      artifact: Artifact | null;
    }) {
      return db.transaction(() => {
        const t = now();
        const chat = getChat(a.chatId);
        if (!chat) throw new OwnershipError(`Chat ${a.chatId} does not exist.`);
        if (chat.applicationId !== a.app) throw new OwnershipError(`Chat ${a.chatId} belongs to another application.`);
        const existing = db.prepare('SELECT chat_id, role FROM messages WHERE id = ?').get(a.answerId) as Row | undefined;
        if (existing && (existing.chat_id !== a.chatId || existing.role !== 'assistant')) throw new OwnershipError(`Message ${a.answerId} is not an answer in chat ${a.chatId}.`);
        if (!existing) {
          const { seq } = db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM messages WHERE chat_id = ?').get(a.chatId) as { seq: number };
          db.prepare("INSERT INTO messages (id, chat_id, seq, role, text, created_by, created_at) VALUES (?, ?, ?, 'assistant', '', ?, ?)").run(a.answerId, a.chatId, seq, a.userId, t);
        }
        const { revision } = db.prepare('SELECT COALESCE(MAX(revision), 0) + 1 AS revision FROM answer_revisions WHERE message_id = ?').get(a.answerId) as { revision: number };
        const revisionId = `${a.answerId}-r${revision}`;
        const approvals: { index: number; id: string }[] = [];
        const blocks = a.blocks.map((b, i) => {
          if (b.kind !== 'approval') return b;
          const id = `${revisionId}-a${i}`;
          approvals.push({ index: i, id });
          return { ...b, approval: { ...b.approval, id } };
        });
        db.prepare('INSERT INTO answer_revisions (id, message_id, revision, status, intent, blocks, workflow_run_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
          revisionId,
          a.answerId,
          revision,
          a.status,
          a.intent ? JSON.stringify(a.intent) : null,
          JSON.stringify(blocks),
          a.workflowRunId,
          t,
        );
        // A citation with a place in Catalyzt keeps its link, so a reloaded chat opens the same passage.
        const cit = db.prepare('INSERT INTO citations (revision_id, n, source_type, source_ref, title, detail) VALUES (?, ?, ?, ?, ?, ?)');
        for (const c of a.citations) cit.run(revisionId, c.n, c.href ? 'link' : 'citation', c.href ?? String(c.n), c.title, c.detail);
        if (a.artifact) {
          db.prepare('INSERT INTO artifacts (id, chat_id, revision_id, local_id, kind, title, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
            `${revisionId}/${a.artifact.id}`,
            a.chatId,
            revisionId,
            a.artifact.id,
            a.artifact.kind === 'uat' ? 'uat_report' : 'code',
            a.artifact.title,
            JSON.stringify(a.artifact),
            t,
          );
        }
        db.prepare(
          `UPDATE approvals SET status = 'expired', superseded_by = ? WHERE status = 'pending'
             AND revision_id IN (SELECT id FROM answer_revisions WHERE message_id = ? AND id != ?)`,
        ).run(revisionId, a.answerId, revisionId);
        const ap = db.prepare("INSERT INTO approvals (id, revision_id, action, target, facts, payload, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)");
        for (const { index, id } of approvals) {
          const b = blocks[index];
          if (b.kind !== 'approval') continue;
          const action = b.approval.action && ['open_pr', 'add_uat_cases', 'gitops_change'].includes(b.approval.action) ? b.approval.action : 'other';
          const uat = a.artifact?.kind === 'uat' && b.approval.artifactId === a.artifact.id ? a.artifact : null;
          const payload: ApprovalPayload =
            action === 'add_uat_cases' && uat
              ? { storyKey: uat.ticketKey, artifactId: uat.id, cases: uat.proposedCases, components: (q.components.all(uat.ticketKey) as { name: string }[]).map((x) => x.name) }
              : {};
          ap.run(id, revisionId, action, JSON.stringify({ artifactId: b.approval.artifactId ?? null, storyKey: uat?.ticketKey ?? null }), JSON.stringify(b.approval.facts), JSON.stringify(payload), t);
        }
        // A newer UAT analysis of the same story, in any chat of the application, supersedes older pending
        // proposals for it: they describe evidence that has since been re-read (R15).
        if (a.artifact?.kind === 'uat') {
          db.prepare(
            `UPDATE approvals SET status = 'expired', superseded_by = ? WHERE status = 'pending' AND action = 'add_uat_cases' AND revision_id != ?
               AND json_extract(payload, '$.storyKey') = ?
               AND revision_id IN (SELECT ar.id FROM answer_revisions ar JOIN messages m ON m.id = ar.message_id JOIN chats c ON c.id = m.chat_id
                                   WHERE c.application_id = (SELECT application_id FROM chats WHERE id = ?))`,
          ).run(revisionId, revisionId, a.artifact.ticketKey, a.chatId);
        }
        if (a.workflowRunId) db.prepare('UPDATE workflow_runs SET revision = ? WHERE id = ?').run(revision, a.workflowRunId);
        db.prepare('UPDATE chats SET updated_at = ? WHERE id = ?').run(t, a.chatId);
        return { revisionId, revision, approvals };
      })();
    },

    /** A chat with its messages and the latest revision of each answer, in the browser's shape. */
    getChatFull(chatId: string, forUser: string) {
      const c = db
        .prepare('SELECT c.*, w.name AS workspace_name, a.name AS app_name FROM chats c LEFT JOIN workspaces w ON w.id = c.workspace_id JOIN applications a ON a.id = c.application_id WHERE c.id = ?')
        .get(chatId) as Row | undefined;
      if (!c) return undefined;
      const rows = db.prepare('SELECT * FROM messages WHERE chat_id = ? ORDER BY seq').all(chatId) as Row[];
      const items = db.prepare('SELECT item_type AS type, item_ref AS ref FROM message_items WHERE message_id = ?');
      const files = db.prepare("SELECT a.id, a.filename, a.status FROM message_items i JOIN attachments a ON a.id = i.item_ref WHERE i.message_id = ? AND i.item_type = 'file' ORDER BY a.created_at");
      const latest = db.prepare('SELECT * FROM answer_revisions WHERE message_id = ? ORDER BY revision DESC LIMIT 1');
      const cits = db.prepare("SELECT n, title, detail, CASE WHEN source_type = 'link' THEN source_ref END AS href FROM citations WHERE revision_id = ? ORDER BY n");
      const rating = db.prepare('SELECT stars FROM ratings WHERE revision_id = ? AND user_id = ?');
      const approvalRows = db.prepare('SELECT id, status, decided_by, decided_at, outcome FROM approvals WHERE revision_id = ?');
      const artifactRows = db.prepare('SELECT body FROM artifacts WHERE revision_id = ?');
      // Artifacts of the revisions shown, keyed by their local id, so the latest revision wins.
      const artifacts: Record<string, Artifact> = {};
      const messages: Message[] = rows.flatMap((m): Message[] => {
        if (m.role === 'user') {
          const its = items.all(m.id) as { type: string; ref: string }[];
          return [
            {
              id: String(m.id),
              role: 'user' as const,
              text: m.removed_reason ? '[Message removed: it contained a secret]' : String(m.text),
              testType: (m.test_type as 'uat' | 'regression' | null) ?? null,
              tickets: its.filter((i) => i.type === 'story').map((i) => i.ref),
              components: its.filter((i) => i.type === 'component').map((i) => i.ref),
              attachments: files.all(m.id) as { id: string; filename: string; status: 'ready' | 'stored' | 'failed' }[],
            },
          ];
        }
        const r = latest.get(m.id) as Row | undefined;
        if (!r) return [];
        const aps = approvalRows.all(r.id) as Row[];
        const blocks = json<Block[]>(r.blocks, []).map((b) => {
          if (b.kind !== 'approval' || !b.approval.id) return b;
          const row = aps.find((x) => x.id === b.approval.id);
          if (!row) return b;
          return {
            ...b,
            approval: {
              ...b.approval,
              status: row.status as ApprovalStatus,
              decidedAt: (row.decided_at as string) ?? undefined,
              decidedBy: row.decided_by ? getUser(String(row.decided_by))?.name : undefined,
              outcome: json<ApprovalOutcome | null>(row.outcome, null) ?? undefined,
            },
          };
        });
        for (const art of artifactRows.all(r.id) as Row[]) {
          const body = json<Artifact | null>(art.body, null);
          if (body) artifacts[body.id] = body;
        }
        const intent = json<Intent | undefined>(r.intent, undefined);
        return [
          {
            id: String(m.id),
            role: 'assistant' as const,
            capability: intent?.capability ?? null,
            revision: Number(r.revision),
            revisionId: String(r.id),
            rating: (rating.get(r.id, forUser) as { stars: number } | undefined)?.stars ?? null,
            citations: (cits.all(r.id) as (Citation & { href: string | null })[]).map((c) => ({ n: c.n, title: c.title, detail: c.detail, ...(c.href ? { href: c.href } : {}) })),
            blocks,
            status: r.status as 'working' | 'streaming' | 'done' | 'error' | 'stopped',
            intent,
          },
        ];
      });
      return {
        id: chatId,
        applicationId: String(c.application_id),
        title: String(c.title),
        agent: String(c.agent),
        scope: { appName: String(c.app_name), appId: String(c.application_id), workspace: (c.workspace_name as string) ?? '' },
        testType: (c.test_type as 'uat' | 'regression' | null) ?? null,
        createdBy: String(c.created_by),
        messages,
        artifacts,
      };
    },

    /** The chat and application a revision belongs to. */
    revisionChat(revisionId: string) {
      const r = db
        .prepare('SELECT m.chat_id, c.application_id, json_extract(ar.intent, \'$.capability\') AS capability FROM answer_revisions ar JOIN messages m ON m.id = ar.message_id JOIN chats c ON c.id = m.chat_id WHERE ar.id = ?')
        .get(revisionId) as Row | undefined;
      return r ? { chatId: String(r.chat_id), app: String(r.application_id), capability: (r.capability as string) ?? null } : undefined;
    },

    /** One rating per person per revision; rating again replaces it. */
    rateAnswer(r: { revisionId: string; userId: string; stars: number; reasons: string[]; comment: string | null }) {
      db.prepare(
        `INSERT INTO ratings (revision_id, user_id, stars, reasons, comment, created_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(revision_id, user_id) DO UPDATE SET stars = excluded.stars, reasons = excluded.reasons, comment = excluded.comment, created_at = excluded.created_at`,
      ).run(r.revisionId, r.userId, r.stars, JSON.stringify(r.reasons), r.comment, now());
    },
    hasRating(revisionId: string, userId: string) {
      return !!db.prepare('SELECT 1 FROM ratings WHERE revision_id = ? AND user_id = ?').get(revisionId, userId);
    },

    /** Reasons given with low ratings in an application lately, grouped, for the feedback-pattern rule. */
    lowRatingPatterns(app: string, days = 7, atLeast = 3) {
      return db
        .prepare(
          `SELECT COALESCE(json_extract(ar.intent, '$.capability'), 'unknown') AS capability, je.value AS reason, COUNT(*) AS count
           FROM ratings r JOIN answer_revisions ar ON ar.id = r.revision_id JOIN messages m ON m.id = ar.message_id JOIN chats c ON c.id = m.chat_id, json_each(r.reasons) je
           WHERE c.application_id = ? AND r.stars < 4 AND r.created_at >= ?
           GROUP BY capability, reason HAVING COUNT(*) >= ? ORDER BY count DESC`,
        )
        .all(app, daysAgo(days), atLeast) as { capability: string; reason: string; count: number }[];
    },

    getApproval,
    /**
     * Decides a pending approval. For an approved local action, `execute` runs inside the same
     * transaction as the status change and the audit row: either all of it is recorded or none of
     * it is (a failed action leaves the approval pending, with no claim of success), and a second
     * decision arriving at the same time finds the approval already decided and gets its outcome.
     */
    decideApproval(id: string, decision: 'approved' | 'declined', userId: string, execute?: (payload: ApprovalPayload) => ApprovalOutcome) {
      return db.transaction(() => {
        const a = getApproval(id);
        if (!a) return { kind: 'missing' as const, approval: undefined };
        if (a.status !== 'pending') return { kind: 'already' as const, approval: a };
        const t = now();
        const outcome = decision === 'approved' && execute ? execute(a.payload) : null;
        const info = db
          .prepare("UPDATE approvals SET status = ?, decided_by = ?, decided_at = ?, outcome = ?, executed_at = ? WHERE id = ? AND status = 'pending'")
          .run(decision, userId, t, outcome ? JSON.stringify(outcome) : null, outcome ? t : null, id);
        if (!info.changes) return { kind: 'already' as const, approval: getApproval(id)! };
        audit('user', userId, `approval.${decision}`, 'approval', id, { revisionId: a.revisionId, outcome });
        return { kind: 'decided' as const, approval: getApproval(id)! };
      })();
    },
    /** Approvals still waiting in an application, newest first, with the chat they live in. */
    listPendingApprovals(app: string, limit = 20) {
      return (
        db
          .prepare(
            `SELECT a.id, a.action, a.target, a.created_at, ar.revision, m.chat_id, c.title AS chat_title, u.name AS asked_by FROM approvals a
             JOIN answer_revisions ar ON ar.id = a.revision_id JOIN messages m ON m.id = ar.message_id JOIN chats c ON c.id = m.chat_id JOIN users u ON u.id = c.created_by
             WHERE c.application_id = ? AND a.status = 'pending' ORDER BY a.created_at DESC LIMIT ?`,
          )
          .all(app, limit) as Row[]
      ).map((r) => ({
        id: String(r.id),
        action: String(r.action),
        storyKey: json<{ storyKey?: string | null }>(r.target, {}).storyKey ?? null,
        revision: Number(r.revision),
        chatId: String(r.chat_id),
        chatTitle: String(r.chat_title),
        askedBy: String(r.asked_by),
        createdAt: String(r.created_at),
      }));
    },

    /** The artifact exactly as a revision stored it. */
    getArtifact(revisionId: string, localId: string): Artifact | undefined {
      const r = db.prepare('SELECT body FROM artifacts WHERE id = ?').get(`${revisionId}/${localId}`) as Row | undefined;
      return r ? json<Artifact | undefined>(r.body, undefined) : undefined;
    },

    /* ---------- Attachments ---------- */
    addAttachment(a: { id: string; app: string; chatId: string | null; filename: string; mime: string; size: number; sha256: string; storageKey: string; status: 'ready' | 'stored' | 'failed'; note: string | null; text: string | null; userId: string }) {
      db.transaction(() => {
        db.prepare(
          `INSERT INTO attachments (id, application_id, chat_id, filename, mime, size, sha256, storage_key, status, note, text_chars, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(a.id, a.app, a.chatId, a.filename, a.mime, a.size, a.sha256, a.storageKey, a.status, a.note, a.text?.length ?? 0, a.userId, now());
        if (a.text) db.prepare('INSERT INTO attachment_text (attachment_id, text) VALUES (?, ?)').run(a.id, a.text);
        audit('user', a.userId, 'attachment.add', 'attachment', a.id, { app: a.app, filename: a.filename, size: a.size, status: a.status });
      })();
    },
    getAttachment(id: string) {
      const r = db.prepare('SELECT * FROM attachments WHERE id = ?').get(id) as Row | undefined;
      if (!r) return undefined;
      return {
        id,
        applicationId: String(r.application_id),
        chatId: (r.chat_id as string) ?? null,
        filename: String(r.filename),
        mime: String(r.mime),
        size: Number(r.size),
        sha256: String(r.sha256),
        storageKey: String(r.storage_key),
        status: r.status as 'ready' | 'stored' | 'failed',
        note: (r.note as string) ?? null,
        textChars: Number(r.text_chars),
        createdBy: String(r.created_by),
        createdAt: String(r.created_at),
      };
    },
    attachmentText(id: string): string | null {
      return (db.prepare('SELECT text FROM attachment_text WHERE attachment_id = ?').get(id) as { text: string } | undefined)?.text ?? null;
    },
    /** Ties a free attachment to the chat it is first used in. */
    bindAttachment(id: string, chatId: string) {
      db.prepare('UPDATE attachments SET chat_id = ? WHERE id = ? AND chat_id IS NULL').run(chatId, id);
    },

    /** Marks anything left running (for example after a crash or restart) as stopped. */
    stopOrphans() {
      const t = now();
      db.prepare("UPDATE agent_runs SET status = 'stopped', ended_at = ? WHERE status = 'running'").run(t);
      db.prepare("UPDATE workflow_runs SET status = 'stopped', ended_at = ? WHERE status = 'running'").run(t);
      db.prepare("UPDATE agent_steps SET status = 'failed', ended_at = ? WHERE status = 'running'").run(t);
      db.prepare("UPDATE repo_scans SET status = 'failed', error = 'The server stopped during the scan', ended_at = ? WHERE status = 'running'").run(t);
    },

    /** Agent activity in an application: everything running now, plus the most recent finished runs. */
    listAgentActivity(opts: { app?: string | null; recent?: number } = {}): AgentActivity[] {
      const app = opts.app ?? null;
      const rows = db
        .prepare(
          `SELECT a.*, p.agent AS parent_agent, u.id AS user_id, u.name AS user_name, u.initials AS user_initials, c.id AS chat_id, c.title AS chat_title
           FROM agent_runs a
           JOIN workflow_runs w ON w.id = a.workflow_run_id
           JOIN users u ON u.id = w.requested_by
           LEFT JOIN agent_runs p ON p.id = a.parent_id
           LEFT JOIN chats c ON c.id = w.chat_id
           WHERE (? IS NULL OR w.application_id = ?)
             AND (a.status = 'running'
              OR a.id IN (SELECT a2.id FROM agent_runs a2 JOIN workflow_runs w2 ON w2.id = a2.workflow_run_id WHERE a2.status != 'running' AND (? IS NULL OR w2.application_id = ?) ORDER BY a2.started_at DESC, a2.rowid DESC LIMIT ?))
           ORDER BY a.started_at DESC, a.rowid DESC`,
        )
        .all(app, app, app, app, opts.recent ?? 60) as Row[];
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

/**
 * Seeds the database from the workspace: applications, workspaces, people, memberships,
 * components, and each team's backlog. Safe to run on every start: records are added or
 * updated, never removed, and stories that already exist are left alone so edits persist.
 */
export function seedWorkspace(h: HorizonDb, ws: Workspace) {
  const db = h.raw;
  const t = now();
  const counts = { apps: 0, people: 0, components: 0, stories: 0 };
  db.transaction(() => {
    for (const team of ws.teams) {
      db.prepare(
        `INSERT INTO applications (id, name, jira_project, description) VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, jira_project = excluded.jira_project, description = excluded.description`,
      ).run(team.id, team.name, team.jiraProject, team.description);
      counts.apps++;
      for (const w of team.workspaces) db.prepare('INSERT OR IGNORE INTO workspaces (id, application_id, name) VALUES (?, ?, ?)').run(`${team.id}-${w}`, team.id, w);
      // Workspaces the team no longer lists are removed (R12: stale names leaked into scopes and answers);
      // chats and components that pointed at one fall back to the application.
      const keep = team.workspaces.map((w) => `${team.id}-${w}`);
      const marks = keep.map(() => '?').join(', ') || "''";
      db.prepare(`UPDATE chats SET workspace_id = NULL WHERE application_id = ? AND workspace_id IS NOT NULL AND workspace_id NOT IN (${marks})`).run(team.id, ...keep);
      db.prepare(`UPDATE components SET workspace_id = NULL WHERE application_id = ? AND workspace_id IS NOT NULL AND workspace_id NOT IN (${marks})`).run(team.id, ...keep);
      db.prepare(`DELETE FROM workspaces WHERE application_id = ? AND id NOT IN (${marks})`).run(team.id, ...keep);
    }
    for (const p of ws.people) {
      db.prepare(
        `INSERT INTO users (id, name, initials, email, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, initials = excluded.initials, email = excluded.email`,
      ).run(p.id, p.name, p.initials, p.email, t);
      counts.people++;
      if (ws.teams.some((x) => x.id === p.app)) {
        db.prepare('INSERT OR IGNORE INTO memberships (user_id, application_id, role) VALUES (?, ?, ?)').run(p.id, p.app, 'member');
        if (p.role !== 'member') db.prepare('INSERT OR IGNORE INTO memberships (user_id, application_id, role) VALUES (?, ?, ?)').run(p.id, p.app, p.role);
      }
    }
    for (const team of ws.teams) {
      for (const c of team.components) {
        const repo = team.repos.find((r) => r.name === c.repo);
        db.prepare(
          `INSERT INTO components (id, application_id, name, manager_id, workspace_id, repo, path, language, tests) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET manager_id = excluded.manager_id, workspace_id = excluded.workspace_id, repo = excluded.repo, path = excluded.path, language = excluded.language, tests = excluded.tests`,
        ).run(componentId(team.id, c.name), team.id, c.name, c.manager, team.workspaces.includes(c.workspace) ? `${team.id}-${c.workspace}` : null, repo?.github ?? c.repo, c.path, c.language, c.tests);
        counts.components++;
      }
      // The "last sync" is the last import of the backlog from the workspace (F22): every seed updates it.
      db.prepare('INSERT INTO jira_sync (application_id, project, statuses, every_minutes, last_sync_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(application_id) DO UPDATE SET last_sync_at = excluded.last_sync_at').run(
        team.id,
        team.jiraProject,
        JSON.stringify(['Ready for UAT', 'In Progress']),
        15,
        t,
      );
      // Keys are assigned in order after the highest existing number, so re-seeding never collides.
      let next = ((db.prepare('SELECT COALESCE(MAX(number), 1000) AS n FROM stories WHERE project = ?').get(team.jiraProject) as { n: number }).n ?? 1000) + 1;
      for (const s of team.stories) {
        const key = s.key ?? `${team.jiraProject}-${next}`;
        if (db.prepare('SELECT 1 FROM stories WHERE key = ?').get(key)) continue;
        if (!s.key) next++;
        const number = Number(key.split('-').pop());
        const assignee = s.assignee ? h.getUser(s.assignee) : undefined;
        const at = s.updatedDaysAgo != null ? daysAgo(s.updatedDaysAgo) : t;
        db.prepare(
          `INSERT INTO stories (key, application_id, project, number, summary, description, type, status, fix_version, assignee, assignee_id, purpose, source, created_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'jira_sync', ?, ?, ?)`,
        ).run(key, team.id, team.jiraProject, number, s.summary, s.description ?? '', s.type ?? 'Story', s.status ?? 'Ready for UAT', s.fixVersion ?? '', assignee?.name ?? '', assignee?.id ?? null, s.purpose ?? null, team.owner, at, at);
        const ac = db.prepare('INSERT INTO story_criteria (story_key, seq, text) VALUES (?, ?, ?)');
        s.acceptanceCriteria.forEach((c, i) => ac.run(key, i + 1, c));
        const sc = db.prepare('INSERT OR IGNORE INTO story_components (story_key, component_id) VALUES (?, ?)');
        for (const name of s.components ?? []) if (team.components.some((c) => c.name === name)) sc.run(key, componentId(team.id, name));
        for (const r of s.requirements ?? []) {
          db.prepare('INSERT OR IGNORE INTO requirements (id, application_id) VALUES (?, ?)').run(r, team.id);
          db.prepare('INSERT OR IGNORE INTO story_requirements (story_key, requirement_id) VALUES (?, ?)').run(key, r);
        }
        counts.stories++;
      }
    }
  })();
  return counts;
}
