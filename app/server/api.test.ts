/**
 * Regression tests for the review findings, through the HTTP API (docs/FINDINGS.md):
 *   F01 cross-application chat writes · F02 proposal id collisions · F03 approval bypass
 *   F04 mutable evidence behind approvals · F05 secrets in titles · F09 server-side ratings and
 *   decisions · F14 repeat analysis and superseded approvals.
 * No model is configured, so every run goes through the rules router; the UAT analyst needs none.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Block, UatArtifact } from '../src/lib/types';
import type { WorkflowEvent } from '../src/lib/workflow';
import { validStartedAt } from './api';
import { RunRefused, startApi, type TestApi } from './api-harness';
import { seedContext } from './context';
import { openDb, seedWorkspace, type HorizonDb } from './db';
import { FIXTURE, fixtureDb, seedRefundTests } from './fixture';
import { LocalBlobStore, MemoryBlobStore } from './storage';

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
  // App Context as bootstrap seeds it: the fixture has no clone, so its repository is scan-only.
  seedContext(db, FIXTURE);
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
    // The Action sends the run's own start time (F17); without it a delivery never outranks a timed run.
    startedAt: new Date().toISOString(),
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

describe('F15: attachments are stored, scoped, and readable only when they really are', () => {
  const b64 = (s: string) => Buffer.from(s).toString('base64');
  const NOTES = '# Refund notes\nPartial refunds need a reason and are allowed for 45 days.';
  interface Att {
    id: string;
    filename: string;
    status: string;
    note: string | null;
    textChars: number;
  }
  const upload = async (client: ReturnType<TestApi['as']>, files: { filename: string; contentBase64: string }[], chatId?: string) => {
    const res = await client.post('/api/attachments', { files, chatId });
    return { status: res.status, body: (await res.json()) as { attachments: Att[]; errors: string[]; error?: string } };
  };

  it('keeps text readable, other formats as stored with the reason, and refuses empty or oversized files', async () => {
    const store = new MemoryBlobStore();
    const own = await startApi(db, null, { files: store });
    try {
      const sourav = own.as('u-sourav', 'ABCD');
      const { status, body } = await upload(sourav, [
        { filename: 'notes.md', contentBase64: b64(NOTES) },
        { filename: 'spec.pdf', contentBase64: b64('%PDF-1.4 ...') },
        { filename: 'empty.txt', contentBase64: '' },
        { filename: 'big.log', contentBase64: b64('x'.repeat(8 * 1024 * 1024 + 1)) },
        { filename: 'binary.txt', contentBase64: Buffer.from([0x41, 0x00, 0x42, 0x00, 0x43]).toString('base64') },
      ]);
      expect(status).toBe(200);
      expect(body.attachments.map((a) => [a.filename, a.status])).toEqual([
        ['notes.md', 'ready'],
        ['spec.pdf', 'stored'],
        ['binary.txt', 'stored'],
      ]);
      expect(body.attachments[0].textChars).toBe(NOTES.length);
      expect(body.attachments[1].note).toMatch(/not available in this build/);
      expect(body.attachments[2].note).toMatch(/not text/);
      expect(body.errors).toEqual(['empty.txt: the file is empty.', 'big.log is over the 8 MB limit.']);
      expect(store.blobs.size).toBe(3);
      // Metadata never includes the storage key; the bytes come back exactly.
      const meta = (await (await sourav.get(`/api/attachments/${body.attachments[0].id}`)).json()) as { attachment: Record<string, unknown> };
      expect(meta.attachment).toMatchObject({ filename: 'notes.md', status: 'ready', mime: 'text/markdown' });
      expect(meta.attachment.storageKey).toBeUndefined();
      const dl = await sourav.get(`/api/attachments/${body.attachments[0].id}?download=1`);
      expect(dl.headers.get('content-type')).toBe('text/markdown');
      expect(await dl.text()).toBe(NOTES);
      // Another application never learns the id exists.
      expect((await own.as('u-nabih', 'IBGM').get(`/api/attachments/${body.attachments[0].id}`)).status).toBe(404);
    } finally {
      await own.close();
    }
  });

  it('a run records the file on the message and binds it to the chat; other chats, people and applications cannot use it', async () => {
    const own = await startApi(db, null, { files: new MemoryBlobStore() });
    try {
      const sourav = own.as('u-sourav', 'ABCD');
      const { body } = await upload(sourav, [{ filename: 'notes.md', contentBase64: b64(NOTES) }]);
      const id = body.attachments[0].id;
      const events = await sourav.run(uatRun('ABCD-1001', ids('1'), { attachmentIds: [id] }));
      expect(saved(events)).toBeTruthy();
      // The UAT analyst says it did not use the file.
      expect(events.some((e) => e.type === 'step' && e.label === 'Attached files not used')).toBe(true);
      const chat = (await (await sourav.get('/api/chats/c1')).json()) as { chat: { messages: { role: string; attachments?: { id: string; filename: string; status: string }[] }[] } };
      expect(chat.chat.messages[0].attachments).toEqual([{ id, filename: 'notes.md', status: 'ready' }]);
      expect(db.getAttachment(id)?.chatId).toBe('c1');
      // Bound to c1: another chat of the same person cannot pull it in.
      await expect(sourav.run(uatRun('ABCD-1001', ids('2'), { attachmentIds: [id] }))).rejects.toMatchObject({ status: 409 });
      expect(db.getChat('c2')).toBeUndefined();
      // A teammate cannot use it (403), another application does not see it (404).
      await expect(own.as('u-ram', 'ABCD').run(uatRun('ABCD-1001', ids('3'), { attachmentIds: [id] }))).rejects.toMatchObject({ status: 403 });
      await expect(own.as('u-nabih', 'IBGM').run(uatRun('IBGM-1001', ids('4'), { attachmentIds: [id] }))).rejects.toMatchObject({ status: 404 });
      expect(db.raw.prepare('SELECT COUNT(*) AS n FROM messages').get()).toEqual({ n: 2 });
      // Uploading straight into someone else's chat is refused too.
      expect((await upload(own.as('u-ram', 'ABCD'), [{ filename: 'x.txt', contentBase64: b64('hello world') }], 'c1')).status).toBe(403);
    } finally {
      await own.close();
    }
  });

  it('survives a restart: metadata, text and bytes are back from disk, still scoped to the application', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hz-att-'));
    const path = join(dir, 'horizon.db');
    const db1 = openDb(path);
    seedWorkspace(db1, FIXTURE);
    const first = await startApi(db1, null, { files: new LocalBlobStore(join(dir, 'files')) });
    let id: string;
    try {
      const { body } = await upload(first.as('u-sourav', 'ABCD'), [{ filename: 'notes.md', contentBase64: b64(NOTES) }]);
      id = body.attachments[0].id;
    } finally {
      await first.close();
      db1.raw.close();
    }
    const db2 = openDb(path);
    const second = await startApi(db2, null, { files: new LocalBlobStore(join(dir, 'files')) });
    try {
      expect(db2.getAttachment(id!)).toMatchObject({ filename: 'notes.md', status: 'ready', textChars: NOTES.length });
      expect(db2.attachmentText(id!)).toBe(NOTES);
      expect(await (await second.as('u-sourav', 'ABCD').get(`/api/attachments/${id!}?download=1`)).text()).toBe(NOTES);
      expect((await second.as('u-nabih', 'IBGM').get(`/api/attachments/${id!}?download=1`)).status).toBe(404);
    } finally {
      await second.close();
      db2.raw.close();
    }
  });
});

describe('F11: App Context and Huddle through the API', () => {
  it('lists only the application’s sources, says what is not connected, and refuses a foreign source', async () => {
    const sourav = api.as('u-sourav', 'ABCD');
    const ctx = (await (await sourav.get('/api/context')).json()) as { sources: { id: string; type: string; status: string }[]; connectors: Record<string, string>; retrieval: { mode: string; state: string } };
    expect(ctx.sources.map((s) => [s.type, s.status])).toEqual([
      ['Jira', 'ready'],
      ['Repository', 'ready'],
    ]);
    expect(ctx.connectors).toMatchObject({ confluence: 'not_connected', fabric: 'none' });
    expect(ctx.retrieval).toMatchObject({ mode: 'keyword', state: 'off' });
    expect((await sourav.post('/api/context/confluence', { url: 'https://wiki.example.com/x' })).status).toBe(501);
    const nabih = api.as('u-nabih', 'IBGM');
    expect((await nabih.get(`/api/context/sources/${encodeURIComponent(ctx.sources[1].id)}`)).status).toBe(404);
    expect(((await (await nabih.get('/api/context')).json()) as { sources: unknown[] }).sources).toHaveLength(1);
  });

  it('uploads through the route, tests a question, and a teammate sees the passage', async () => {
    const own = await startApi(db, null, { files: new MemoryBlobStore() });
    try {
      const sourav = own.as('u-sourav', 'ABCD');
      const up = await sourav.post('/api/context/uploads', { files: [{ filename: 'runbook.md', contentBase64: Buffer.from('Restart checkoutservice with a rollout restart when it crashloops after a config change.').toString('base64') }], scope: 'app' });
      expect(up.status).toBe(200);
      const { sources } = (await up.json()) as { sources: { id: string; status: string; chunks: number }[] };
      expect(sources[0]).toMatchObject({ status: 'ready', chunks: 1 });
      const test = (await (await own.as('u-ram', 'ABCD').post('/api/context/test', { question: 'checkoutservice crashloops after config change' })).json()) as { results: { where: string; used: boolean }[] };
      expect(test.results[0]).toMatchObject({ where: 'runbook.md · runbook.md ¶1', used: true });
      const detail = (await (await own.as('u-ram', 'ABCD').get(`/api/context/sources/${sources[0].id}`)).json()) as { chunks: { locator: string }[] };
      expect(detail.chunks.map((c) => c.locator)).toEqual(['runbook.md ¶1']);
    } finally {
      await own.close();
    }
  });

  it('only an app owner decides; anyone in the application votes and comments; other applications see nothing', async () => {
    const sourav = api.as('u-sourav', 'ABCD');
    const raised = await sourav.post('/api/huddle', { kind: 'mapping', title: 'Who owns refunds?', summary: 'Two candidates.', options: ['checkoutservice', 'paymentservice'], affects: [{ label: 'ABCD-1001', href: '/tickets/ABCD-1001' }] });
    expect(raised.status).toBe(201);
    const { item } = (await raised.json()) as { item: { id: string; options: { id: string }[] } };
    expect((await api.as('u-devi', 'ABCD').post(`/api/huddle/${item.id}/vote`, { optionId: item.options[1].id })).status).toBe(200);
    expect((await api.as('u-devi', 'ABCD').post(`/api/huddle/${item.id}/comments`, { text: 'The tests live in paymentservice.' })).status).toBe(200);
    expect((await api.as('u-devi', 'ABCD').post(`/api/huddle/${item.id}/decide`, { optionId: item.options[1].id, reason: 'because' })).status).toBe(403);
    expect((await sourav.post(`/api/huddle/${item.id}/decide`, { optionId: item.options[1].id, reason: 'because' })).status).toBe(403);
    expect((await api.as('u-nabih', 'IBGM').get(`/api/huddle/${item.id}`)).status).toBe(404);
    expect((await api.as('u-nabih', 'IBGM').post(`/api/huddle/${item.id}/vote`, { optionId: item.options[0].id })).status).toBe(404);
    const decided = await api.as('u-ram', 'ABCD').post(`/api/huddle/${item.id}/decide`, { optionId: item.options[1].id, reason: 'The tests and page objects are there.' });
    expect(decided.status).toBe(200);
    expect(((await decided.json()) as { item: { decision: { by: string } } }).item.decision.by).toBe('Ram Kumar');
    expect((await sourav.post(`/api/huddle/${item.id}/vote`, { optionId: item.options[0].id })).status).toBe(409);
    expect(((await (await api.as('u-nabih', 'IBGM').get('/api/huddle')).json()) as { items: unknown[] }).items).toEqual([]);
  });

  it('three low ratings with the same reason raise one Huddle item by Catalyzt', async () => {
    const chats = [
      ['u-ram', '1'],
      ['u-sourav', '2'],
      ['u-devi', '3'],
    ] as const;
    let raised: string[] = [];
    for (const [who, n] of chats) {
      const c = api.as(who, 'ABCD');
      const events = await c.run(uatRun('ABCD-1001', ids(n)));
      const res = await c.post(`/api/answers/${saved(events)!.revisionId}/rating`, { stars: 2, reasons: ['Wrong coverage'], comment: 'The linked tests were not the ones that passed.' });
      expect(res.status).toBe(200);
      raised = ((await res.json()) as { raised: string[] }).raised;
    }
    expect(raised).toHaveLength(1);
    const list = (await (await api.as('u-ram', 'ABCD').get('/api/huddle')).json()) as { items: { id: string; kind: string; raisedBy: string; affects: { href: string }[] }[] };
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).toMatchObject({ id: raised[0], kind: 'feedback', raisedBy: 'Catalyzt' });
    expect(list.items[0].affects.map((a) => a.href).sort()).toEqual(['/chat/c1', '/chat/c2', '/chat/c3']);
    // A fourth low rating does not raise a second item while the first is open.
    const more = await api.as('u-ram', 'ABCD').run(uatRun('ABCD-1001', ids('4')));
    const again = await api.as('u-ram', 'ABCD').post(`/api/answers/${saved(more)!.revisionId}/rating`, { stars: 1, reasons: ['Wrong coverage'], comment: 'Same problem as before here.' });
    expect(((await again.json()) as { raised: string[] }).raised).toEqual([]);
  });
});

describe('workspace reload (development only)', () => {
  it('lets an app owner re-seed the running server and hides the route behind a proxy', async () => {
    let calls = 0;
    const own = await startApi(db, null, { reload: () => ({ summary: `reloaded ${++calls}` }) });
    try {
      expect((await own.as('u-sourav', 'ABCD').post('/api/workspace/reload', {})).status).toBe(403);
      const ok = await own.as('u-ram', 'ABCD').post('/api/workspace/reload', {});
      expect(ok.status).toBe(200);
      expect(await ok.json()).toEqual({ ok: true, summary: 'reloaded 1' });
      expect(db.raw.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'workspace.reload'").get()).toEqual({ n: 1 });
    } finally {
      await own.close();
    }
    const proxied = await startApi(db, null, { identity: { mode: 'proxy-header', header: 'x-forwarded-email' }, reload: () => ({ summary: 'no' }) });
    try {
      const res = await fetch(`${proxied.url}/api/workspace/reload`, { method: 'POST', headers: { 'x-forwarded-email': 'ram@example.com', 'Content-Type': 'application/json' }, body: '{}' });
      expect(res.status).toBe(404);
      expect(calls).toBe(1);
    } finally {
      await proxied.close();
    }
  });
});

describe('identity behind a sign-in proxy', () => {
  it('takes the person from the proxy header, ignores browser-chosen ids, and offers nobody to switch to', async () => {
    const proxied = await startApi(db, null, { identity: { mode: 'proxy-header', header: 'x-forwarded-email' } });
    try {
      const call = (headers: Record<string, string>) => fetch(`${proxied.url}/api/me`, { headers });
      expect((await call({})).status).toBe(401);
      expect((await call({ 'x-horizon-user': 'u-ram' })).status).toBe(401);
      expect((await call({ 'x-forwarded-email': 'stranger@example.com' })).status).toBe(403);
      const me = (await (await call({ 'x-forwarded-email': 'Sourav@Example.com', 'x-horizon-user': 'u-ram' })).json()) as { user: { id: string }; people: unknown[]; identity: string };
      expect(me.user.id).toBe('u-sourav');
      expect(me.people).toEqual([]);
      expect(me.identity).toBe('proxy');
      // A run is written under the proxied person, whatever the browser claims.
      const res = await fetch(`${proxied.url}/api/run`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-forwarded-email': 'sourav@example.com', 'x-horizon-user': 'u-ram', 'x-horizon-app': 'ABCD' }, body: JSON.stringify(uatRun('ABCD-1001', ids('p1'))) });
      expect(res.status).toBe(200);
      await res.text();
      expect(db.getChat('cp1')?.createdBy).toBe('u-sourav');
    } finally {
      await proxied.close();
    }
  });
});

describe('F05: a rejected secret is nowhere in the database', () => {
  it('stores neither the message, nor a title or metadata derived from it', async () => {
    const sourav = api.as('u-sourav', 'ABCD');
    const events = await sourav.run({ ...uatRun('ABCD-1001', ids('1')), text: `my key is ${SECRET}`, chatTitle: `key ${SECRET}` });
    expect(events.find((e) => e.type === 'rejected')).toMatchObject({ policy: { id: 'secret-in-input' } });
    expect(dump(db)).not.toContain(SECRET);
    expect(db.getChat('c1')?.title).toBe('Removed: it contained a secret');
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
    expect(db.getChat('c1')?.title).toBe('Removed: it contained a secret');
  });
});

describe('F19: a decision is authorised per component, not just per role', () => {
  const giveCheckoutToRam = () => db.raw.prepare("UPDATE components SET manager_id = 'u-ram' WHERE application_id = 'ABCD' AND name = 'checkoutservice'").run();

  it('a manager of another component can neither approve nor decline; the owner can; the refusal writes nothing', async () => {
    giveCheckoutToRam();
    const sourav = api.as('u-sourav', 'ABCD');
    const events = await sourav.run(uatRun('ABCD-1001', ids('1'))); // ABCD-1001 targets checkoutservice
    const approvalId = firstApproval(events)!;
    const revisionId = saved(events)!.revisionId;
    expect(db.getApproval(approvalId)?.payload.components).toEqual(['checkoutservice']);
    expect((await sourav.post(`/api/answers/${revisionId}/rating`, { stars: 5 })).status).toBe(200);

    const refused = await sourav.post(`/api/approvals/${approvalId}/decision`, { decision: 'approved' });
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { error: string }).error).toContain('checkoutservice');
    expect((await sourav.post(`/api/approvals/${approvalId}/decision`, { decision: 'declined' })).status).toBe(403);
    expect(db.listTests('ABCD', { kind: 'manual' }).total).toBe(0);
    expect(db.getApproval(approvalId)).toMatchObject({ status: 'pending', outcome: null });
    expect(db.raw.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action LIKE 'approval.%'").get()).toEqual({ n: 0 });

    const ram = api.as('u-ram', 'ABCD');
    expect((await ram.post(`/api/answers/${revisionId}/rating`, { stars: 4 })).status).toBe(200);
    const ok = await ram.post(`/api/approvals/${approvalId}/decision`, { decision: 'approved' });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { approval: { decidedBy: string } }).approval.decidedBy).toBe('Ram Kumar');
    expect(db.listTests('ABCD', { kind: 'manual' }).total).toBeGreaterThan(0);
  });

  it('mixed ownership needs an owner; a story without a component needs an owner; a manager still decides their own', async () => {
    // ABCD-1001 now targets checkoutservice (Ram's) and frontend (Sourav's).
    giveCheckoutToRam();
    const frontend = db.raw.prepare("SELECT id FROM components WHERE application_id = 'ABCD' AND name = 'frontend'").get() as { id: string };
    db.raw.prepare('INSERT INTO story_components (story_key, component_id) VALUES (?, ?)').run('ABCD-1001', frontend.id);
    const sourav = api.as('u-sourav', 'ABCD');
    const mixed = await sourav.run(uatRun('ABCD-1001', ids('1')));
    expect(db.getApproval(firstApproval(mixed)!)?.payload.components).toEqual(['checkoutservice', 'frontend']);
    await sourav.post(`/api/answers/${saved(mixed)!.revisionId}/rating`, { stars: 5 });
    const refused = await sourav.post(`/api/approvals/${firstApproval(mixed)}/decision`, { decision: 'approved' });
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { error: string }).error).toContain('checkoutservice');

    // No component at all: only the owner.
    db.raw.prepare("DELETE FROM story_components WHERE story_key = 'ABCD-1001'").run();
    const bare = await sourav.run(uatRun('ABCD-1001', ids('2')));
    expect(db.getApproval(firstApproval(bare)!)?.payload.components).toEqual([]);
    await sourav.post(`/api/answers/${saved(bare)!.revisionId}/rating`, { stars: 5 });
    expect((await sourav.post(`/api/approvals/${firstApproval(bare)}/decision`, { decision: 'approved' })).status).toBe(403);
    const ram = api.as('u-ram', 'ABCD');
    await ram.post(`/api/answers/${saved(bare)!.revisionId}/rating`, { stars: 5 });
    expect((await ram.post(`/api/approvals/${firstApproval(bare)}/decision`, { decision: 'approved' })).status).toBe(200);

    // Their own component: the manager decides, as before.
    db.raw.prepare('INSERT INTO story_components (story_key, component_id) VALUES (?, ?)').run('ABCD-1001', frontend.id);
    const own = await sourav.run(uatRun('ABCD-1001', ids('3')));
    const ownId = firstApproval(own);
    if (ownId) {
      await sourav.post(`/api/answers/${saved(own)!.revisionId}/rating`, { stars: 5 });
      expect((await sourav.post(`/api/approvals/${ownId}/decision`, { decision: 'declined' })).status).toBe(200);
    }
    expect(db.listTests('ABCD', { kind: 'manual' }).total).toBeGreaterThan(0);
  });
});

describe('R15: a newer analysis of the same story supersedes older pending proposals in other chats', () => {
  it('expires the older approval, answers its decision with 409, and the Home card lists only the newest', async () => {
    const sourav = api.as('u-sourav', 'ABCD');
    const ram = api.as('u-ram', 'ABCD');
    const first = await sourav.run(uatRun('ABCD-1001', ids('1')));
    const a1 = firstApproval(first)!;
    const second = await ram.run(uatRun('ABCD-1001', ids('2')));
    const a2 = firstApproval(second)!;
    expect(db.getApproval(a1)).toMatchObject({ status: 'expired', supersededBy: saved(second)!.revisionId });
    expect(db.getApproval(a2)?.status).toBe('pending');
    await sourav.post(`/api/answers/${saved(first)!.revisionId}/rating`, { stars: 5 });
    const res = await sourav.post(`/api/approvals/${a1}/decision`, { decision: 'approved' });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toMatch(/superseded/);
    const home = (await (await ram.get('/api/home')).json()) as { pendingApprovals: { id: string }[] };
    expect(home.pendingApprovals.map((p) => p.id)).toEqual([a2]);
    // Another story's analysis leaves it alone.
    await sourav.run(uatRun('ABCD-1002', ids('3')));
    expect(db.getApproval(a2)?.status).toBe('pending');
  });
});

describe('F17: run timing comes from CI, never from arrival', () => {
  let ci: TestApi;
  beforeEach(async () => {
    ci = await startApi(db, null, { ingestToken: 't-global' });
  });
  afterEach(() => ci.close());
  const junit = (failing: boolean) => `<testsuite name="payments.PartialRefundsTest">
    <testcase classname="payments.PartialRefundsTest" name="aRefundAboveTheOriginalAmountIsRejectedWithAClearMessage" time="0.3">${failing ? '<failure message="expected 422"/>' : ''}</testcase>
  </testsuite>`;
  const post = (over: Record<string, unknown>) =>
    ci.anonymous().post('/api/hexa/results', { app: 'ABCD', repo: 'acme/shop', sha: 'abc1234', branch: 'main', event: 'push', attempt: 1, workflow: 'Tests', prNumber: 1482, mergeCommit: true, ...over }, { Authorization: 'Bearer t-global' });

  it('a delivery without run timing never displaces a timed one; future or garbage times count as missing', async () => {
    expect((await post({ runId: '8002', startedAt: new Date(Date.now() - 60_000).toISOString(), junit: [junit(false)] })).status).toBe(200);
    expect(db.coverageFor('ABCD-1001')[1].status).toBe('passing');
    // Arrives later, carries no timing: it must not become the target build.
    expect((await post({ runId: '8001', junit: [junit(true)] })).status).toBe(200);
    expect(db.coverageFor('ABCD-1001')[1].status).toBe('passing');
    expect(db.targetBuild('ABCD', 'acme/shop')?.label).not.toContain('timed by delivery');
    // A time in the future or nonsense is treated as missing, not as "now".
    expect((await post({ runId: '8003', startedAt: '2999-01-01T00:00:00Z', junit: [junit(true)] })).status).toBe(200);
    expect((await post({ runId: '8004', startedAt: 'yesterday-ish', junit: [junit(true)] })).status).toBe(200);
    expect(db.coverageFor('ABCD-1001')[1].status).toBe('passing');
    expect(validStartedAt('2999-01-01T00:00:00Z')).toBeNull();
    expect(validStartedAt('1999-12-31T00:00:00Z')).toBeNull();
    expect(validStartedAt('2026-11-08T03:00:00Z')).toBe('2026-11-08T03:00:00.000Z');
  });

  it('with only untimed runs, the latest delivery is the target and its label says it was timed by delivery', async () => {
    db.raw.prepare("DELETE FROM test_runs WHERE application_id = 'ABCD'").run();
    expect((await post({ runId: '8010', junit: [junit(true)] })).status).toBe(200);
    expect((await post({ runId: '8011', junit: [junit(false)] })).status).toBe(200);
    expect(db.targetBuild('ABCD', 'acme/shop')?.label).toContain('timed by delivery');
    expect(db.coverageFor('ABCD-1001')[1].status).toBe('passing');
  });
});

describe('F05: files that hold a secret are refused, not stored', () => {
  it('an attachment with a key in it is not kept and leaves no trace', async () => {
    const sourav = api.as('u-sourav', 'ABCD');
    const res = await sourav.post('/api/attachments', { files: [{ filename: 'creds.md', contentBase64: Buffer.from(`deploy key ${SECRET} for prod`).toString('base64') }, { filename: 'ok.md', contentBase64: Buffer.from('Nothing secret in here, just notes about refunds.').toString('base64') }] });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { attachments: { filename: string }[]; errors: string[] };
    expect(body.attachments.map((a) => a.filename)).toEqual(['ok.md']);
    expect(body.errors[0]).toMatch(/creds\.md.*not kept/);
    expect(dump(db)).not.toContain(SECRET);
  });
});

describe('R13: the story list carries the latest saved UAT analysis', () => {
  it('shows who analysed a story and when, for everyone and after a reload', async () => {
    const sourav = api.as('u-sourav', 'ABCD');
    await sourav.run(uatRun('ABCD-1001', ids('1')));
    const list = (await (await api.as('u-ram', 'ABCD').get('/api/stories')).json()) as { stories: { key: string; uat: { state: string; covered: number; total: number; chatId?: string; by?: string | null; analysedAt?: string } }[] };
    const analysed = list.stories.find((s) => s.key === 'ABCD-1001')!.uat;
    expect(analysed).toMatchObject({ state: 'gaps', total: 4, chatId: 'c1', by: 'Sourav' });
    expect(analysed.covered).toBeGreaterThanOrEqual(0);
    expect(analysed.analysedAt).toBeTruthy();
    expect(list.stories.find((s) => s.key === 'ABCD-1002')!.uat).toMatchObject({ state: 'not-analysed', covered: 0, total: 2 });
    // Another application never sees it.
    const other = (await (await api.as('u-nabih', 'IBGM').get('/api/stories')).json()) as { stories: { uat: { state: string } }[] };
    expect(other.stories.every((s) => s.uat.state === 'not-analysed')).toBe(true);
  });
});
