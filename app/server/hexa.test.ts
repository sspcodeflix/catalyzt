import { describe, expect, it } from 'vitest';

import { seedWorkspace } from './db';
import { FIXTURE, fixtureDb, seedRefundTests } from './fixture';

interface ScanOpts {
  app?: string;
  readPaths?: string[];
  listedPaths?: string[] | null;
  filesFailed?: number;
  truncated?: boolean;
}

/** A complete scan by default: every file that holds a given test was listed and read. */
const scan = (db: ReturnType<typeof fixtureDb>, id: string, tests: { path: string; title: string }[], o: ScanOpts | string = {}) => {
  const opts: ScanOpts = typeof o === 'string' ? { app: o } : o;
  const app = opts.app ?? 'ABCD';
  const paths = [...new Set(tests.map((t) => t.path))];
  db.startWorkflow({ id: `w-${id}`, app, chatId: null, messageId: null, revision: 1, userId: 'u-ram' });
  db.startScan({ id, app, repo: 'acme/shop', ref: null, workflowRunId: `w-${id}`, userId: 'u-ram' });
  return db.completeScan({
    id,
    app,
    repo: 'acme/shop',
    ref: 'main',
    sha: 'abc1234',
    htmlUrl: 'https://github.com/acme/shop',
    filesFound: (opts.listedPaths ?? paths).length,
    filesScanned: (opts.readPaths ?? paths).length,
    filesFailed: opts.filesFailed ?? 0,
    truncated: opts.truncated ?? false,
    readPaths: opts.readPaths ?? paths,
    listedPaths: opts.listedPaths === undefined ? paths : opts.listedPaths,
    tests: tests.map((t, i) => ({ ...t, suite: null, framework: 'Jest/Mocha', line: i + 1 })),
    userId: 'u-ram',
  });
};

describe('F12: a scan only removes what it can prove is gone', () => {
  it('keeps tests in files it could not read or list; a complete scan removes absent tests', () => {
    const db = fixtureDb();
    scan(db, 's1', [{ path: 'a.test.ts', title: 'adds item' }, { path: 'b.test.ts', title: 'pays' }, { path: 'b.test.ts', title: 'refunds' }]);
    expect(db.listTests('ABCD').total).toBe(3);
    // b.test.ts could not be read: nothing from it is found, nothing from it is removed.
    const partial = scan(db, 's2', [{ path: 'a.test.ts', title: 'adds item' }], { readPaths: ['a.test.ts'], listedPaths: ['a.test.ts', 'b.test.ts'], filesFailed: 1, truncated: true });
    expect(partial).toMatchObject({ found: 1, removed: 0, complete: false });
    expect(db.listTests('ABCD').total).toBe(3);
    expect(db.listScans('ABCD')[0]).toMatchObject({ complete: false, filesFailed: 1, testsRemoved: 0 });
    // A listing GitHub cut short cannot prove a file is gone either.
    expect(scan(db, 's3', [{ path: 'a.test.ts', title: 'adds item' }], { readPaths: ['a.test.ts'], listedPaths: null, truncated: true })).toMatchObject({ removed: 0, complete: false });
    expect(db.listTests('ABCD').total).toBe(3);
    // A complete scan whose listing no longer has b.test.ts removes its two tests.
    expect(scan(db, 's4', [{ path: 'a.test.ts', title: 'adds item' }], { readPaths: ['a.test.ts'], listedPaths: ['a.test.ts'] })).toMatchObject({ removed: 2, complete: true });
    expect(db.listTests('ABCD').rows.map((r) => r.title)).toEqual(['adds item']);
  });
});

