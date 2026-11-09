/**
 * The capability map (docs/FLOWS.md › Regression): drawn from App Context (or, without a model, one
 * capability per component), edited and confirmed by people, read against the automation repository's
 * results. A check counts as covered only through a test a person linked to it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { startApi, type TestApi } from './api-harness';
import type { CapabilityMap } from '../src/lib/capabilityTypes';
import type { HorizonDb } from './db';
import { fixtureDb, seedRefundTests } from './fixture';
import { ingestJUnit } from './ingest';

let db: HorizonDb;
let api: TestApi;
beforeEach(async () => {
  db = fixtureDb();
  seedRefundTests(db);
  api = await startApi(db);
});
afterEach(() => api.close());

const meta = {
  app: 'ABCD',
  source: 'upload' as const,
  repo: 'acme/shop',
  workflow: 'CI',
  externalRunId: 'r-cap',
  attempt: 1,
  runUrl: null,
  event: 'push',
  branch: 'main',
  sha: 'cap0001',
  prNumber: 7,
  isMerge: true,
  startedAt: new Date().toISOString(),
};

const map = async (who = 'u-ram') => (await (await api.as(who, 'ABCD').get('/api/capabilities')).json()) as CapabilityMap;

describe('the capability map', () => {
  it('starts empty, is drawn per component without a model, and anyone on the team can edit and confirm it', async () => {
    expect((await map()).capabilities).toEqual([]);
    // Without a model the agent proposes one capability per component, with one check each.
    const r = (await (await api.as('u-devi', 'ABCD').post('/api/capabilities/map', {})).json()) as { summary: string; map: CapabilityMap; source: string };
    expect(r.source).toBe('rules');
    expect(r.map.capabilities.map((c) => [c.name, c.component, c.checks.length])).toEqual([
      ['Checkoutservice', 'checkoutservice', 1],
      ['Frontend', 'frontend', 1],
    ]);
    expect(r.map.totals).toMatchObject({ checks: 2, none: 2, covered: 0 });
    expect(r.map.confirmed).toBe(false);
    // Mapping again adds nothing twice.
    const again = (await (await api.as('u-ram', 'ABCD').post('/api/capabilities/map', {})).json()) as { map: CapabilityMap };
    expect(again.map.totals.checks).toBe(2);
    // A person adds a check and a capability, removes a check, confirms.
    const cap = r.map.capabilities[0];
    let m = (await (await api.as('u-devi', 'ABCD').post(`/api/capabilities/${cap.id}/checks`, { add: 'A partial refund above the original amount is refused with a message' })).json()) as CapabilityMap;
    expect(m.capabilities[0].checks).toHaveLength(2);
    expect(m.capabilities[0].checks[1].origin).toBe('person');
    expect((await api.as('u-devi', 'ABCD').post(`/api/capabilities/${cap.id}/checks`, { add: 'short' })).status).toBe(400);
    m = (await (await api.as('u-devi', 'ABCD').post('/api/capabilities', { name: 'Search', summary: 'Finding stories and tests.', component: 'nope', checks: ['Searching a story key opens it'] })).json()) as CapabilityMap;
    expect(m.capabilities.map((c) => c.name)).toEqual(['Checkoutservice', 'Frontend', 'Search']);
    expect(m.capabilities[2]).toMatchObject({ origin: 'person', component: null, checks: [{ text: 'Searching a story key opens it' }] });
    m = (await (await api.as('u-devi', 'ABCD').post(`/api/capabilities/checks/${m.capabilities[0].checks[0].id}`, { remove: true })).json()) as CapabilityMap;
    expect(m.capabilities[0].checks).toHaveLength(1);
    m = (await (await api.as('u-devi', 'ABCD').post('/api/capabilities/confirm', {})).json()) as CapabilityMap;
    expect(m.confirmed).toBe(true);
    expect(m.capabilities[0].confirmedBy).toBe('Devi');
    // Removing a capability takes it off the map.
    m = (await (await api.as('u-devi', 'ABCD').post(`/api/capabilities/${m.capabilities[2].id}`, { remove: true })).json()) as CapabilityMap;
    expect(m.capabilities.map((c) => c.name)).toEqual(['Checkoutservice', 'Frontend']);
    expect((await api.as('u-nabih', 'IBGM').get('/api/capabilities')).status).toBe(200);
    expect((await (await api.as('u-nabih', 'IBGM').get('/api/capabilities')).json()).capabilities).toEqual([]);
  });

  it('suggests a component test that shares a check\'s words, counts it only once linked, and only when it passed in the target build', async () => {
    await api.as('u-ram', 'ABCD').post('/api/capabilities/map', {});
    let m = await map();
    const cap = m.capabilities.find((c) => c.component === 'checkoutservice')!;
    // A check in the words of a test the CI run will report.
    m = (await (await api.as('u-ram', 'ABCD').post(`/api/capabilities/${cap.id}/checks`, { add: 'Partial refunds are allowed within 45 days from settlement' })).json()) as CapabilityMap;
    const check = m.capabilities.find((c) => c.id === cap.id)!.checks.find((k) => /Partial refunds/.test(k.text))!;
    expect(check.suggestions).toEqual([]);
    const xml = `<testsuite name="checkoutservice.SettlementWindowTest">
      <testcase classname="checkoutservice.SettlementWindowTest" file="src/checkoutservice/settlement_window_test.go" name="partialRefundsAllowedWithin45DaysFromSettlement" time="0.1"/>
    </testsuite>`;
    await ingestJUnit(db, [{ filename: 'r.xml', xml }], meta, 'u-sourav');
    m = await map();
    const k = m.capabilities.find((c) => c.id === cap.id)!.checks.find((x) => x.id === check.id)!;
    expect(k.status).toBe('none');
    expect(k.suggestions[0]).toMatchObject({ result: 'passed' });
    expect(k.suggestions[0].why).toMatch(/^shares partial, refunds/);
    expect(m.build?.label).toMatch(/PR #7/);
    // Linking it makes it count; a manual test cannot be linked; unlinking takes the evidence away.
    m = (await (await api.as('u-devi', 'ABCD').post(`/api/capabilities/checks/${check.id}/tests`, { testId: k.suggestions[0].id })).json()) as CapabilityMap;
    const linked = m.capabilities.find((c) => c.id === cap.id)!.checks.find((x) => x.id === check.id)!;
    expect(linked.status).toBe('covered');
    expect(linked.tests).toHaveLength(1);
    expect(linked.suggestions).toEqual([]);
    expect(m.totals.covered).toBe(1);
    const manual = db.listTests('ABCD', { kind: 'manual', limit: 1 }).rows[0];
    if (manual) expect((await api.as('u-devi', 'ABCD').post(`/api/capabilities/checks/${check.id}/tests`, { testId: manual.id })).status).toBe(400);
    m = (await (await api.as('u-devi', 'ABCD').post(`/api/capabilities/checks/${check.id}/tests`, { testId: linked.tests[0].id, remove: true })).json()) as CapabilityMap;
    expect(m.capabilities.find((c) => c.id === cap.id)!.checks.find((x) => x.id === check.id)!.status).toBe('none');
  });
});
