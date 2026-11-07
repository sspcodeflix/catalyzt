import Database from 'better-sqlite3';
import { strToU8, zipSync } from 'fflate';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { openDb } from './db';
import { importManual, ingestJUnit, syncGitHubActions } from './ingest';
import { MIGRATIONS } from './schema';

const meta = (o: Partial<Parameters<typeof ingestJUnit>[2]> = {}) => ({
  source: 'upload' as const,
  repo: 'payments/pay-hub-automation',
  workflow: null,
  externalRunId: null,
  runUrl: null,
  event: 'upload',
  branch: 'main',
  sha: 'abc1234',
  prNumber: 1482,
  isMerge: true,
  startedAt: null,
  ...o,
});

const junit = (failing: boolean) => `<testsuite name="payments.PartialRefundsForTest">
  <testcase classname="payments.PartialRefundsForTest" name="aMerchantCanRefundPartOfASettledCardPayment" time="0.2"/>
  <testcase classname="payments.PartialRefundsForTest" name="aRefundAboveTheOriginalAmountIsRejectedWithAClearMessage" time="0.3">${failing ? '<failure message="expected 422"/>' : ''}</testcase>
  <testcase classname="payments.NewThingTest" name="newBehaviourWorks" time="0.1"/>
</testsuite>`;

afterEach(() => vi.unstubAllGlobals());

const at = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();

describe('results reach the right tests', () => {
  it('matches seeded tests, adds unknown ones, and records history', async () => {
    const db = openDb(':memory:');
    const r = await ingestJUnit(db, [{ filename: 'a.xml', xml: junit(true) }], meta({ startedAt: at(-5) }), 'u-priya');
    expect(r).toMatchObject({ total: 3, matched: 2, created: 1, passed: 2, failed: 1 });
    expect(db.getTest('TC-1482-2')).toMatchObject({ lastResult: 'failed', history: [{ status: 'failed', prNumber: 1482, message: 'expected 422' }] });
    expect(db.listTests({ q: 'New behaviour works' }).rows[0]).toMatchObject({ origin: 'ci_results', lastResult: 'passed' });

    // A later run that passes updates the latest result; an older one does not overwrite it.
    await ingestJUnit(db, [{ filename: 'b.xml', xml: junit(false) }], meta({ startedAt: at(-1), prNumber: 1490 }), 'u-priya');
    await ingestJUnit(db, [{ filename: 'c.xml', xml: junit(true) }], meta({ startedAt: at(-60 * 24 * 30), prNumber: 1400 }), 'u-priya');
    const t = db.getTest('TC-1482-2')!;
    expect(t.lastResult).toBe('passed');
    expect(t.history.map((h) => h.prNumber)).toEqual([1490, 1482, 1400]);
    expect(db.listRuns().map((x) => x.status)).toEqual(['passed', 'failed', 'failed']);
  });

  it('imports manual tests from Octane CSV, updating by unique_id and linking coverage', async () => {
    const db = openDb(':memory:');
    const csv = 'unique_id,type,name,step_type,step_description,test_type,covered_content\nUAT-9,test_manual,Refund reason is required,simple,Open refund,Acceptance,"PAY-1482#AC3, FR-0233"\nUAT-9,,,validation,Submitting without a reason shows an error,,';
    const a = await importManual(db, { filename: 'tests.csv', data: Buffer.from(csv) }, null, 'u-priya');
    expect(a).toMatchObject({ created: 1, updated: 0 });
    const b = await importManual(db, { filename: 'tests.csv', data: Buffer.from(csv.replace('Refund reason is required', 'Refund reason is mandatory')) }, null, 'u-priya');
    expect(b).toMatchObject({ created: 0, updated: 1 });
    const { rows } = db.listTests({ kind: 'manual' });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ title: 'Refund reason is mandatory', purpose: 'uat', externalId: 'UAT-9', steps: 2 });
    expect(rows[0].links).toEqual(expect.arrayContaining([{ type: 'story', ref: 'PAY-1482' }, { type: 'criterion', ref: 'PAY-1482#AC3' }, { type: 'requirement', ref: 'FR-0233' }]));
    expect(db.listTests({ q: 'without a reason' }).total).toBe(1);
  });
});

describe('GitHub Actions', () => {
  it('needs a token', async () => {
    await expect(syncGitHubActions(openDb(':memory:'), 'a/b', undefined, 'u-priya')).rejects.toThrow(/GITHUB_TOKEN/);
  });

  it('ingests only PR merge-commit runs with JUnit artifacts, once', async () => {
    const db = openDb(':memory:');
    const zip = zipSync({ 'surefire/TEST-a.xml': strToU8(junit(true)), 'readme.txt': strToU8('x') });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const j = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
        if (url.endsWith('/repos/payments/pay-hub-automation')) return j({ default_branch: 'main' });
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
    const r = await syncGitHubActions(db, 'payments/pay-hub-automation', 't', 'u-priya');
    expect(r).toMatchObject({ checked: 2, ingested: 1, notMerge: 1, results: 3, failed: 1 });
    expect(db.listRuns()[0]).toMatchObject({ source: 'github_actions', prNumber: 77, isMerge: true, sha: 'merge1', runUrl: 'https://github.com/r/11' });
    expect(await syncGitHubActions(db, 'payments/pay-hub-automation', 't', 'u-priya')).toMatchObject({ ingested: 0, already: 1 });
  });
});

describe('migration from version 3', () => {
  it('rebuilds test_cases without losing data or links', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'hz-')), 'v3.db');
    const raw = new Database(path);
    raw.pragma('foreign_keys = ON');
    for (const m of MIGRATIONS.slice(0, 3)) raw.exec(m);
    raw.pragma('user_version = 3');
    raw.exec(`INSERT INTO applications VALUES ('App-abcd', 'Payments Hub', 'PAY');
      INSERT INTO users VALUES ('u-priya', 'Priya N.', 'PN', 'p@example.com', '2026-01-01');
      INSERT INTO test_cases (id, application_id, title, kind, origin, created_at, updated_at) VALUES ('T1', 'App-abcd', 'Old test', 'automated', 'repo_scan', 'x', 'x');
      INSERT INTO test_case_links VALUES ('T1', 'story', 'PAY-1482');`);
    raw.close();
    const db = openDb(path);
    expect(db.raw.pragma('user_version', { simple: true })).toBe(MIGRATIONS.length);
    expect(db.getTest('T1')).toMatchObject({ title: 'Old test', links: [{ type: 'story', ref: 'PAY-1482' }] });
  });
});