describe('Hexa inventory', () => {
  it('starts empty and fills from scans, links and runs', () => {
    const db = fixtureDb();
    expect(db.testStats('ABCD').total).toBe(0);
    const ids = seedRefundTests(db);
    const { rows } = db.listTests('ABCD', { q: 'ABCD-1001' });
    expect(rows.map((r) => r.id).sort()).toEqual([...ids].sort());
    expect(db.getTest(ids[0])?.lastResult).toBe('passed');
    expect(db.getTest(ids[2])?.lastResult).toBeNull();
    expect(db.coverageFor('ABCD-1001').map((c) => c.status)).toEqual(['passing', 'passing', 'not-run', 'no-test']);
  });

  it('keeps applications apart', () => {
    const db = fixtureDb();
    scan(db, 's1', [{ path: 'a.test.ts', title: 'adds item' }]);
    scan(db, 's2', [{ path: 'a.test.ts', title: 'adds item' }], 'IBGM');
    expect(db.listTests('ABCD').total).toBe(1);
    expect(db.listTests('IBGM').total).toBe(1);
    expect(db.listTests('ABCD').rows[0].id).not.toBe(db.listTests('IBGM').rows[0].id);
  });

  it('adds, updates and removes scanned tests without duplicates', () => {
    const db = fixtureDb();
    expect(scan(db, 's1', [{ path: 'a.test.ts', title: 'adds item' }, { path: 'a.test.ts', title: 'removes item' }, { path: 'a.test.ts', title: 'adds item' }])).toEqual({ found: 2, added: 2, removed: 0, complete: true });
    expect(scan(db, 's2', [{ path: 'a.test.ts', title: 'adds item' }, { path: 'b.test.ts', title: 'pays' }])).toEqual({ found: 2, added: 1, removed: 1, complete: true });
    const { rows, total } = db.listTests('ABCD', { repo: 'acme/shop' });
    expect(total).toBe(2);
    expect(rows.every((r) => r.url?.startsWith('https://github.com/acme/shop/blob/abc1234/'))).toBe(true);
    expect(db.listScans('ABCD')[0]).toMatchObject({ repo: 'acme/shop', status: 'done', testsNew: 1, testsRemoved: 1 });
  });

  it('treats % and _ in a search as plain text', () => {
    const db = fixtureDb();
    scan(db, 's1', [{ path: 'a.test.ts', title: '100% refund' }, { path: 'a.test.ts', title: '1000 refunds' }]);
    expect(db.listTests('ABCD', { q: '100%' }).rows.map((r) => r.title)).toEqual(['100% refund']);
  });

  it('keeps proposed UAT cases linked to the story, criterion and components', () => {
    const db = fixtureDb();
    db.upsertProposedCases('ABCD-1001', [{ id: 'UAT-1001-1', title: 'Partial refunds within 45 days', criterion: 'AC4' }], 'u-ram');
    db.upsertProposedCases('ABCD-1001', [{ id: 'UAT-1001-1', title: 'Partial refunds within 45 days', criterion: 'AC4' }], 'u-ram');
    const { rows } = db.listTests('ABCD', { kind: 'proposed' });
    expect(rows).toHaveLength(1);
    expect(rows[0].links).toEqual(
      expect.arrayContaining([
        { type: 'story', ref: 'ABCD-1001' },
        { type: 'criterion', ref: 'ABCD-1001#AC4' },
        { type: 'component', ref: 'ABCD/checkoutservice' },
      ]),
    );
    expect(db.testStats('ABCD').byKind).toEqual(expect.arrayContaining([{ key: 'proposed', n: 1 }]));
  });

  it('links and unlinks a test, and a criterion link implies the story', () => {
    const db = fixtureDb();
    scan(db, 's1', [{ path: 'a.test.ts', title: 'shows currency code' }]);
    const id = db.listTests('ABCD').rows[0].id;
    db.linkTest(id, 'criterion', 'ABCD-1002#AC2', 'u-sourav');
    expect(db.getTest(id)?.links).toEqual(expect.arrayContaining([{ type: 'criterion', ref: 'ABCD-1002#AC2' }, { type: 'story', ref: 'ABCD-1002' }]));
    expect(db.coverageFor('ABCD-1002').map((c) => c.status)).toEqual(['no-test', 'not-run']);
    db.linkTest(id, 'criterion', 'ABCD-1002#AC2', 'u-sourav', true);
    expect(db.getTest(id)?.links.some((l) => l.type === 'criterion')).toBe(false);
  });
});

