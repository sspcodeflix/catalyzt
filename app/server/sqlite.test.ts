/**
 * SQLite as deployed: file-backed WAL, foreign keys on every connection, a bounded busy timeout,
 * one writer at a time with readers unblocked, restart recovery, online backup and restore, and
 * schema upgrades that keep identities and relationships (DEPLOYMENT.md, MIGRATION_NOTE.md).
 */
import Database from 'better-sqlite3';
import { copyFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { openDb, seedWorkspace } from './db';
import { FIXTURE, seedRefundTests } from './fixture';
import { MIGRATIONS } from './schema';

const fresh = () => join(mkdtempSync(join(tmpdir(), 'hz-sqlite-')), 'horizon.db');
const auditInsert = "INSERT INTO audit_log (at, actor_type, actor_ref, action, entity_type, entity_ref) VALUES ('t', 'system', 'test', ?, 'x', 'y')";

describe('connection settings', () => {
  it('runs file-backed databases in WAL mode with foreign keys, NORMAL sync and a 5 s busy timeout', () => {
    const db = openDb(fresh());
    expect(db.raw.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(db.raw.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(db.raw.pragma('synchronous', { simple: true })).toBe(1);
    expect(db.raw.pragma('busy_timeout', { simple: true })).toBe(5000);
    expect(db.raw.pragma('user_version', { simple: true })).toBe(MIGRATIONS.length);
    db.raw.close();
  });

  it('enforces foreign keys: a message cannot point at a chat that does not exist', () => {
    const db = openDb(fresh());
    seedWorkspace(db, FIXTURE);
    expect(() => db.raw.prepare("INSERT INTO messages (id, chat_id, seq, role, created_at) VALUES ('m', 'no-such-chat', 1, 'user', 't')").run()).toThrow(/FOREIGN KEY/);
    db.raw.close();
  });
});

describe('one writer, many readers', () => {
  it('a second connection reads while a write transaction is open, waits its busy timeout to write, and succeeds after the commit', () => {
    const path = fresh();
    const a = openDb(path);
    seedWorkspace(a, FIXTURE);
    const b = new Database(path, { timeout: 250 });
    try {
      a.raw.exec('BEGIN IMMEDIATE');
      a.raw.prepare(auditInsert).run('a-write');
      // WAL: readers are never blocked by the writer, and see the last committed state.
      expect((b.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n).toBe(FIXTURE.people.length);
      expect((b.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'a-write'").get() as { n: number }).n).toBe(0);
      // A second writer gets SQLITE_BUSY only after waiting its timeout.
      const t0 = Date.now();
      expect(() => b.prepare(auditInsert).run('b-write')).toThrow(/database is locked|SQLITE_BUSY/);
      expect(Date.now() - t0).toBeGreaterThanOrEqual(200);
      a.raw.exec('COMMIT');
      b.prepare(auditInsert).run('b-write');
      expect((a.raw.prepare("SELECT action FROM audit_log WHERE action LIKE '%-write' ORDER BY id").all() as { action: string }[]).map((r) => r.action)).toEqual(['a-write', 'b-write']);
    } finally {
      b.close();
      a.raw.close();
    }
  });
});

describe('restart recovery', () => {
  it('a process that stops mid-run leaves nothing permanently running', () => {
    const path = fresh();
    const a = openDb(path);
    seedWorkspace(a, FIXTURE);
    a.startWorkflow({ id: 'w', app: 'ABCD', chatId: null, messageId: null, revision: 1, userId: 'u-ram' });
    a.startAgent({ id: 'ag', workflowRunId: 'w', parentId: null, agent: 'Orchestrator', kind: 'orchestrator', task: 't', model: null });
    a.addStep({ id: 'st', agentRunId: 'ag', kind: 'rule', label: 'l' });
    a.startScan({ id: 'sc', app: 'ABCD', repo: 'acme/shop', ref: null, workflowRunId: 'w', userId: 'u-ram' });
    a.raw.close(); // no finish calls: the "crash"
    const b = openDb(path);
    b.stopOrphans(); // what bootstrap() does first
    expect(b.raw.prepare('SELECT status FROM workflow_runs').get()).toEqual({ status: 'stopped' });
    expect(b.raw.prepare('SELECT status FROM agent_runs').get()).toEqual({ status: 'stopped' });
    expect(b.raw.prepare('SELECT status FROM agent_steps').get()).toEqual({ status: 'failed' });
    expect(b.listScans('ABCD')[0]).toMatchObject({ status: 'failed', error: expect.stringMatching(/server stopped/) });
    b.raw.close();
  });
});

describe('backup and restore', () => {
  it('an online backup taken during a write is a consistent snapshot that restores into a working database', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hz-backup-'));
    const live = openDb(join(dir, 'live.db'));
    seedWorkspace(live, FIXTURE);
    seedRefundTests(live);
    const before = {
      users: (live.raw.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n,
      tests: live.listTests('ABCD').total,
      coverage: live.coverageFor('ABCD-1001').map((c) => c.status),
    };
    // A writer is mid-transaction on another connection while the backup runs.
    const writer = new Database(join(dir, 'live.db'));
    writer.exec('BEGIN IMMEDIATE');
    writer.prepare(auditInsert).run('during-backup');
    const backup = join(dir, 'backup.db');
    await live.raw.backup(backup);
    writer.exec('ROLLBACK');
    writer.close();

    const copy = new Database(backup, { readonly: true });
    expect(copy.pragma('integrity_check', { simple: true })).toBe('ok');
    expect(copy.pragma('user_version', { simple: true })).toBe(MIGRATIONS.length);
    expect((copy.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'during-backup'").get() as { n: number }).n).toBe(0);
    copy.close();

    // Restore = copy the file somewhere new and open it as the server would.
    const restoredPath = join(dir, 'restored.db');
    copyFileSync(backup, restoredPath);
    const restored = openDb(restoredPath);
    expect((restored.raw.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n).toBe(before.users);
    expect(restored.listTests('ABCD').total).toBe(before.tests);
    expect(restored.coverageFor('ABCD-1001').map((c) => c.status)).toEqual(before.coverage);
    expect(restored.raw.pragma('foreign_key_check')).toEqual([]);
    // And it is a working database, not a frozen one.
    restored.startWorkflow({ id: 'w-after', app: 'ABCD', chatId: null, messageId: null, revision: 1, userId: 'u-ram' });
    restored.raw.close();
    live.raw.close();
  });
});

describe('schema upgrades keep identities and relationships', () => {
  it('upgrades a version-6 database: artifacts move under their revision, approvals gain a frozen payload, runs gain attempts', () => {
    const path = fresh();
    const raw = new Database(path);
    raw.pragma('foreign_keys = ON');
    for (const m of MIGRATIONS.slice(0, 6)) raw.exec(m);
    raw.pragma('user_version = 6');
    raw.exec(`INSERT INTO applications (id, name, jira_project) VALUES ('APP', 'App', 'APP');
      INSERT INTO users VALUES ('u1', 'One', 'ON', 'one@example.com', 't');
      INSERT INTO memberships VALUES ('u1', 'APP', 'app_owner');
      INSERT INTO chats (id, application_id, title, created_by, created_at, updated_at) VALUES ('c1', 'APP', 'Old chat', 'u1', 't', 't');
      INSERT INTO messages (id, chat_id, seq, role, text, created_by, created_at) VALUES ('m1', 'c1', 1, 'user', 'hello', 'u1', 't');
      INSERT INTO messages (id, chat_id, seq, role, text, created_by, created_at) VALUES ('a1', 'c1', 2, 'assistant', '', 'u1', 't');
      INSERT INTO answer_revisions (id, message_id, revision, status, blocks, created_at) VALUES ('a1-r1', 'a1', 1, 'done', '[]', 't');
      INSERT INTO artifacts (id, chat_id, revision_id, kind, title, body, created_at) VALUES ('c1/uat-app-1', 'c1', 'a1-r1', 'uat_report', 'UAT', '{"id":"uat-app-1","kind":"uat"}', 't');
      INSERT INTO approvals (id, revision_id, action, target, status, created_at) VALUES ('a1-r1-a0', 'a1-r1', 'add_uat_cases', '{"storyKey":"APP-1"}', 'pending', 't');
      INSERT INTO test_runs (id, application_id, source, status, total, passed, failed, skipped, ingested_at, external_run_id, repo) VALUES ('r1', 'APP', 'webhook', 'passed', 1, 1, 0, 0, 't', '77', 'o/r');
      INSERT INTO test_cases (id, application_id, title, kind, origin, created_at, updated_at) VALUES ('UAT-1-1', 'APP', 'Old proposal', 'proposed', 'uat_analyst', 't', 't');`);
    raw.close();

    const db = openDb(path);
    expect(db.raw.pragma('user_version', { simple: true })).toBe(MIGRATIONS.length);
    expect(db.raw.pragma('foreign_key_check')).toEqual([]);
    expect(db.raw.prepare('SELECT id, local_id, revision_id FROM artifacts').get()).toEqual({ id: 'a1-r1/uat-app-1', local_id: 'uat-app-1', revision_id: 'a1-r1' });
    expect(db.getArtifact('a1-r1', 'uat-app-1')).toMatchObject({ id: 'uat-app-1' });
    // F27: a pending approval from before frozen payloads cannot execute; the upgrade expires it and says why.
    expect(db.getApproval('a1-r1-a0')).toMatchObject({ status: 'expired', payload: {}, target: { storyKey: 'APP-1' }, outcome: { ok: false, text: expect.stringMatching(/Expired on upgrade/) } });
    expect(db.raw.prepare('SELECT attempt FROM test_runs').get()).toEqual({ attempt: 1 });
    expect(db.runExists('APP', 'webhook', 'o/r', '77', 1)).toBe(true);
    // Old-style proposal ids are retired, not silently renamed, and the retirement is on record.
    expect(db.raw.prepare("SELECT status FROM test_cases WHERE id = 'UAT-1-1'").get()).toEqual({ status: 'removed' });
    expect(db.raw.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'hexa.proposal_retired'").get()).toEqual({ n: 1 });
    expect(db.raw.prepare("SELECT name FROM sqlite_master WHERE name IN ('attachments', 'attachment_text') ORDER BY name").all()).toEqual([{ name: 'attachment_text' }, { name: 'attachments' }]);
    db.raw.close();
  });
});
