/**
 * Regression tests for the review findings, through the HTTP API (docs/FINDINGS.md):
 *   F01 cross-application chat writes · F02 proposal id collisions · F03 approval bypass
 *   F04 mutable evidence behind approvals · F05 secrets in titles · F09 server-side ratings and
 *   decisions · F14 repeat analysis and superseded approvals.
 * No model is configured, so every run goes through the rules router; the UAT analyst needs none.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Block, UatArtifact } from '../src/lib/types';
import type { WorkflowEvent } from '../src/lib/workflow';
import { RunRefused, startApi, type TestApi } from './api-harness';
import type { HorizonDb } from './db';
import { fixtureDb, seedRefundTests } from './fixture';

type Saved = Extract<WorkflowEvent, { type: 'saved' }>;
type Answer = Extract<WorkflowEvent, { type: 'answer' }>;

const SECRET = 'AKIAABCDEFGHIJKLMNOP';

/** A UAT analysis request as the browser sends it. */
const uatRun = (key: string, ids: { chatId: string; messageId: string; answerId: string }, extra: Record<string, unknown> = {}) => ({
  text: `Is ${key} ready for UAT?`,
  agent: 'auto',
  scope: {},
  testType: 'uat',
  testTypeSource: 'user',
  tickets: [key],
  components: [],
  history: [],
  chatTitle: `UAT · ${key}`,
  ...ids,
  ...extra,
});

const saved = (events: WorkflowEvent[]) => events.find((e): e is Saved => e.type === 'saved');
const answer = (events: WorkflowEvent[]) => events.find((e): e is Answer => e.type === 'answer');
const firstApproval = (events: WorkflowEvent[]) => saved(events)?.approvals[0]?.id;

