/**
 * Link suggestions (V-ABCD-05, V-WIMT-08): an automated test of the story's component that names a
 * criterion's words is offered under that criterion, with its result in the target build. It never
 * counts until a person links it.
 */
import { describe, expect, it } from 'vitest';

import { fixtureDb, seedRefundTests } from './fixture';
import { ingestJUnit } from './ingest';

const meta = {
  app: 'ABCD',
  source: 'upload' as const,
  repo: 'acme/shop',
  workflow: 'CI',
  externalRunId: 'r-suggest',
  attempt: 1,
  runUrl: null,
  event: 'push',
  branch: 'main',
  sha: 'seed999',
  prNumber: null,
  isMerge: true,
  startedAt: new Date().toISOString(),
};

describe('suggested tests for uncovered criteria', () => {
  it('offers a passing component test that shares the criterion words, and does not count it', async () => {
    const db = fixtureDb();
    seedRefundTests(db);
    const xml = `<testsuite name="checkoutservice.SettlementWindowTest">
      <testcase classname="checkoutservice.SettlementWindowTest" file="src/checkoutservice/settlement_window_test.go" name="partialRefundsAllowedWithin45DaysFromSettlement" time="0.1"/>
    </testsuite>`;
    await ingestJUnit(db, [{ filename: 'r.xml', xml }], meta, 'u-sourav');
    const cov = db.suggestTests('ABCD-1001', db.coverageFor('ABCD-1001'));
    expect(cov[3].status).toBe('no-test');
    expect(cov[3].suggestions?.[0]).toMatchObject({ result: 'passed' });
    expect(cov[3].suggestions?.[0].why).toMatch(/^shares partial, refunds/);
    // Passing criteria get no suggestions; the suggestion changes no status.
    expect(cov[0].suggestions).toBeUndefined();
    expect(db.coverageFor('ABCD-1001')[3].status).toBe('no-test');
  });

  it('suggests nothing when no test shares enough of the criterion', () => {
    const db = fixtureDb();
    seedRefundTests(db);
    const cov = db.suggestTests('ABCD-1001', db.coverageFor('ABCD-1001'));
    expect(cov.every((c) => !c.suggestions)).toBe(true);
  });
});
