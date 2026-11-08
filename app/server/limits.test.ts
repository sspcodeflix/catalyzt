/**
 * Concurrency caps (criterion 2): workflow runs per process and per person, repository scans per
 * process. A refused request answers 429 with Retry-After and writes nothing.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { startApi, type TestApi } from './api-harness';
import { fixtureDb } from './fixture';
import { ScanError, startRepoScan } from './hexa';
import { RunLimiter, runLimitsFromEnv } from './limits';

const ids = (n: number) => ({ chatId: `c${n}`, messageId: `m${n}`, answerId: `a${n}` });
const run = (n: number) => ({ text: 'What does the refund window say?', agent: 'auto', scope: {}, tickets: [], components: [], history: [], chatTitle: 'Refunds', ...ids(n) });
const count = (db: ReturnType<typeof fixtureDb>, t: string) => (db.raw.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;

let api: TestApi | null = null;
afterEach(async () => {
  await api?.close();
  api = null;
});

describe('run limits', () => {
  it('reads limits from the environment, with defaults for anything missing or invalid', () => {
    expect(runLimitsFromEnv({})).toEqual({ perProcess: 8, perPerson: 2 });
    expect(runLimitsFromEnv({ HORIZON_MAX_RUNS: '20', HORIZON_MAX_RUNS_PER_PERSON: '3' })).toEqual({ perProcess: 20, perPerson: 3 });
    expect(runLimitsFromEnv({ HORIZON_MAX_RUNS: '-1', HORIZON_MAX_RUNS_PER_PERSON: 'x' })).toEqual({ perProcess: 8, perPerson: 2 });
  });

  it('the limiter counts per person and per process, and a release is counted once', () => {
    const l = new RunLimiter({ perProcess: 3, perPerson: 2 });
    const a1 = l.acquire('a');
    const a2 = l.acquire('a');
    expect(a1.ok && a2.ok).toBe(true);
    expect(l.acquire('a')).toMatchObject({ ok: false, scope: 'person' });
    const b1 = l.acquire('b');
    expect(b1.ok).toBe(true);
    expect(l.acquire('c')).toMatchObject({ ok: false, scope: 'process' });
    if (a1.ok) {
      a1.release();
      a1.release();
    }
    expect(l.running()).toBe(2);
    expect(l.running('a')).toBe(1);
    expect(l.acquire('c').ok).toBe(true);
  });

  it('a run over the per-person limit gets 429 with Retry-After and writes nothing', async () => {
    const db = fixtureDb();
    const limiter = new RunLimiter({ perProcess: 3, perPerson: 1 });
    api = await startApi(db, null, { runLimits: limiter });
    // Sourav already has a run going (held here as a slot).
    const held = limiter.acquire('u-sourav');
    expect(held.ok).toBe(true);
    const before = ['chats', 'messages', 'workflow_runs', 'answer_revisions', 'agent_runs'].map((t) => count(db, t));
    const res = await fetch(`${api.url}/api/run`, { method: 'POST', headers: { 'x-horizon-user': 'u-sourav', 'x-horizon-app': 'ABCD', 'Content-Type': 'application/json' }, body: JSON.stringify(run(1)) });
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('5');
    expect(((await res.json()) as { error: string }).error).toMatch(/already have 1 answer running/);
    expect(['chats', 'messages', 'workflow_runs', 'answer_revisions', 'agent_runs'].map((t) => count(db, t))).toEqual(before);

    // Someone else still runs, and the slot is given back when the stream ends.
    const events = await api.as('u-ram', 'ABCD').run(run(2));
    expect(events.some((e) => e.type === 'saved')).toBe(true);
    await new Promise((r) => setTimeout(r, 20));
    expect(limiter.running()).toBe(1);
    expect(limiter.running('u-ram')).toBe(0);
  });

  it('a run over the per-process limit gets 429 naming the server limit', async () => {
    const db = fixtureDb();
    const limiter = new RunLimiter({ perProcess: 2, perPerson: 2 });
    api = await startApi(db, null, { runLimits: limiter });
    limiter.acquire('u-ram');
    limiter.acquire('u-sourav');
    const res = await fetch(`${api.url}/api/run`, { method: 'POST', headers: { 'x-horizon-user': 'u-devi', 'x-horizon-app': 'ABCD', 'Content-Type': 'application/json' }, body: JSON.stringify(run(3)) });
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('10');
    expect(((await res.json()) as { limit: string }).limit).toBe('process');
    expect(count(db, 'chats')).toBe(0);
  });

  it('a refused request (bad body) gives its slot back', async () => {
    const db = fixtureDb();
    const limiter = new RunLimiter({ perProcess: 2, perPerson: 1 });
    api = await startApi(db, null, { runLimits: limiter });
    const bad = await api.as('u-ram', 'ABCD').post('/api/run', { text: '' });
    expect(bad.status).toBe(400);
    await new Promise((r) => setTimeout(r, 20));
    expect(limiter.running()).toBe(0);
  });
});

describe('scan limit', () => {
  it('a scan over the process limit is refused with 429 before anything is recorded', () => {
    const db = fixtureDb();
    for (const repo of ['acme/one', 'acme/two']) {
      const wf = `wf-${repo}`;
      db.startWorkflow({ id: wf, app: 'ABCD', chatId: null, messageId: null, revision: 1, userId: 'u-ram' });
      db.startScan({ id: `scan-${repo}`, app: 'ABCD', repo, ref: null, workflowRunId: wf, userId: 'u-ram' });
    }
    const scans = count(db, 'repo_scans');
    const workflows = count(db, 'workflow_runs');
    let err: unknown;
    try {
      startRepoScan(db, 'ABCD', 'acme/three', 'u-ram', undefined, 2);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ScanError);
    expect((err as ScanError).status).toBe(429);
    expect(count(db, 'repo_scans')).toBe(scans);
    expect(count(db, 'workflow_runs')).toBe(workflows);
  });

  it('the API answers 429 with Retry-After for a scan over the limit', async () => {
    const db = fixtureDb();
    db.startWorkflow({ id: 'wf', app: 'ABCD', chatId: null, messageId: null, revision: 1, userId: 'u-ram' });
    db.startScan({ id: 'scan-1', app: 'ABCD', repo: 'acme/one', ref: null, workflowRunId: 'wf', userId: 'u-ram' });
    api = await startApi(db, null, { maxScans: 1 });
    const res = await api.as('u-ram', 'ABCD').post('/api/hexa/scans', { repo: 'acme/two' });
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('30');
  });
});
