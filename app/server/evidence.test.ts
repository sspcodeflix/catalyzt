/**
 * Hexa facts for answers (R01–R03, R10 from the IBGM review): a component's tests are found by link,
 * module path, package or directory, not only by title; a named test class brings its failure
 * message; CI-imported tests carry a framework and a module path.
 */
import { describe, expect, it } from 'vitest';

import type { RunMeta } from './db';
import { hexaEvidence } from './evidence';
import { fixtureDb, seedRefundTests } from './fixture';
import { ingestJUnit, moduleOf } from './ingest';

const meta = (over: Partial<RunMeta> = {}): RunMeta => ({
  app: 'ABCD',
  source: 'webhook',
  repo: 'acme/shop',
  workflow: 'local ci · go',
  framework: 'go test',
  externalRunId: 'r1',
  attempt: 1,
  runUrl: null,
  event: 'push',
  branch: 'main',
  sha: 'abc1234def',
  prNumber: null,
  isMerge: false,
  startedAt: null,
  ...over,
});

const ciRow = (id: string, title: string, suite: string, path: string | null, status: 'passed' | 'failed', message: string | null = null) => ({
  testCaseId: null,
  create: { id, title, suite, codeName: title, path },
  status,
  durationMs: 1,
  message,
});

function withCiResults() {
  const db = fixtureDb();
  seedRefundTests(db);
  db.ingestRun(
    meta(),
    [
      ciRow('TC-CI1', 'TestPlaceOrder', 'github.com/acme/shop/src/checkoutservice', null, 'failed', 'rpc error: code = Unavailable desc = cart unreachable\n&#10;goroutine 1 [running]'),
      ciRow('TC-CI2', 'TestMoneySum', 'github.com/acme/shop/src/checkoutservice/money', null, 'passed'),
      ciRow('TC-CI3', 'TestHomeHandler', 'github.com/acme/shop/src/frontend', null, 'passed'),
      ciRow('TC-CI4', 'shouldCharge', 'com.acme.shop.checkoutservice.ChargeTest', null, 'failed', 'Failed to load ApplicationContext: embedded Mongo could not start'),
      ciRow('TC-CI5', 'validates cart', 'CartSpec', 'src/checkoutservice/cart.test.ts', 'passed'),
    ],
    'u-sourav',
  );
  return db;
}

describe('Hexa facts find a component’s tests (R01, R03)', () => {
  it('matches CI-imported tests by package or directory, by module path and by link, not only by title', () => {
    const db = withCiResults();
    const mine = db.listTests('ABCD', { component: 'checkoutservice', limit: 200 });
    const ids = mine.rows.map((r) => r.id);
    expect(ids).toContain('TC-CI1'); // directory named after it at the end of the suite
    expect(ids).toContain('TC-CI2'); // directory segment
    expect(ids).toContain('TC-CI4'); // package segment
    expect(ids).toContain('TC-CI5'); // module path
    expect(ids).not.toContain('TC-CI3'); // another component
    // Plus the three scanned PartialRefundsTest tests under src/checkoutservice.
    expect(mine.total).toBe(7);
    // The same rule applies when the search box holds the component name (a citation lands on /hexa?q=<component>).
    expect(db.listTests('ABCD', { q: 'checkoutservice', limit: 200 }).total).toBe(7);
    expect(db.listTests('ABCD', { q: 'frontend', limit: 200 }).rows.map((r) => r.id)).toEqual(['TC-CI3']);
    expect(db.listTests('ABCD', { component: 'nosuchthing' }).total).toBe(0);

    const facts = hexaEvidence(db, 'ABCD', { components: ['checkoutservice'], tickets: [], text: 'Which tests cover checkoutservice and which failed?', known: db.getApp('ABCD')!.components });
    expect(facts).toHaveLength(1);
    expect(facts[0].text).toContain('7 tests in Hexa belong to it');
    expect(facts[0].text).toContain('7 automated, 0 manual');
    expect(facts[0].text).toContain('2 failed');
    expect(facts[0].text).toContain('embedded Mongo could not start');
    expect(facts[0].text).toContain('cart unreachable');
    expect(facts[0].text).not.toContain('&#10;');
    expect(facts[0].href).toBe('/hexa?tab=automated&q=checkoutservice');
  });

  it('a test class named in the question becomes a source with its latest result and failure message (R02)', () => {
    const db = withCiResults();
    const facts = hexaEvidence(db, 'ABCD', { components: [], tickets: [], text: 'Why did ChargeTest fail in the latest run?', known: [] });
    expect(facts.map((f) => f.title)).toEqual(['Hexa · ChargeTest']);
    expect(facts[0].text).toContain('latest result failed');
    expect(facts[0].text).toContain('local ci · go abc1234');
    expect(facts[0].text).toContain('failure: "Failed to load ApplicationContext: embedded Mongo could not start"');
    expect(facts[0].href).toBe('/hexa?tab=automated&q=ChargeTest');
    // An unknown class adds nothing; a general question about tests still gets the application summary.
    expect(hexaEvidence(db, 'ABCD', { components: [], tickets: [], text: 'Why did NothingTest fail?', known: [] }).map((f) => f.title)).toEqual(['Hexa · this application']);
  });

  it('the framework breakdown never counts automated tests as manual (R10)', () => {
    const db = withCiResults();
    const by = Object.fromEntries(db.testStats('ABCD').byFramework.map((f) => [f.key, f.n]));
    expect(by).toEqual({ JUnit: 3, 'go test': 5 });
    db.ingestRun(meta({ externalRunId: 'r2', framework: null }), [ciRow('TC-CI6', 'TestNoFramework', 'github.com/acme/shop/src/adservice', null, 'passed')], 'u-sourav');
    expect(db.listTests('ABCD', { q: 'TestNoFramework' }).rows[0]?.framework).toBe('JUnit XML');
    expect(db.testStats('ABCD').byFramework.find((f) => f.key === 'Manual')).toBeUndefined();
  });
});

