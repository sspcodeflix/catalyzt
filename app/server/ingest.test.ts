import Database from 'better-sqlite3';
import { strToU8, zipSync } from 'fflate';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { openDb } from './db';
import { fixtureDb, seedRefundTests } from './fixture';
import { importManual, ingestJUnit, syncGitHubActions } from './ingest';
import { MIGRATIONS } from './schema';

const meta = (o: Partial<Parameters<typeof ingestJUnit>[2]> = {}) => ({
  app: 'ABCD',
  source: 'upload' as const,
  repo: 'acme/shop',
  workflow: null,
  externalRunId: null,
  attempt: 1,
  runUrl: null,
  event: 'upload',
  branch: 'main',
  sha: 'abc1234',
  prNumber: 1482,
  isMerge: true,
  startedAt: null,
  ...o,
});

const junit = (failing: boolean) => `<testsuite name="payments.PartialRefundsTest">
  <testcase classname="payments.PartialRefundsTest" name="aMerchantCanRefundPartOfASettledCardPayment" time="0.2"/>
  <testcase classname="payments.PartialRefundsTest" name="aRefundAboveTheOriginalAmountIsRejectedWithAClearMessage" time="0.3">${failing ? '<failure message="expected 422"/>' : ''}</testcase>
  <testcase classname="payments.NewThingTest" name="newBehaviourWorks" time="0.1"/>
</testsuite>`;

const at = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();

afterEach(() => vi.unstubAllGlobals());

describe('results reach the right tests', () => {
  it('matches scanned tests, adds unknown ones, records history and updates coverage', async () => {
    const db = fixtureDb();
    const [, ac2] = seedRefundTests(db);
    const r = await ingestJUnit(db, [{ filename: 'a.xml', xml: junit(true) }], meta({ startedAt: at(-5) }), 'u-sourav');
    expect(r).toMatchObject({ total: 3, matched: 2, created: 1, passed: 2, failed: 1 });
    expect(db.getTest(ac2)).toMatchObject({ lastResult: 'failed', history: [{ status: 'failed', prNumber: 1482, message: 'expected 422' }, { status: 'passed', prNumber: 41 }] });
    expect(db.listTests('ABCD', { q: 'New behaviour works' }).rows[0]).toMatchObject({ origin: 'ci_results', lastResult: 'passed' });
    expect(db.coverageFor('ABCD-1001').map((c) => c.status)).toEqual(['passing', 'failing', 'not-run', 'no-test']);

    // A later run that passes updates the latest result; an older one does not overwrite it.
    await ingestJUnit(db, [{ filename: 'b.xml', xml: junit(false) }], meta({ startedAt: at(-1), prNumber: 1490 }), 'u-sourav');
    await ingestJUnit(db, [{ filename: 'c.xml', xml: junit(true) }], meta({ startedAt: at(-60 * 24 * 30), prNumber: 1400 }), 'u-sourav');
    const t = db.getTest(ac2)!;
    expect(t.lastResult).toBe('passed');
    expect(t.history.map((h) => h.prNumber)).toEqual([1490, 1482, 41, 1400]);
    expect(db.listRuns('ABCD').map((x) => x.status)).toEqual(['passed', 'failed', 'passed', 'failed']);
    expect(db.listRuns('IBGM')).toHaveLength(0);
  });

  it('imports manual tests from Octane CSV, updating by unique_id and linking coverage', async () => {
    const db = fixtureDb();
    const csv =
      'unique_id,type,name,step_type,step_description,test_type,covered_content\nUAT-9,test_manual,Refund reason is required,simple,Open refund,Acceptance,"ABCD-1001#AC3, FR-0233, checkoutservice"\nUAT-9,,,validation,Submitting without a reason shows an error,,';
    const a = await importManual(db, 'ABCD', { filename: 'tests.csv', data: Buffer.from(csv) }, null, 'u-sourav');
    expect(a).toMatchObject({ created: 1, updated: 0 });
    const b = await importManual(db, 'ABCD', { filename: 'tests.csv', data: Buffer.from(csv.replace('Refund reason is required', 'Refund reason is mandatory')) }, null, 'u-sourav');
    expect(b).toMatchObject({ created: 0, updated: 1 });
    const { rows } = db.listTests('ABCD', { kind: 'manual' });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ title: 'Refund reason is mandatory', purpose: 'uat', externalId: 'UAT-9', steps: 2 });
    expect(rows[0].links).toEqual(
      expect.arrayContaining([
        { type: 'story', ref: 'ABCD-1001' },
        { type: 'criterion', ref: 'ABCD-1001#AC3' },
        { type: 'requirement', ref: 'FR-0233' },
        { type: 'component', ref: 'ABCD/checkoutservice' },
      ]),
    );
    expect(db.listTests('ABCD', { q: 'without a reason' }).total).toBe(1);
    // A manual test linked to AC3 counts as "not run", not as covered.
    expect(db.coverageFor('ABCD-1001')[2].status).toBe('not-run');
  });
});

