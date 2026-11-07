/**
 * A small workspace for tests: two applications, three people, components, stories. Mirrors the
 * shape of .myworkspace without any of its data. Server tests only.
 */
import { openDb, type HorizonDb } from './db';
import { seedWorkspace } from './db';
import type { Workspace } from './workspace';

export const FIXTURE: Workspace = {
  root: 'memory',
  warnings: [],
  people: [
    { id: 'u-ram', name: 'Ram Kumar', initials: 'RK', email: 'ram@example.com', app: 'ABCD', role: 'app_owner' },
    { id: 'u-sourav', name: 'Sourav', initials: 'SV', email: 'sourav@example.com', app: 'ABCD', role: 'component_manager' },
    { id: 'u-devi', name: 'Devi', initials: 'DV', email: 'devi@example.com', app: 'ABCD', role: 'member' },
    { id: 'u-nabih', name: 'Nabih Ben Lagha', initials: 'NB', email: 'nabih@example.com', app: 'IBGM', role: 'app_owner' },
  ],
  teams: [
    {
      id: 'ABCD',
      name: "Ram's Portfolio",
      description: 'A test portfolio.',
      jiraProject: 'ABCD',
      owner: 'u-ram',
      workspaces: ['storefront', 'payments'],
      repos: [{ name: 'shop', github: 'acme/shop', clone: true, languages: ['Go'], testFrameworks: ['go test'] }],
      components: [
        { name: 'checkoutservice', manager: 'u-sourav', workspace: 'payments', repo: 'shop', path: 'src/checkoutservice', language: 'Go', tests: 'go test' },
        { name: 'frontend', manager: 'u-sourav', workspace: 'storefront', repo: 'shop', path: 'src/frontend', language: 'Go', tests: 'go test' },
      ],
      stories: [
        {
          key: 'ABCD-1001',
          summary: 'Partial refunds for card payments',
          description: 'A shopper can be refunded part of a settled card payment, up to the original amount.',
          status: 'Ready for UAT',
          fixVersion: '24.11',
          purpose: 'uat',
          components: ['checkoutservice'],
          requirements: ['FR-0231'],
          assignee: 'u-sourav',
          acceptanceCriteria: [
            'A merchant can refund part of a settled card payment',
            'A refund above the original amount is rejected with a clear message',
            'A card refund needs a reason',
            'Partial refunds are allowed for 45 days from settlement',
          ],
        },
        {
          key: 'ABCD-1002',
          summary: 'Checkout shows the total in the shopper currency',
          status: 'Ready for UAT',
          components: ['frontend'],
          acceptanceCriteria: ['Totals are converted at the latest rate', 'The currency code is shown next to the total'],
        },
        { key: 'ABCD-1003', summary: 'Retry failed payment webhooks', status: 'In Progress', acceptanceCriteria: ['Webhooks retry 3 times with backoff'] },
      ],
      manualTestsCsv: null,
      dir: 'memory/ABCD',
    },
    {
      id: 'IBGM',
      name: "Nabih's Portfolio",
      description: 'A second test portfolio.',
      jiraProject: 'IBGM',
      owner: 'u-nabih',
      workspaces: ['core-banking'],
      repos: [],
      components: [],
      stories: [{ key: 'IBGM-1001', summary: 'Account statement export', status: 'Ready for UAT', acceptanceCriteria: ['Statements export as PDF'] }],
      manualTestsCsv: null,
      dir: 'memory/IBGM',
    },
  ],
};

export function fixtureDb(): HorizonDb {
  const db = openDb(':memory:');
  seedWorkspace(db, FIXTURE);
  return db;
}

/**
 * Gives ABCD-1001 the test evidence the UAT tests expect: AC1 and AC2 have tests that passed in a
 * merge run, AC3 has a test with no result yet, AC4 has no test. Returns the test ids by criterion.
 */
export function seedRefundTests(db: HorizonDb) {
  const names = ['aMerchantCanRefundPartOfASettledCardPayment', 'aRefundAboveTheOriginalAmountIsRejectedWithAClearMessage', 'aCardRefundNeedsAReason'];
  db.startWorkflow({ id: 'w-seed', app: 'ABCD', chatId: null, messageId: null, revision: 1, userId: 'u-sourav' });
  db.startScan({ id: 'scan-seed', app: 'ABCD', repo: 'acme/shop', ref: null, workflowRunId: 'w-seed', userId: 'u-sourav' });
  db.completeScan({
    id: 'scan-seed',
    app: 'ABCD',
    repo: 'acme/shop',
    ref: 'main',
    sha: 'seed123',
    htmlUrl: 'https://github.com/acme/shop',
    filesFound: 1,
    filesScanned: 1,
    truncated: false,
    tests: names.map((n, i) => ({ path: 'src/checkoutservice/PartialRefundsTest.java', title: n.replace(/([A-Z])/g, ' $1').trim(), name: n, suite: 'PartialRefundsTest', framework: 'JUnit', line: 10 + i * 10 })),
    userId: 'u-sourav',
  });
  const cands = db.automatedCandidates('ABCD', 'acme/shop');
  const ids = names.map((n) => cands.find((c) => c.codeName === n)!.id);
  ids.forEach((id, i) => db.linkTest(id, 'criterion', `ABCD-1001#AC${i + 1}`, 'u-sourav'));
  db.ingestRun(
    { app: 'ABCD', source: 'webhook', repo: 'acme/shop', workflow: 'CI', externalRunId: 'seed-run', runUrl: null, event: 'push', branch: 'main', sha: 'seed123', prNumber: 41, isMerge: true, startedAt: new Date(Date.now() - 3_600_000).toISOString() },
    [
      { testCaseId: ids[0], status: 'passed', durationMs: 120, message: null },
      { testCaseId: ids[1], status: 'passed', durationMs: 80, message: null },
    ],
    'u-sourav',
  );
  return ids;
}
