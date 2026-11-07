import { describe, expect, it } from 'vitest';

import { openDb } from './db';

const scan = (db: ReturnType<typeof openDb>, id: string, tests: { path: string; title: string }[]) => {
  db.startWorkflow({ id: `w-${id}`, chatId: null, messageId: null, revision: 1, userId: 'u-priya' });
  db.startScan({ id, repo: 'acme/shop', ref: null, workflowRunId: `w-${id}`, userId: 'u-priya' });
  return db.completeScan({
    id,
    repo: 'acme/shop',
    ref: 'main',
    sha: 'abc1234',
    htmlUrl: 'https://github.com/acme/shop',
    filesFound: 2,
    filesScanned: 2,
    truncated: false,
    tests: tests.map((t, i) => ({ ...t, suite: null, framework: 'Jest/Mocha', line: i + 1 })),
    userId: 'u-priya',
  });
};

describe('Hexa inventory', () => {
  it('is seeded with the tests behind the UAT coverage', () => {
    const db = openDb(':memory:');
    const { rows } = db.listTests({ q: 'PAY-1482' });
    expect(rows.map((r) => r.id).sort()).toEqual(['TC-1482-1', 'TC-1482-2', 'TC-1482-3']);
    expect(rows.find((r) => r.id === 'TC-1482-3')?.lastResult).toBe('not_run');
  });

  it('adds, updates and removes scanned tests without duplicates', () => {
    const db = openDb(':memory:');
    expect(scan(db, 's1', [{ path: 'a.test.ts', title: 'adds item' }, { path: 'a.test.ts', title: 'removes item' }, { path: 'a.test.ts', title: 'adds item' }])).toEqual({ found: 2, added: 2, removed: 0 });
    expect(scan(db, 's2', [{ path: 'a.test.ts', title: 'adds item' }, { path: 'b.test.ts', title: 'pays' }])).toEqual({ found: 2, added: 1, removed: 1 });
    const { rows, total } = db.listTests({ repo: 'acme/shop' });
    expect(total).toBe(2);
    expect(rows.every((r) => r.url?.startsWith('https://github.com/acme/shop/blob/abc1234/'))).toBe(true);
    expect(db.listScans()[0]).toMatchObject({ repo: 'acme/shop', status: 'done', testsNew: 1, testsRemoved: 1 });
  });

  it('treats % and _ in a search as plain text', () => {
    const db = openDb(':memory:');
    scan(db, 's1', [{ path: 'a.test.ts', title: '100% refund' }, { path: 'a.test.ts', title: '1000 refunds' }]);
    expect(db.listTests({ q: '100%' }).rows.map((r) => r.title)).toEqual(['100% refund']);
  });

  it('keeps proposed UAT cases linked to the story and criterion', () => {
    const db = openDb(':memory:');
    db.upsertProposedCases('PAY-1482', [{ id: 'UAT-1482-1', title: 'Partial refunds within 45 days', criterion: 'AC4' }], 'u-priya');
    db.upsertProposedCases('PAY-1482', [{ id: 'UAT-1482-1', title: 'Partial refunds within 45 days', criterion: 'AC4' }], 'u-priya');
    const { rows } = db.listTests({ kind: 'proposed' });
    expect(rows).toHaveLength(1);
    expect(rows[0].links).toEqual(expect.arrayContaining([{ type: 'story', ref: 'PAY-1482' }, { type: 'criterion', ref: 'PAY-1482#AC4' }]));
    expect(db.testStats().byKind).toEqual(expect.arrayContaining([{ key: 'proposed', n: 1 }]));
  });
});

describe('token ledger', () => {
  it('totals tokens by agent and model, and counts unreported calls', () => {
    const db = openDb(':memory:');
    const base = { workflowRunId: null, agentRunId: null, userId: 'u-priya', latencyMs: 10, status: 'ok' as const };
    db.recordModelCall({ ...base, agent: 'Router', model: 'deepseek-flash', purpose: 'intent', promptTokens: 800, completionTokens: 60 });
    db.recordModelCall({ ...base, agent: 'CloudOps agent', model: 'deepseek-flash', purpose: 'answer', promptTokens: 1200, completionTokens: 300 });
    db.recordModelCall({ ...base, agent: 'CloudOps agent', model: 'deepseek-flash', purpose: 'answer', status: 'stopped', promptTokens: null, completionTokens: null });
    const u = db.usage();
    expect(u.allTime).toEqual({ calls: 3, prompt: 2000, completion: 360, total: 2360, unreported: 1 });
    expect(u.today.total).toBe(2360);
    expect(u.byAgent.map((r) => [r.key, r.total])).toEqual([
      ['CloudOps agent', 1500],
      ['Router', 860],
    ]);
    expect(u.byUser[0]).toMatchObject({ key: 'Priya N.', total: 2360 });
  });
});