describe('F06: evidence is read from the target build, never from a cached last result', () => {
  const only = (names: string[], skip = false) =>
    `<testsuite name="payments.PartialRefundsTest">${names.map((n) => `<testcase classname="payments.PartialRefundsTest" name="${n}" time="0.1">${skip ? '<skipped/>' : ''}</testcase>`).join('')}</testsuite>`;

  it('a test missing from the latest merge run is not covered by its earlier pass', async () => {
    const db = fixtureDb();
    seedRefundTests(db); // run PR #41: AC1 and AC2 passed
    await ingestJUnit(db, [{ filename: 'n.xml', xml: only(['aMerchantCanRefundPartOfASettledCardPayment']) }], meta({ startedAt: at(-1), prNumber: 1500 }), 'u-sourav');
    const cov = db.coverageFor('ABCD-1001');
    expect(cov.map((c) => c.status)).toEqual(['passing', 'not-run', 'not-run', 'no-test']);
    expect(cov[0].evidence).toBe('1 test passed in PR #1500 (abc1234, main)'.replace('1 test', cov[0].tests[0].id));
    expect(cov[1].tests[0].result).toBe('missing');
    expect(cov[1].evidence).toMatch(/not in PR #1500 \(abc1234, main\); an earlier pass does not count/);
    expect(cov[0].builds[0]).toMatchObject({ prNumber: 1500, sha: 'abc1234', branch: 'main' });
    // The Hexa list still shows the test's own last result; coverage does not use it.
    expect(db.getTest(cov[1].tests[0].id)?.lastResult).toBe('passed');
  });

  it('a failure is never hidden by another linked test that passed', async () => {
    const db = fixtureDb();
    const [, ac2] = seedRefundTests(db);
    db.linkTest(ac2, 'criterion', 'ABCD-1001#AC1', 'u-sourav');
    await ingestJUnit(db, [{ filename: 'f.xml', xml: junit(true) }], meta({ startedAt: at(-1), prNumber: 1501 }), 'u-sourav');
    const ac1 = db.coverageFor('ABCD-1001')[0];
    expect(ac1.status).toBe('failing');
    expect(ac1.evidence).toMatch(/failed in PR #1501/);
    expect(ac1.tests.map((t) => t.result).sort()).toEqual(['failed', 'passed']);
  });

  it('skipped and never-run are explicit, not covered', async () => {
    const db = fixtureDb();
    seedRefundTests(db);
    await ingestJUnit(db, [{ filename: 's.xml', xml: only(['aMerchantCanRefundPartOfASettledCardPayment'], true) }], meta({ startedAt: at(-1), prNumber: 1502 }), 'u-sourav');
    const cov = db.coverageFor('ABCD-1001');
    expect(cov[0]).toMatchObject({ status: 'not-run', evidence: expect.stringMatching(/skipped in PR #1502/) });
    // A repository with no recorded run at all.
    expect(db.targetBuild('ABCD', 'acme/other')).toBeNull();
    expect(db.targetBuild('IBGM', 'acme/shop')).toBeNull();
  });

  it('a rerun is a new attempt and becomes the target build', async () => {
    const db = fixtureDb();
    seedRefundTests(db);
    await ingestJUnit(db, [{ filename: 'a1.xml', xml: junit(true) }], meta({ source: 'webhook', externalRunId: '9001', attempt: 1, startedAt: at(-2), prNumber: 1503 }), 'u-sourav');
    expect(db.coverageFor('ABCD-1001')[1].status).toBe('failing');
    expect(db.runExists('ABCD', 'webhook', 'acme/shop', '9001', 1)).toBe(true);
    expect(db.runExists('ABCD', 'webhook', 'acme/shop', '9001', 2)).toBe(false);
    expect(db.runExists('IBGM', 'webhook', 'acme/shop', '9001', 1)).toBe(false);
    await ingestJUnit(db, [{ filename: 'a2.xml', xml: junit(false) }], meta({ source: 'webhook', externalRunId: '9001', attempt: 2, startedAt: at(-1), prNumber: 1503 }), 'u-sourav');
    const ac2 = db.coverageFor('ABCD-1001')[1];
    expect(ac2.status).toBe('passing');
    expect(ac2.evidence).toMatch(/PR #1503 attempt 2/);
    expect(db.listRuns('ABCD').map((r) => r.attempt)).toEqual([2, 1, 1]);
  });
});

describe('GitHub Actions', () => {
  it('needs a token', async () => {
    await expect(syncGitHubActions(fixtureDb(), 'ABCD', 'a/b', undefined, 'u-ram')).rejects.toThrow(/GITHUB_TOKEN/);
  });

  it('ingests only PR merge-commit runs with JUnit artifacts, once', async () => {
    const db = fixtureDb();
    const zip = zipSync({ 'surefire/TEST-a.xml': strToU8(junit(true)), 'readme.txt': strToU8('x') });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const j = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
        if (url.endsWith('/repos/acme/shop')) return j({ default_branch: 'main' });
        if (url.includes('/actions/runs?'))
          return j({
            workflow_runs: [
              { id: 11, name: 'CI', html_url: 'https://github.com/r/11', head_sha: 'merge1', head_branch: 'main', event: 'push', run_started_at: '2026-11-03T10:00:00Z', conclusion: 'failure', artifacts_url: 'https://api.github.com/a/11' },
              { id: 12, name: 'CI', html_url: 'https://github.com/r/12', head_sha: 'direct', head_branch: 'main', event: 'push', run_started_at: '2026-11-02T10:00:00Z', conclusion: 'success', artifacts_url: 'https://api.github.com/a/12' },
            ],
          });
        if (url.endsWith('/commits/merge1/pulls')) return j([{ number: 77, merged_at: '2026-11-03', merge_commit_sha: 'merge1' }]);
        if (url.endsWith('/commits/direct/pulls')) return j([]);
        if (url === 'https://api.github.com/a/11') return j({ artifacts: [{ name: 'test-results', expired: false, archive_download_url: 'https://dl/11' }, { name: 'coverage', expired: false, archive_download_url: 'https://dl/x' }] });
        if (url === 'https://dl/11') return new Response(zip, { status: 200 });
        throw new Error(`unexpected ${url}`);
      }),
    );
    const r = await syncGitHubActions(db, 'ABCD', 'acme/shop', 't', 'u-ram');
    expect(r).toMatchObject({ checked: 2, ingested: 1, notMerge: 1, results: 3, failed: 1 });
    expect(db.listRuns('ABCD')[0]).toMatchObject({ source: 'github_actions', prNumber: 77, isMerge: true, sha: 'merge1', runUrl: 'https://github.com/r/11' });
    expect(await syncGitHubActions(db, 'ABCD', 'acme/shop', 't', 'u-ram')).toMatchObject({ ingested: 0, already: 1 });
  });
});

describe('migrations', () => {
  it('upgrade a version-3 database without losing data or links', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'hz-')), 'v3.db');
    const raw = new Database(path);
    raw.pragma('foreign_keys = ON');
    for (const m of MIGRATIONS.slice(0, 3)) raw.exec(m);
    raw.pragma('user_version = 3');
    raw.exec(`INSERT INTO applications VALUES ('App-old', 'Old app', 'OLD');
      INSERT INTO users VALUES ('u-old', 'Old User', 'OU', 'o@example.com', '2026-01-01');
      INSERT INTO memberships VALUES ('u-old', 'App-old', 'app_owner');
      INSERT INTO components (id, application_id, name) VALUES ('svc', 'App-old', 'svc');
      INSERT INTO stories (key, application_id, project, number, summary, type, status, source, created_by, created_at, updated_at) VALUES ('OLD-1', 'App-old', 'OLD', 1, 'Old story', 'Story', 'Done', 'horizon', 'u-old', 'x', 'x');
      INSERT INTO story_components VALUES ('OLD-1', 'svc');
      INSERT INTO test_cases (id, application_id, title, kind, origin, created_at, updated_at) VALUES ('T1', 'App-old', 'Old test', 'automated', 'repo_scan', 'x', 'x');
      INSERT INTO test_case_links VALUES ('T1', 'story', 'OLD-1');`);
    raw.close();
    const db = openDb(path);
    expect(db.raw.pragma('user_version', { simple: true })).toBe(MIGRATIONS.length);
    expect(db.getTest('T1')).toMatchObject({ title: 'Old test', links: [{ type: 'story', ref: 'OLD-1' }] });
    // Component ids gained their application prefix, and the story still points at the component.
    expect(db.getApp('App-old')?.components.map((c) => c.id)).toEqual(['App-old/svc']);
    expect(db.getStory('OLD-1')?.components).toEqual(['svc']);
    expect(db.rolesFor('u-old', 'App-old')).toEqual(['app_owner']);
  });
});