describe('module path from the report location', () => {
  it('derives the module from where the JUnit file sat in the checkout', () => {
    expect(moduleOf('account-service/target/surefire-reports/TEST-x.xml')).toBe('account-service');
    expect(moduleOf('account-service/TEST-x.xml')).toBe('account-service');
    expect(moduleOf('./gateway/build/test-results/test/TEST-a.xml')).toBe('gateway');
    expect(moduleOf('results-1.xml')).toBeNull();
    expect(moduleOf('test-results/go.xml')).toBeNull();
    expect(moduleOf(null)).toBeNull();
  });

  it('ingested tests without a file attribute take the module as their path, and the framework is recorded', async () => {
    const db = fixtureDb();
    const xml = '<testsuite name="com.acme.shop.account.AccountTest" tests="1"><testcase classname="com.acme.shop.account.AccountTest" name="saves"/></testsuite>';
    await ingestJUnit(db, [{ filename: 'account-service/TEST-com.acme.shop.account.AccountTest.xml', xml }], meta({ framework: 'JUnit (Maven)' }), 'u-sourav');
    expect(db.listTests('ABCD', { q: 'AccountTest' }).rows[0]).toMatchObject({ path: 'account-service', framework: 'JUnit (Maven)', kind: 'automated' });
  });
});