describe('token ledger', () => {
  it('totals tokens by agent and model per application, and counts unreported calls', () => {
    const db = fixtureDb();
    db.startWorkflow({ id: 'w1', app: 'ABCD', chatId: null, messageId: null, revision: 1, userId: 'u-ram' });
    db.startWorkflow({ id: 'w2', app: 'IBGM', chatId: null, messageId: null, revision: 1, userId: 'u-nabih' });
    const base = { agentRunId: null, latencyMs: 10, status: 'ok' as const };
    db.recordModelCall({ ...base, workflowRunId: 'w1', userId: 'u-ram', agent: 'Router', model: 'deepseek-flash', purpose: 'intent', promptTokens: 800, completionTokens: 60 });
    db.recordModelCall({ ...base, workflowRunId: 'w1', userId: 'u-ram', agent: 'CloudOps agent', model: 'deepseek-flash', purpose: 'answer', promptTokens: 1200, completionTokens: 300 });
    db.recordModelCall({ ...base, workflowRunId: 'w1', userId: 'u-ram', agent: 'CloudOps agent', model: 'deepseek-flash', purpose: 'answer', status: 'stopped', promptTokens: null, completionTokens: null });
    db.recordModelCall({ ...base, workflowRunId: 'w2', userId: 'u-nabih', agent: 'Router', model: 'deepseek-flash', purpose: 'intent', promptTokens: 500, completionTokens: 50 });
    const u = db.usage('ABCD');
    expect(u.allTime).toEqual({ calls: 3, prompt: 2000, completion: 360, total: 2360, unreported: 1 });
    expect(u.byAgent.map((r) => [r.key, r.total])).toEqual([
      ['CloudOps agent', 1500],
      ['Router', 860],
    ]);
    expect(u.byUser[0]).toMatchObject({ key: 'Ram Kumar', total: 2360 });
    expect(db.usage('IBGM').allTime.total).toBe(550);
    expect(db.usage().allTime.total).toBe(2910);
  });
});

describe('workspace seeding', () => {
  it('seeds people, roles, components and stories, and is safe to repeat', () => {
    const db = fixtureDb();
    expect(db.appsFor('u-sourav').map((a) => [a.id, a.roles.sort()])).toEqual([['ABCD', ['component_manager', 'member']]]);
    expect(db.appsFor('u-nabih')[0].roles).toContain('app_owner');
    expect(db.isMember('u-nabih', 'ABCD')).toBe(false);
    expect(db.getApp('ABCD')?.components.map((c) => [c.name, c.managerName])).toEqual([
      ['checkoutservice', 'Sourav'],
      ['frontend', 'Sourav'],
    ]);
    const s = db.getStory('ABCD-1001')!;
    expect(s).toMatchObject({ applicationId: 'ABCD', components: ['checkoutservice'], requirements: ['FR-0231'], assignee: 'Sourav', purpose: 'uat' });
    expect(db.listStories('ABCD').map((x) => x.key).sort()).toEqual(['ABCD-1001', 'ABCD-1002', 'ABCD-1003']);
    expect(db.listStories('IBGM').map((x) => x.key)).toEqual(['IBGM-1001']);
    // Re-seeding changes nothing.
    expect(seedWorkspace(db, FIXTURE).stories).toBe(0);
    expect(db.listStories('ABCD')).toHaveLength(3);
  });

  it('assigns keys after the highest existing number', () => {
    const db = fixtureDb();
    const s = db.createStory(
      { summary: 'New', description: '', type: 'Story', status: 'To Do', fixVersion: '', components: ['frontend'], acceptanceCriteria: ['x'], purpose: null, original: null, refinementId: null, createdBy: 'u-sourav' },
      'ABCD',
    );
    expect(s.key).toBe('ABCD-1004');
    expect(s.components).toEqual(['frontend']);
  });
});