/** Every row of every table as text, to prove a value is nowhere in the database. */
const dump = (db: HorizonDb) =>
  (db.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((t) => JSON.stringify(db.raw.prepare(`SELECT * FROM "${t.name}"`).all())).join('\n');

let db: HorizonDb;
let api: TestApi;
beforeEach(async () => {
  db = fixtureDb();
  seedRefundTests(db);
  api = await startApi(db);
});
afterEach(() => api.close());

const ids = (n: string) => ({ chatId: `c${n}`, messageId: `m${n}`, answerId: `a${n}` });

describe('F01: writes stay inside the application and the chat owner', () => {
  it('refuses a run against another application’s chat without disclosing it, and writes nothing', async () => {
    const sourav = api.as('u-sourav', 'ABCD');
    await sourav.run(uatRun('ABCD-1001', ids('1')));
    const before = db.raw.prepare('SELECT COUNT(*) AS n FROM messages WHERE chat_id = ?').get('c1');

    const nabih = api.as('u-nabih', 'IBGM');
    await expect(nabih.run(uatRun('IBGM-1001', { chatId: 'c1', messageId: 'm9', answerId: 'a9' }))).rejects.toMatchObject({ status: 404 });
    expect(db.raw.prepare('SELECT COUNT(*) AS n FROM messages WHERE chat_id = ?').get('c1')).toEqual(before);
    expect(db.getChat('c1')?.applicationId).toBe('ABCD');

    // Reading follows the same rule: another application sees nothing; a teammate can read.
    expect((await nabih.get('/api/chats/c1')).status).toBe(404);
    expect((await api.as('u-ram', 'ABCD').get('/api/chats/c1')).status).toBe(200);
  });

  it('lets only the person who started a chat add to it', async () => {
    await api.as('u-sourav', 'ABCD').run(uatRun('ABCD-1001', ids('1')));
    await expect(api.as('u-ram', 'ABCD').run(uatRun('ABCD-1002', { chatId: 'c1', messageId: 'm2', answerId: 'a2' }))).rejects.toMatchObject({ status: 403 });
    expect(db.raw.prepare('SELECT COUNT(*) AS n FROM messages WHERE chat_id = ?').get('c1')).toEqual({ n: 2 });
  });

  it('rejects ids that do not belong together', async () => {
    const sourav = api.as('u-sourav', 'ABCD');
    await sourav.run(uatRun('ABCD-1001', ids('1')));
    // m1 is a message of c1, not c2.
    await expect(sourav.run(uatRun('ABCD-1001', { chatId: 'c2', messageId: 'm1', answerId: 'a2' }))).rejects.toMatchObject({ status: 409 });
    // a1 is an answer of c1, not c2.
    await expect(sourav.run(uatRun('ABCD-1001', { chatId: 'c2', messageId: 'm2', answerId: 'a1' }))).rejects.toMatchObject({ status: 409 });
    // An answer id cannot be used as a message id.
    await expect(sourav.run(uatRun('ABCD-1001', { chatId: 'c1', messageId: 'a1', answerId: 'a3' }))).rejects.toMatchObject({ status: 409 });
    // Partial identity is refused rather than silently unsaved.
    await expect(sourav.run({ ...uatRun('ABCD-1001', ids('4')), answerId: undefined })).rejects.toBeInstanceOf(RunRefused);
    expect(db.getChat('c2')).toBeUndefined();
  });
});

describe('F02: proposal ids carry the story key and criterion', () => {
  it('keeps ABCD-1001 and IBGM-1001 proposals apart', async () => {
    const abcd = await api.as('u-sourav', 'ABCD').run(uatRun('ABCD-1001', ids('1')));
    const ibgm = await api.as('u-nabih', 'IBGM').run(uatRun('IBGM-1001', ids('2')));
    const a = answer(abcd)!.artifact as UatArtifact;
    const b = answer(ibgm)!.artifact as UatArtifact;
    expect(a.proposedCases.map((c) => c.id)).toEqual(['UAT-ABCD-1001-AC4']);
    expect(b.proposedCases.map((c) => c.id)).toEqual(['UAT-IBGM-1001-AC1']);
    expect(db.listTests('ABCD', { kind: 'proposed' }).rows.map((r) => [r.externalId, r.title])).toEqual([['UAT-ABCD-1001-AC4', 'Partial refunds are allowed for 45 days from settlement']]);
    expect(db.listTests('IBGM', { kind: 'proposed' }).rows.map((r) => [r.externalId, r.title])).toEqual([['UAT-IBGM-1001-AC1', 'Statements export as PDF']]);
    expect(db.listTests('ABCD', { kind: 'proposed' }).rows[0].id).not.toBe(db.listTests('IBGM', { kind: 'proposed' }).rows[0].id);
  });

  it('gives the same gap the same id in every analysis, so re-analysis does not multiply proposals', async () => {
    const sourav = api.as('u-sourav', 'ABCD');
    await sourav.run(uatRun('ABCD-1001', ids('1')));
    await sourav.run(uatRun('ABCD-1001', ids('2')));
    expect(db.listTests('ABCD', { kind: 'proposed' }).total).toBe(1);
  });
});

describe('F03 and F09: approvals and ratings are decided by the server', () => {
  it('has no route that writes cases without an approval', async () => {
    const res = await api.as('u-sourav', 'ABCD').post('/api/hexa/manual/from-uat', { storyKey: 'ABCD-1001', cases: [{ id: 'x', title: 'y' }] });
    expect(res.status).toBe(404);
    expect(db.listTests('ABCD', { kind: 'manual' }).total).toBe(0);
  });

  it('requires a rating, then an approving role, then executes exactly the frozen payload', async () => {
    const sourav = api.as('u-sourav', 'ABCD');
    const events = await sourav.run(uatRun('ABCD-1001', ids('1')));
    const approvalId = firstApproval(events)!;
    const revisionId = saved(events)!.revisionId;
    expect(revisionId).toBe('a1-r1');

    // Not rated yet.
    expect((await sourav.post(`/api/approvals/${approvalId}/decision`, { decision: 'approved' })).status).toBe(403);
    // A low rating needs a reason and what was expected.
    expect((await sourav.post(`/api/answers/${revisionId}/rating`, { stars: 2 })).status).toBe(400);
    expect((await sourav.post(`/api/answers/${revisionId}/rating`, { stars: 5 })).status).toBe(200);
    // A plain member cannot approve, even after rating.
    const devi = api.as('u-devi', 'ABCD');
    expect((await devi.post(`/api/answers/${revisionId}/rating`, { stars: 4 })).status).toBe(200);
    expect((await devi.post(`/api/approvals/${approvalId}/decision`, { decision: 'approved' })).status).toBe(403);
    expect(db.listTests('ABCD', { kind: 'manual' }).total).toBe(0);

    // A component manager approves: the proposal becomes a manual test, linked to the story and criterion.
    const ok = await sourav.post(`/api/approvals/${approvalId}/decision`, { decision: 'approved' });
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { approval: { status: string; outcome: { ok: boolean; text: string }; decidedBy: string } };
    expect(body.approval).toMatchObject({ status: 'approved', decidedBy: 'Sourav', outcome: { ok: true, text: 'Added 1 manual test to Hexa, linked to ABCD-1001' } });
    const manual = db.listTests('ABCD', { kind: 'manual' }).rows;
    expect(manual).toHaveLength(1);
    expect(manual[0]).toMatchObject({ externalId: 'UAT-ABCD-1001-AC4', origin: 'uat_analyst', purpose: 'uat' });
    expect(manual[0].links).toEqual(expect.arrayContaining([{ type: 'criterion', ref: 'ABCD-1001#AC4' }, { type: 'story', ref: 'ABCD-1001' }]));
    expect(db.listTests('ABCD', { kind: 'proposed' }).total).toBe(0);

    // The same decision again returns what was recorded; a different one is a conflict.
    const again = await sourav.post(`/api/approvals/${approvalId}/decision`, { decision: 'approved' });
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ replay: true, approval: { status: 'approved' } });
    expect((await sourav.post(`/api/approvals/${approvalId}/decision`, { decision: 'declined' })).status).toBe(409);
    expect(db.listTests('ABCD', { kind: 'manual' }).total).toBe(1);
    expect(db.raw.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'approval.approved'").get()).toEqual({ n: 1 });
  });

  it('two simultaneous approvals produce one mutation and one audit row', async () => {
    const ram = api.as('u-ram', 'ABCD');
    const events = await ram.run(uatRun('ABCD-1001', ids('1')));
    const approvalId = firstApproval(events)!;
    await ram.post(`/api/answers/${saved(events)!.revisionId}/rating`, { stars: 5 });
    const [x, y] = await Promise.all([ram.post(`/api/approvals/${approvalId}/decision`, { decision: 'approved' }), ram.post(`/api/approvals/${approvalId}/decision`, { decision: 'approved' })]);
    expect([x.status, y.status]).toEqual([200, 200]);
    const bodies = (await Promise.all([x.json(), y.json()])) as { replay?: boolean }[];
    expect(bodies.filter((b) => b.replay).length).toBe(1);
    expect(db.raw.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'approval.approved'").get()).toEqual({ n: 1 });
    expect(db.raw.prepare("SELECT COUNT(*) AS n FROM hexa_uploads WHERE application_id = 'ABCD'").get()).toEqual({ n: 1 });
  });

  it('rolls back a failed action and leaves the approval pending', async () => {
    const sourav = api.as('u-sourav', 'ABCD');
    const events = await sourav.run(uatRun('ABCD-1001', ids('1')));
    const approvalId = firstApproval(events)!;
    await sourav.post(`/api/answers/${saved(events)!.revisionId}/rating`, { stars: 5 });
    // The story the payload names is no longer in this application (simulated by pointing it elsewhere).
    db.raw.prepare("UPDATE approvals SET payload = json_set(payload, '$.storyKey', 'IBGM-1001') WHERE id = ?").run(approvalId);
    const res = await sourav.post(`/api/approvals/${approvalId}/decision`, { decision: 'approved' });
    expect(res.status).toBe(409);
    expect(db.getApproval(approvalId)?.status).toBe('pending');
    expect(db.listTests('ABCD', { kind: 'manual' }).total).toBe(0);
    expect(db.raw.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action LIKE 'approval.%'").get()).toEqual({ n: 0 });
  });

  it('a declined approval records who and when, and never executes', async () => {
    const sourav = api.as('u-sourav', 'ABCD');
    const events = await sourav.run(uatRun('ABCD-1001', ids('1')));
    const res = await sourav.post(`/api/approvals/${firstApproval(events)}/decision`, { decision: 'declined' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ approval: { status: 'declined', decidedBy: 'Sourav' } });
    expect(db.listTests('ABCD', { kind: 'manual' }).total).toBe(0);
  });
});

describe('F04 and F14: revisions are immutable and approvals bind to one of them', () => {
  it('a regenerated answer gets a new revision; the old approval is superseded and its payload untouched', async () => {
    const sourav = api.as('u-sourav', 'ABCD');
    const first = await sourav.run(uatRun('ABCD-1001', ids('1')));
    const a1 = firstApproval(first)!;
    const rev1 = db.raw.prepare('SELECT blocks FROM answer_revisions WHERE id = ?').get('a1-r1') as { blocks: string };
    const payload1 = db.getApproval(a1)!.payload;
    expect(payload1.cases?.map((c) => c.id)).toEqual(['UAT-ABCD-1001-AC4']);

    // Evidence changes between the two runs: AC4 now has a linked test, so the second revision proposes nothing.
    const [, , ac3] = db.automatedCandidates('ABCD', 'acme/shop').map((c) => c.id);
    db.linkTest(ac3, 'criterion', 'ABCD-1001#AC4', 'u-sourav');
    const second = await sourav.run(uatRun('ABCD-1001', ids('1')));
    expect(saved(second)).toMatchObject({ revisionId: 'a1-r2', revision: 2, approvals: [] });
    expect((answer(second)!.artifact as UatArtifact).proposedCases).toEqual([]);

    // Revision 1 is exactly as it was; its approval is expired, not re-pointed, and cannot execute.
    expect(db.raw.prepare('SELECT blocks FROM answer_revisions WHERE id = ?').get('a1-r1')).toEqual(rev1);
    expect(db.getApproval(a1)).toMatchObject({ status: 'expired', supersededBy: 'a1-r2', payload: payload1 });
    expect(db.getArtifact('a1-r1', 'uat-abcd-1001')).toMatchObject({ proposedCases: [{ id: 'UAT-ABCD-1001-AC4' }] });
    expect(db.getArtifact('a1-r2', 'uat-abcd-1001')).toMatchObject({ proposedCases: [] });
    await sourav.post('/api/answers/a1-r1/rating', { stars: 5 });
    const res = await sourav.post(`/api/approvals/${a1}/decision`, { decision: 'approved' });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toMatch(/superseded/);
    expect(db.listTests('ABCD', { kind: 'manual' }).total).toBe(0);

    // A reload shows the latest revision with its own artifact and the rating per revision.
    const chat = (await (await sourav.get('/api/chats/c1')).json()) as { chat: { messages: { role: string; revision?: number; rating?: number | null; blocks?: Block[] }[]; artifacts: Record<string, UatArtifact> } };
    const latest = chat.chat.messages.find((m) => m.role === 'assistant')!;
    expect(latest.revision).toBe(2);
    expect(latest.rating).toBeNull();
    expect(chat.chat.artifacts['uat-abcd-1001'].proposedCases).toEqual([]);
  });

  it('a repeat analysis keeps proposing until the case is accepted, then reports the manual test', async () => {
    const sourav = api.as('u-sourav', 'ABCD');
    const hasApproval = (events: WorkflowEvent[]) => answer(events)!.blocks.some((b) => b.kind === 'approval');
    const first = await sourav.run(uatRun('ABCD-1001', ids('1')));
    expect(hasApproval(first)).toBe(true);
    const second = await sourav.run(uatRun('ABCD-1001', { chatId: 'c1', messageId: 'm2', answerId: 'a2' }));
    expect(hasApproval(second)).toBe(true);
    expect((answer(second)!.artifact as UatArtifact).criteria[3].status).toBe('no-test');

    await sourav.post(`/api/answers/${saved(second)!.revisionId}/rating`, { stars: 4 });
    expect((await sourav.post(`/api/approvals/${firstApproval(second)}/decision`, { decision: 'approved' })).status).toBe(200);

    const third = await sourav.run(uatRun('ABCD-1001', { chatId: 'c1', messageId: 'm3', answerId: 'a3' }));
    const art = answer(third)!.artifact as UatArtifact;
    expect(art.criteria[3]).toMatchObject({ status: 'not-run', evidence: expect.stringMatching(/manual/) });
    expect(hasApproval(third)).toBe(false);
    expect(db.listTests('ABCD', { kind: 'proposed' }).total).toBe(0);
  });
});

describe('F17: CI results reach the right application, once per run attempt', () => {
  let ci: TestApi;
  let baseline = 0;
  const count = () => (db.raw.prepare("SELECT COUNT(*) AS n FROM test_runs WHERE source = 'webhook'").get() as { n: number }).n;
  beforeEach(async () => {
    ci = await startApi(db, null, { ingestToken: 't-global', ingestTokens: { IBGM: 't-ibgm' } });
    baseline = count(); // the fixture's seed run is a webhook run too
  });
  afterEach(() => ci.close());

  const junit = (failing: boolean) => `<testsuite name="payments.PartialRefundsTest">
    <testcase classname="payments.PartialRefundsTest" name="aMerchantCanRefundPartOfASettledCardPayment" time="0.2"/>
    <testcase classname="payments.PartialRefundsTest" name="aRefundAboveTheOriginalAmountIsRejectedWithAClearMessage" time="0.3">${failing ? '<failure message="expected 422"/>' : ''}</testcase>
  </testsuite>`;
  /** The body docs/hexa-github-action.yml sends. */
  const payload = (over: Record<string, unknown> = {}) => ({
    app: 'ABCD',
    repo: 'acme/shop',
    sha: 'abc1234',
    branch: 'main',
    event: 'push',
    runId: '7001',
    attempt: 1,
    workflow: 'Tests (Hexa)',
    runUrl: 'https://github.com/acme/shop/actions/runs/7001',
    prNumber: 1482,
    mergeCommit: true,
    junit: [junit(true)],
    ...over,
  });
  const post = (body: unknown, token: string | null = 't-global') => ci.anonymous().post('/api/hexa/results', body, token ? { Authorization: `Bearer ${token}` } : {});
  const runs = () => count() - baseline;

  it('rejects a missing or wrong token, a missing or unknown application, and the wrong token for an application', async () => {
    expect((await post(payload(), null)).status).toBe(401);
    expect((await post(payload(), 'nope')).status).toBe(401);
    const missing = await post(payload({ app: undefined }));
    expect(missing.status).toBe(400);
    expect(((await missing.json()) as { error: string }).error).toMatch(/"app"/);
    expect((await post(payload({ app: 'NOPE' }))).status).toBe(400);
    // IBGM has its own token: the global one is not valid for it, and its token is not valid for ABCD.
    expect((await post(payload({ app: 'IBGM' }), 't-global')).status).toBe(401);
    expect((await post(payload({ app: 'ABCD' }), 't-ibgm')).status).toBe(401);
    expect((await post(payload({ app: 'IBGM' }), 't-ibgm')).status).toBe(200);
    expect(runs()).toBe(1);
  });

  it('records a delivery once, treats the same run and attempt again as a duplicate, and a rerun as a new attempt', async () => {
    const first = await post(payload());
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ total: 2, failed: 1, matched: 2 });
    expect(await (await post(payload())).json()).toMatchObject({ duplicate: true, runId: '7001', attempt: 1 });
    expect(runs()).toBe(1);
    expect(db.coverageFor('ABCD-1001')[1].status).toBe('failing');
    // The rerun passes and becomes the target build; the first attempt stays in history.
    const rerun = await post(payload({ attempt: 2, junit: [junit(false)] }));
    expect(rerun.status).toBe(200);
    expect(runs()).toBe(2);
    expect(db.coverageFor('ABCD-1001')[1]).toMatchObject({ status: 'passing', evidence: expect.stringMatching(/PR #1482 attempt 2/) });
    // Failures of a run are listed for the application's people.
    const list = (await (await api.as('u-sourav', 'ABCD').get('/api/hexa/runs')).json()) as { runs: { attempt: number; failures: { message: string | null }[] }[] };
    expect(list.runs.map((r) => r.attempt)).toEqual([2, 1, 1]);
    expect(list.runs[1].failures[0].message).toBe('expected 422');
  });

  it('rejects malformed JUnit by file name and keeps nothing', async () => {
    const res = await post(payload({ junit: ['<testsuite><testcase name="x"/>', 'not xml at all'] }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/results-\d\.xml/);
    expect(runs()).toBe(0);
    expect((await post(payload({ junit: ['<nothing/>'] }))).status).toBe(400);
  });

  it('an older delivery arriving late does not overwrite a newer result', async () => {
    await post(payload({ runId: '7002', startedAt: new Date(Date.now() - 60_000).toISOString(), junit: [junit(false)] }));
    expect(db.coverageFor('ABCD-1001')[1].status).toBe('passing');
    await post(payload({ runId: '7000', startedAt: new Date(Date.now() - 3_600_000 * 48).toISOString(), junit: [junit(true)] }));
    expect(db.coverageFor('ABCD-1001')[1].status).toBe('passing');
    expect(db.listRuns('ABCD')[0]).toMatchObject({ prNumber: 1482, status: 'passed' });
  });

  it('refuses a body over the upload limit', async () => {
    const big = `<testsuite name="s">${'<testcase classname="c" name="n"/>'.repeat(380_000)}</testsuite>`;
    expect(big.length).toBeGreaterThan(12 * 1024 * 1024);
    const status = await post(payload({ junit: [big] }))
      .then((r) => r.status)
      .catch(() => 'closed');
    // The server answers 413 as soon as the limit is crossed; a client still writing may see the connection close instead.
    expect([413, 'closed']).toContain(status);
    expect(runs()).toBe(0);
  });
});

describe('F05: a rejected secret is nowhere in the database', () => {
  it('stores neither the message, nor a title or metadata derived from it', async () => {
    const sourav = api.as('u-sourav', 'ABCD');
    const events = await sourav.run({ ...uatRun('ABCD-1001', ids('1')), text: `my key is ${SECRET}`, chatTitle: `key ${SECRET}` });
    expect(events.find((e) => e.type === 'rejected')).toMatchObject({ policy: { id: 'secret-in-input' } });
    expect(dump(db)).not.toContain(SECRET);
    expect(db.getChat('c1')?.title).toBe('Message removed');
    expect(db.raw.prepare('SELECT text, removed_reason FROM messages WHERE id = ?').get('m1')).toEqual({ text: '', removed_reason: 'secret-in-input' });
    expect(db.raw.prepare('SELECT COUNT(*) AS n FROM message_items').get()).toEqual({ n: 0 });
    // The rejection itself is kept as the answer, so a reload explains what happened.
    const chat = (await (await sourav.get('/api/chats/c1')).json()) as { chat: { messages: { role: string; text?: string; blocks?: Block[] }[] } };
    expect(chat.chat.messages[0].text).toBe('[Message removed: it contained a secret]');
    expect(chat.chat.messages[1].blocks?.some((b) => b.kind === 'rejected')).toBe(true);
  });

  it('treats an overlong message that carries a secret as a secret', async () => {
    const events = await api.as('u-sourav', 'ABCD').run({ ...uatRun('ABCD-1001', ids('1')), text: `${'x'.repeat(9000)} password=${SECRET}` });
    expect(events.find((e) => e.type === 'rejected')).toMatchObject({ policy: { id: 'secret-in-input' } });
    expect(dump(db)).not.toContain(SECRET);
  });

  it('keeps a secret out of a title even when the message itself is clean', async () => {
    await api.as('u-sourav', 'ABCD').run({ ...uatRun('ABCD-1001', ids('1')), chatTitle: `token=${SECRET}` });
    expect(dump(db)).not.toContain(SECRET);
    expect(db.getChat('c1')?.title).toBe('Message removed');
  });
});