describe('component mapping on the real import shapes (R01 on live data, V-*-01)', () => {
  const junit = (cases: { classname: string; name: string; file?: string; failed?: boolean }[]) =>
    `<testsuites><testsuite name="s">${cases.map((c) => `<testcase classname="${c.classname}" name="${c.name}"${c.file ? ` file="${c.file}"` : ''}>${c.failed ? '<failure message="boom"/>' : ''}</testcase>`).join('')}</testsuite></testsuites>`;
  const meta = (o: Partial<RunMeta> = {}): RunMeta => ({ app: 'ABCD', source: 'webhook', repo: 'acme/shop', workflow: 'ci', framework: 'JUnit (Maven)', externalRunId: 'm1', attempt: 1, runUrl: null, event: 'push', branch: 'main', sha: 'abc1234', prNumber: null, isMerge: false, startedAt: new Date().toISOString(), ...o });

  it('Maven packages, Go package paths and Jest files map to their component; titles never do', async () => {
    const db = fixtureDb();
    await ingestJUnit(db, [{ filename: 'TEST-x.xml', xml: junit([
      { classname: 'com.acme.shop.checkoutservice.ChargeTest', name: 'chargesTheCard' },
      { classname: 'github.com/acme/shop/src/frontend', name: 'TestHomeHandler' },
      { classname: 'charge rejects expired cards', name: 'charge rejects expired cards', file: 'src/checkoutservice/charge.test.ts' },
      { classname: 'com.acme.shop.checkoutservice.FrontendBannerTest', name: 'frontendBannerShowsTotal' },
    ]) }], meta(), 'u-sourav');
    const of = (c: string) => db.listTests('ABCD', { component: c, kind: 'automated', limit: 50 }).rows.map((r) => r.title).sort();
    expect(of('checkoutservice')).toEqual(['Charges the card', 'Frontend banner shows total', 'charge rejects expired cards'].sort());
    // "frontend" appears in a checkoutservice test's title: that does not make it a frontend test.
    expect(of('frontend')).toEqual(['Home handler']);
    const row = db.listTests('ABCD', { q: 'chargesTheCard' }).rows[0];
    expect(row).toMatchObject({ suite: 'com.acme.shop.checkoutservice.ChargeTest', framework: 'JUnit (Maven)' });
  });

  it('a component whose path is the whole repository owns all of its tests, and only those', async () => {
    const db = fixtureDb();
    db.raw.prepare("INSERT INTO components (id, application_id, name, manager_id, workspace_id, repo, path) VALUES ('ABCD/shop-core', 'ABCD', 'shop-core', 'u-sourav', NULL, 'acme/shop', '.')").run();
    await ingestJUnit(db, [{ filename: 'go.xml', xml: junit([{ classname: 'github.com/acme/shop', name: 'TestBatch' }]) }], meta({ framework: 'go test' }), 'u-sourav');
    await ingestJUnit(db, [{ filename: 'go.xml', xml: junit([{ classname: 'github.com/acme/other', name: 'TestElsewhere' }]) }], meta({ repo: 'acme/other', externalRunId: 'o1', framework: 'go test' }), 'u-sourav');
    expect(db.listTests('ABCD', { component: 'shop-core', kind: 'automated' }).rows.map((r) => r.title)).toEqual(['Batch']);
  });

  it('an earlier import with the short class name and no path is refreshed by the next delivery', async () => {
    const db = fixtureDb();
    await ingestJUnit(db, [{ filename: 'TEST-x.xml', xml: junit([{ classname: 'com.acme.shop.checkoutservice.RefundTest', name: 'refundsPartially' }]) }], meta(), 'u-sourav');
    const id = db.listTests('ABCD', { q: 'refundsPartially' }).rows[0].id;
    db.raw.prepare("UPDATE test_cases SET suite = 'RefundTest', path = NULL, framework = 'JUnit XML' WHERE id = ?").run(id); // how older imports stored it
    expect(db.listTests('ABCD', { component: 'checkoutservice', kind: 'automated' }).total).toBe(0);
    await ingestJUnit(db, [{ filename: 'checkoutservice/TEST-x.xml', xml: junit([{ classname: 'com.acme.shop.checkoutservice.RefundTest', name: 'refundsPartially' }]) }], meta({ externalRunId: 'm2' }), 'u-sourav');
    expect(db.getTest(id)).toMatchObject({ suite: 'com.acme.shop.checkoutservice.RefundTest', path: 'checkoutservice', framework: 'JUnit (Maven)' });
    expect(db.listTests('ABCD', { component: 'checkoutservice', kind: 'automated' }).total).toBe(1);
  });

  it('a linked test from a repository none of the story’s components use is shown but never counted', async () => {
    const db = fixtureDb();
    await ingestJUnit(db, [{ filename: 'go.xml', xml: junit([{ classname: 'github.com/moov-io/ach', name: 'TestFile' }]) }], meta({ repo: 'moov-io/ach', externalRunId: 'a1', framework: 'go test' }), 'u-sourav');
    const ach = db.listTests('ABCD', { q: 'TestFile' }).rows[0];
    db.linkTest(ach.id, 'criterion', 'ABCD-1001#AC1', 'u-sourav'); // ABCD-1001 is checkoutservice, in acme/shop
    const ac1 = db.coverageFor('ABCD-1001')[0];
    expect(ac1.status).not.toBe('passing');
    expect(ac1.evidence).toMatch(/not counted: .* from moov-io\/ach, which none of this story's components use/);
    expect(ac1.tests.find((t) => t.id === ach.id)?.result).toBe('other_repo');
  });
});
