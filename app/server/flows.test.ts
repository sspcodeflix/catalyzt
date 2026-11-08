/**
 * Test flows (docs/FLOWS.md): a UAT flow over a story moves through Analyse → Review cases → Run tests
 * → Sign off, with every step derived from the records, and the same view for everyone on the team.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { startApi, type TestApi } from './api-harness';
import { hexaEvidence } from './evidence';
import type { HorizonDb } from './db';
import { fixtureDb, seedRefundTests } from './fixture';
import { analyseStory, type BulkReviewResult, type FlowView } from './flows';

let db: HorizonDb;
let api: TestApi;
beforeEach(async () => {
  db = fixtureDb();
  seedRefundTests(db);
  api = await startApi(db);
});
afterEach(() => api.close());

const view = async (who: string, id: string) => ((await (await api.as(who, 'ABCD').get(`/api/flows/${id}`)).json()) as { flow: FlowView }).flow;
async function until(who: string, id: string, ok: (f: FlowView) => boolean) {
  for (let i = 0; i < 60; i++) {
    const f = await view(who, id);
    if (ok(f)) return f;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('flow did not get there');
}
const step = (f: FlowView, key: string) => f.items[0].steps.find((s) => s.key === key)!;

describe('a UAT flow', () => {
  it('analyses in the background, waits on the right people, and ends with a sign-off', async () => {
    const sourav = api.as('u-sourav', 'ABCD');
    const res = await sourav.post('/api/flows', { kind: 'uat', stories: ['ABCD-1001'] });
    expect(res.status).toBe(201);
    const id = ((await res.json()) as { flow: FlowView }).flow.id;

    // The analysis runs as a job; nobody has to keep the page open.
    let f = await until('u-sourav', id, (x) => step(x, 'analyse').state === 'done');
    expect(f.coverage).toMatchObject({ baseline: 50, criteria: 4 });
    // AC4 had no test, so a case was drafted: the component manager reviews it.
    expect(step(f, 'review')).toMatchObject({ state: 'waiting', waitingOn: [{ id: 'u-sourav', name: 'Sourav' }] });
    expect(f.waiting[0]).toMatchObject({ you: true, action: 'Review cases', stories: ['ABCD-1001'] });
    // Another member sees the same flow at the same step, waiting on Sourav, not on them.
    const asRam = await view('u-ram', id);
    expect(asRam.current).toMatchObject({ key: 'review' });
    expect(asRam.waiting[0]).toMatchObject({ you: false, person: { name: 'Sourav' } });

    // The flow carries the review itself: the drafted case under its requirement.
    const chatId = f.items[0].chatId!;
    const approvals = db.listPendingApprovals('ABCD').filter((a) => a.chatId === chatId);
    expect(approvals).toHaveLength(1);
    expect(f.items[0].review).toMatchObject({ approvalId: approvals[0].id, status: 'pending' });
    expect(f.items[0].review!.cases.map((c) => c.criterion)).toEqual(['AC4']);
    expect(step(f, 'review').detail).toBe('1 drafted case for 1 requirement waits for review.');
    // Reviewing in a flow is the flow's step, not feedback on the answer: no rating is needed to approve.
    expect((await sourav.post(`/api/approvals/${approvals[0].id}/decision`, { decision: 'approved' })).status).toBe(200);

    // Now the testers: AC4's manual case needs a result; AC3's automated test has none either.
    f = await view('u-sourav', id);
    expect(step(f, 'review').state).toBe('done');
    expect(step(f, 'run')).toMatchObject({ state: 'waiting', action: { kind: 'execute' } });
    expect(step(f, 'run').detail).toMatch(/^AC4 needs a person to run the manual case in the UAT environment and record Passed, Failed or Blocked here\./);
    const ac4 = f.items[0].manual.find((m) => m.criterion === 'AC4')!;
    expect(ac4.steps.length).toBeGreaterThan(0);
    // A plain member cannot record a result; a failure needs a reason.
    expect((await api.as('u-devi', 'ABCD').post(`/api/hexa/tests/${ac4.id}/executions`, { status: 'passed' })).status).toBe(403);
    expect((await sourav.post(`/api/hexa/tests/${ac4.id}/executions`, { status: 'failed' })).status).toBe(400);
    expect((await sourav.post(`/api/hexa/tests/${ac4.id}/executions`, { status: 'passed', note: 'checked in staging' })).status).toBe(201);
    f = await view('u-sourav', id);
    expect(f.items[0].criteria.find((c) => c.id === 'AC4')!.verified).toBe(true);
    // AC3 still has only an automated test with no result: the run step is not done, so no sign-off.
    expect(step(f, 'run').state).not.toBe('done');
    expect((await api.as('u-ram', 'ABCD').post(`/api/flows/${id}/signoff`, { storyKey: 'ABCD-1001', decision: 'signed_off' })).status).toBe(409);

    // AC3's test passes in CI: everything is verified and the component manager signs off; the flow is done.
    const ac3 = db.coverageFor('ABCD-1001')[2].tests[0].id;
    db.ingestRun({ app: 'ABCD', source: 'webhook', repo: 'acme/shop', workflow: 'CI', externalRunId: 'r2', attempt: 1, runUrl: null, event: 'push', branch: 'main', sha: 'seed124', prNumber: 42, isMerge: true, startedAt: new Date().toISOString() },
      db.coverageFor('ABCD-1001').flatMap((c) => c.tests.filter((t) => t.kind === 'automated')).map((t) => ({ testCaseId: t.id, status: 'passed' as const, durationMs: 1, message: null })), 'u-sourav');
    expect(ac3).toBeTruthy();
    f = await view('u-ram', id);
    expect(step(f, 'run').state).toBe('done');
    // Sign-off waits on the story's manager, not the app owner; a plain member cannot sign off.
    expect(step(f, 'signoff')).toMatchObject({ state: 'waiting', waitingOn: [{ id: 'u-sourav', name: 'Sourav' }] });
    expect((await api.as('u-devi', 'ABCD').post(`/api/flows/${id}/signoff`, { storyKey: 'ABCD-1001', decision: 'signed_off' })).status).toBe(403);
    expect((await sourav.post(`/api/flows/${id}/signoff`, { storyKey: 'ABCD-1001', decision: 'signed_off' })).status).toBe(200);
    f = await view('u-sourav', id);
    expect(f.status).toBe('done');
    expect(f.coverage.now).toBe(100);
    // Outside the flow the story now reads as signed off, not as the gaps its analysis found.
    const listed = ((await (await sourav.get('/api/stories')).json()) as { stories: { key: string; uat: { state: string; covered: number; signedOff?: { by: string } } }[] }).stories;
    expect(listed.find((s) => s.key === 'ABCD-1001')!.uat).toMatchObject({ state: 'signed-off', signedOff: { by: 'Sourav' } });
    expect(f.events.map((e) => e.text).join('\n')).toMatch(/Signed off ABCD-1001[\s\S]*Passed: [\s\S]*UAT analyst checked ABCD-1001[\s\S]*Started with 1 story/);
  });

  it('refuses people who cannot start or change a flow', async () => {
    expect((await api.as('u-devi', 'ABCD').post('/api/flows', { kind: 'uat', stories: ['ABCD-1001'] })).status).toBe(403);
    expect((await api.as('u-sourav', 'ABCD').post('/api/flows', { kind: 'uat', stories: ['IBGM-1001'] })).status).toBe(400);
    expect((await api.as('u-sourav', 'ABCD').post('/api/flows', { kind: 'uat', stories: [] })).status).toBe(400);
    const id = ((await (await api.as('u-sourav', 'ABCD').post('/api/flows', { kind: 'regression', stories: ['ABCD-1001'] })).json()) as { flow: FlowView }).flow.id;
    // One regression flow at a time per application.
    expect((await api.as('u-ram', 'ABCD').post('/api/flows', { kind: 'regression', stories: ['ABCD-1002'] })).status).toBe(409);
    expect((await api.as('u-devi', 'ABCD').post(`/api/flows/${id}/status`, { status: 'paused' })).status).toBe(403);
    expect((await api.as('u-ram', 'ABCD').post(`/api/flows/${id}/status`, { status: 'paused' })).status).toBe(200);
    // Another application cannot see it.
    expect((await api.as('u-nabih', 'IBGM').get(`/api/flows/${id}`)).status).toBe(404);
  });
});

describe('who a step waits on', () => {
  it('needs every manager of a story spanning two managers\' components; the app owner is not required and cannot approve for them', async () => {
    // ABCD-1001 now spans checkoutservice (Sourav) and frontend (Devi as its manager, for this test).
    db.raw.prepare("UPDATE components SET manager_id = 'u-devi' WHERE application_id = 'ABCD' AND name = 'frontend'").run();
    db.raw.prepare("INSERT INTO story_components (story_key, component_id) SELECT 'ABCD-1001', id FROM components WHERE application_id = 'ABCD' AND name = 'frontend'").run();
    await api.close();
    api = await startApi(db);
    const id = ((await (await api.as('u-ram', 'ABCD').post('/api/flows', { kind: 'uat', stories: ['ABCD-1001'] })).json()) as { flow: FlowView }).flow.id;
    const f = await until('u-ram', id, (x) => step(x, 'analyse').state === 'done');
    expect(step(f, 'review').waitingOn.map((p) => p.id).sort()).toEqual(['u-devi', 'u-sourav']);
    expect(f.items[0].review!.approvers.map((a) => [a.id, a.why])).toEqual(expect.arrayContaining([['u-sourav', 'manages checkoutservice'], ['u-devi', 'manages frontend']]));
    expect(f.items[0].can.review).toBe(false);
    const approvalId = f.items[0].review!.approvalId;
    expect((await api.as('u-ram', 'ABCD').post(`/api/approvals/${approvalId}/decision`, { decision: 'approved' })).status).toBe(403);
    // Devi approves: one of two approvals is in; the cases are not added yet and the step waits on Sourav.
    expect((await api.as('u-devi', 'ABCD').post(`/api/approvals/${approvalId}/decision`, { decision: 'approved' })).status).toBe(200);
    expect(db.getApproval(approvalId)?.status).toBe('pending');
    let g = await view('u-sourav', id);
    expect(step(g, 'review')).toMatchObject({ state: 'waiting', waitingOn: [{ id: 'u-sourav' }] });
    expect(step(g, 'review').detail).toMatch(/approved by Devi; 1 approval still to come\.$/);
    expect(g.items[0].can.review).toBe(true);
    // Sourav approves: the proposal is decided and the cases added.
    expect((await api.as('u-sourav', 'ABCD').post(`/api/approvals/${approvalId}/decision`, { decision: 'approved' })).status).toBe(200);
    expect(db.getApproval(approvalId)?.status).toBe('approved');
    g = await view('u-sourav', id);
    expect(step(g, 'review')).toMatchObject({ state: 'done', detail: 'Cases approved by Devi and Sourav.' });
  });

  it('lets a manager add people whose approval the cases also need, and remove them', async () => {
    const sourav = api.as('u-sourav', 'ABCD');
    const id = ((await (await sourav.post('/api/flows', { kind: 'uat', stories: ['ABCD-1001'] })).json()) as { flow: FlowView }).flow.id;
    const f = await until('u-sourav', id, (x) => step(x, 'review').state === 'waiting');
    const approvalId = f.items[0].review!.approvalId;
    const approvers = (body: unknown, who = 'u-sourav') => api.as(who, 'ABCD').post(`/api/flows/${id}/approvers`, body);
    // The members to choose from. A plain member cannot change the list; a manager is not added twice; outsiders are refused.
    const people = ((await (await sourav.get('/api/flows/people')).json()) as { people: { id: string }[] }).people.map((p) => p.id);
    expect(people).toEqual(expect.arrayContaining(['u-ram', 'u-sourav', 'u-devi']));
    expect((await approvers({ storyKey: 'ABCD-1001', add: ['u-ram'] }, 'u-devi')).status).toBe(403);
    expect((await approvers({ storyKey: 'ABCD-1001', add: ['u-sourav'] })).status).toBe(400);
    expect((await approvers({ storyKey: 'ABCD-1001', add: ['u-nobody'] })).status).toBe(400);
    // Ram and Devi are added: three approvals needed, and each sees the story waiting on them.
    expect((await approvers({ storyKey: 'ABCD-1001', add: ['u-ram', 'u-devi'] })).status).toBe(200);
    let g = await view('u-ram', id);
    expect(step(g, 'review').waitingOn.map((p) => p.id).sort()).toEqual(['u-devi', 'u-ram', 'u-sourav']);
    expect(g.items[0].review!.approvers.find((a) => a.id === 'u-ram')?.why).toBe('added by Sourav');
    expect(g.waiting.find((w) => w.you)).toMatchObject({ action: 'Review cases', stories: ['ABCD-1001'] });
    expect(g.items[0].can.review).toBe(true);
    // Sourav and Ram approve; Devi is removed: nothing is left to wait for, so the cases are added.
    expect((await sourav.post(`/api/approvals/${approvalId}/decision`, { decision: 'approved' })).status).toBe(200);
    expect((await api.as('u-ram', 'ABCD').post(`/api/approvals/${approvalId}/decision`, { decision: 'approved' })).status).toBe(200);
    expect(db.getApproval(approvalId)?.status).toBe('pending');
    expect((await approvers({ storyKey: 'ABCD-1001', remove: ['u-devi'] })).status).toBe(200);
    expect(db.getApproval(approvalId)?.status).toBe('approved');
    g = await view('u-sourav', id);
    expect(step(g, 'review').state).toBe('done');
    const texts = g.events.map((e) => e.text).join('\n');
    expect(texts).toMatch(/Asked .+ to also approve the cases for ABCD-1001\./);
    expect(texts).toMatch(/Sourav approved the drafted cases for ABCD-1001; waiting on /);
    expect(texts).toMatch(/no longer needs to approve the cases for ABCD-1001\./);
    expect(texts).toMatch(/Approved the drafted cases for ABCD-1001: Added/);
  });
});

describe('test flows in chat', () => {
  const ask = (text: string, n: string) => ({ text, agent: 'auto', scope: {}, testType: null, testTypeSource: null, tickets: [], components: [], history: [], chatId: `c${n}`, messageId: `m${n}`, answerId: `a${n}` });
  const blocksOf = (events: { type: string; blocks?: { kind: string }[] }[]) => events.find((e) => e.type === 'answer')?.blocks ?? [];
  it('proposes a flow with Start, then answers where it stands and what waits on me, live', async () => {
    const sourav = api.as('u-sourav', 'ABCD');
    // Start: a card with the stories found; nothing is created by the answer itself.
    let events = (await sourav.run(ask('Start UAT for the Ready for UAT stories', '1'))) as never[];
    const start = blocksOf(events).find((b) => b.kind === 'flow_start') as unknown as { stories: { key: string }[]; flowKind: string };
    expect(start).toMatchObject({ flowKind: 'uat' });
    expect(start.stories.map((s) => s.key)).toEqual(expect.arrayContaining(['ABCD-1001', 'ABCD-1002']));
    expect(db.raw.prepare('SELECT COUNT(*) AS n FROM flows').get()).toEqual({ n: 0 });
    // Pressing Start (the card posts with the answer's revision as origin); pressing it again gives the same flow.
    const one = (await (await sourav.post('/api/flows', { kind: 'uat', stories: ['ABCD-1001'], origin: 'a1-r1' })).json()) as { flow: FlowView };
    const two = (await (await sourav.post('/api/flows', { kind: 'uat', stories: ['ABCD-1001'], origin: 'a1-r1' })).json()) as { flow: FlowView };
    expect(two.flow.id).toBe(one.flow.id);
    expect(((await (await sourav.get('/api/flows?origin=a1-r1')).json()) as { flowId: string }).flowId).toBe(one.flow.id);
    await until('u-sourav', one.flow.id, (x) => step(x, 'analyse').state === 'done');
    // The flow's own analysis chats are the flow's, not the person's recents.
    const recents = ((await (await sourav.get('/api/chats')).json()) as { chats: { id: string }[] }).chats.map((c) => c.id);
    const flowChat = (await view('u-sourav', one.flow.id)).items[0].chatId!;
    expect(recents).not.toContain(flowChat);
    expect(recents).toContain('c1');

    // Where it stands: a live card for the flow holding the story, and a sentence naming its step.
    events = (await sourav.run(ask('Where is the UAT for ABCD-1001?', '2'))) as never[];
    expect(blocksOf(events)).toContainEqual({ kind: 'flow', flowId: one.flow.id });
    const prose = (blocksOf(events).find((b) => b.kind === 'prose') as unknown as { text: string }).text;
    expect(prose).toMatch(/ABCD-1001 is at Review cases: .* It waits on you\./);

    // What waits on me.
    events = (await sourav.run(ask("What's waiting on me?", '3'))) as never[];
    expect(blocksOf(events).map((b) => b.kind)).toContain('flows_waiting');
    expect((blocksOf(events).find((b) => b.kind === 'prose') as unknown as { text: string }).text).toMatch(/review cases for ABCD-1001/);

    // A story in no flow still gets the readiness report.
    events = (await sourav.run(ask('What is the UAT status of ABCD-1002?', '4'))) as never[];
    expect(blocksOf(events).map((b) => b.kind)).not.toContain('flow');
  });
});

describe('a flow\'s team thread', () => {
  const say = (text: string, chatId: string, n: string) => ({ text, agent: 'auto', scope: {}, testType: null, testTypeSource: null, tickets: [], components: [], history: [], chatId, messageId: `tm${n}`, answerId: `ta${n}` });
  it('is open to every member, answers about its flow, and stays out of personal recents', async () => {
    const sourav = api.as('u-sourav', 'ABCD');
    const devi = api.as('u-devi', 'ABCD');
    const id = ((await (await sourav.post('/api/flows', { kind: 'uat', stories: ['ABCD-1001'] })).json()) as { flow: FlowView }).flow.id;
    const f = await until('u-sourav', id, (x) => step(x, 'analyse').state === 'done');
    expect(f.threadId).toBe(`thread-${id}`);

    // Devi, a plain member, writes in the thread and gets the flow's state without naming it.
    const events = await devi.run(say('What is blocked and who are we waiting on?', f.threadId, '1'));
    const answer = events.find((e) => e.type === 'answer') as { blocks: { kind: string; text?: string; flowId?: string }[] } | undefined;
    expect(answer?.blocks).toContainEqual({ kind: 'flow', flowId: id });
    expect(answer?.blocks.find((b) => b.kind === 'prose')?.text).toMatch(/is at Review cases/);
    // Both people's messages are in the thread, each with its author.
    await sourav.run(say('I will review the cases today.', f.threadId, '2'));
    const chat = ((await (await devi.get(`/api/chats/${f.threadId}`)).json()) as { chat: { flowId: string; messages: { role: string; author?: { name: string } }[] } }).chat;
    expect(chat.flowId).toBe(id);
    expect(chat.messages.filter((m) => m.role === 'user').map((m) => m.author?.name)).toEqual(['Devi', 'Sourav']);
    // A personal chat is still its owner's alone.
    const own = await sourav.run(say('Is ABCD-1002 ready for UAT?', 'personal', '3'));
    expect(own.some((e) => e.type === 'answer')).toBe(true);
    expect((await devi.post('/api/run', say('hello', 'personal', '4'))).status).toBe(403);
    // The thread lives with the flow, not in anyone's recents.
    const recents = ((await (await sourav.get('/api/chats')).json()) as { chats: { id: string }[] }).chats.map((c) => c.id);
    expect(recents).not.toContain(f.threadId);
    // Another application cannot read or write it.
    expect((await api.as('u-nabih', 'IBGM').get(`/api/chats/${f.threadId}`)).status).toBe(404);
  });
});

describe('a failed background analysis', () => {
  it('leaves one chat, linked to the flow, with the failure as its answer, out of Recents; a retry reuses it', async () => {
    const sourav = api.as('u-sourav', 'ABCD');
    const id = ((await (await sourav.post('/api/flows', { kind: 'uat', stories: ['ABCD-1002'] })).json()) as { flow: FlowView }).flow.id;
    // Let the queued job finish first, then fail the next run on purpose.
    for (let i = 0; i < 40 && !(db.raw.prepare("SELECT 1 FROM jobs WHERE kind = 'flow.analyse' AND status = 'done'").get()); i++) await new Promise((r) => setTimeout(r, 50));
    const spy = vi.spyOn(db, 'suggestTests').mockImplementation(() => {
      throw new Error('database unavailable');
    });
    await expect(analyseStory(db, null, id, 'ABCD-1002')).rejects.toThrow();
    await expect(analyseStory(db, null, id, 'ABCD-1002')).rejects.toThrow();
    spy.mockRestore();
    const chatId = `fa-${id}-ABCD-1002`;
    expect(db.raw.prepare('SELECT chat_id FROM flow_items WHERE flow_id = ?').get(id)).toEqual({ chat_id: chatId });
    const chat = ((await (await sourav.get(`/api/chats/${chatId}`)).json()) as { chat: { messages: { role: string; status?: string; blocks?: { kind: string; text?: string }[] }[] } }).chat;
    const answers = chat.messages.filter((m) => m.role === 'assistant');
    // Every question in the chat has an answer; the failed ones say why.
    expect(chat.messages.filter((m) => m.role === 'user')).toHaveLength(answers.length);
    expect(answers.at(-1)).toMatchObject({ status: 'error' });
    expect(answers.at(-1)!.blocks!.find((b) => b.kind === 'prose')?.text).toMatch(/The analysis failed: .*database unavailable/);
    const recents = ((await (await sourav.get('/api/chats')).json()) as { chats: { id: string }[] }).chats.map((c) => c.id);
    expect(recents).not.toContain(chatId);
    // Only one chat for the story, however many attempts.
    expect(db.raw.prepare("SELECT COUNT(*) AS n FROM chats WHERE id LIKE 'fa-%'").get()).toEqual({ n: 1 });
  });
});

describe('one flow per story', () => {
  it('refuses a second UAT flow over a story already in one, from the page, from adding stories and from chat', async () => {
    const sourav = api.as('u-sourav', 'ABCD');
    const first = ((await (await sourav.post('/api/flows', { kind: 'uat', title: 'UAT · first', stories: ['ABCD-1001'] })).json()) as { flow: FlowView }).flow.id;
    // A second press, a retry after an error, another tab: no second flow.
    const again = await sourav.post('/api/flows', { kind: 'uat', stories: ['ABCD-1001', 'ABCD-1002'] });
    expect(again.status).toBe(409);
    expect(((await again.json()) as { error: string }).error).toMatch(/ABCD-1001 is already in the UAT flow "UAT · first"/);
    expect(db.raw.prepare("SELECT COUNT(*) AS n FROM flows WHERE kind = 'uat'").get()).toEqual({ n: 1 });
    // The start page knows which stories are taken.
    const taken = ((await (await sourav.get('/api/flows/taken?kind=uat')).json()) as { taken: { key: string; flowId: string }[] }).taken;
    expect(taken).toEqual([{ key: 'ABCD-1001', flowId: first, title: 'UAT · first' }]);
    // Adding it to another flow is refused too.
    const other = ((await (await sourav.post('/api/flows', { kind: 'uat', stories: ['ABCD-1002'] })).json()) as { flow: FlowView }).flow.id;
    expect((await sourav.post(`/api/flows/${other}/stories`, { add: ['ABCD-1001'] })).status).toBe(409);
    // From chat: the story is left out and its flow is shown; nothing new is offered.
    const events = await sourav.run({ text: 'start UAT for ABCD-1001', agent: 'auto', scope: {}, testType: 'uat', testTypeSource: 'user', tickets: ['ABCD-1001'], components: [], history: [], chatId: 'c1', messageId: 'm1', answerId: 'a1' });
    const text = JSON.stringify(events);
    expect(text).toMatch(/already in a UAT flow/);
    expect(text).not.toMatch(/"kind":"flow_start"/);
    expect(text).toContain(first);
    // Once that flow is cancelled, the story can start again.
    expect((await sourav.post(`/api/flows/${first}/status`, { status: 'cancelled' })).status).toBe(200);
    expect((await sourav.post('/api/flows', { kind: 'uat', stories: ['ABCD-1001'] })).status).toBe(201);
  });
});

describe('reviewing drafted cases in a flow', () => {
  it('asks what to change when sending cases back, shows it in the flow, and waits on the owner to analyse again', async () => {
    const sourav = api.as('u-sourav', 'ABCD');
    const id = ((await (await sourav.post('/api/flows', { kind: 'uat', stories: ['ABCD-1001'] })).json()) as { flow: FlowView }).flow.id;
    const f = await until('u-sourav', id, (x) => step(x, 'review').state === 'waiting');
    const approvalId = f.items[0].review!.approvalId;
    const decide = (body: unknown) => sourav.post(`/api/approvals/${approvalId}/decision`, body);
    expect((await decide({ decision: 'declined' })).status).toBe(400);
    expect((await decide({ decision: 'declined', note: 'AC4 should also cover an expired card.' })).status).toBe(200);
    const after = await view('u-sourav', id);
    expect(step(after, 'review')).toMatchObject({ state: 'blocked', action: { kind: 'analyse', label: 'Analyse again' } });
    expect(step(after, 'review').detail).toBe('Sourav asked for changes: "AC4 should also cover an expired card." Analyse again to draft new cases.');
    expect(after.items[0].review).toMatchObject({ status: 'declined', note: 'AC4 should also cover an expired card.' });
    expect(after.events.map((e) => e.text).join('\n')).toMatch(/Asked for changes to the drafted cases for ABCD-1001: "AC4 should also cover an expired card\."/);
  });

  it('keeps the rating before approving for drafted cases of a story in no flow', async () => {
    const sourav = api.as('u-sourav', 'ABCD');
    const events = await sourav.run({ text: 'Is ABCD-1001 ready for UAT?', agent: 'auto', scope: {}, testType: 'uat', testTypeSource: 'user', tickets: ['ABCD-1001'], components: [], history: [], chatId: 'plain', messageId: 'pm1', answerId: 'pa1' });
    const approvalId = (events.find((e) => e.type === 'saved') as { approvals: { id: string }[] }).approvals[0].id;
    expect((await sourav.post(`/api/approvals/${approvalId}/decision`, { decision: 'approved' })).status).toBe(403);
  });
});

describe('approving several stories at once', () => {
  it('approves the drafted cases of every chosen story the person is asked to approve, and reports the rest', async () => {
    const sourav = api.as('u-sourav', 'ABCD');
    const id = ((await (await sourav.post('/api/flows', { kind: 'uat', stories: ['ABCD-1001', 'ABCD-1002'] })).json()) as { flow: FlowView }).flow.id;
    const f = await until('u-sourav', id, (x) => x.items.length === 2 && x.items.every((s) => s.steps.find((st) => st.key === 'review')?.state === 'waiting'));
    // The Analysis agent gets the story's saved analyses, so "what changed since it was last analysed" has an answer.
    const fact = hexaEvidence(db, 'ABCD', { components: [], tickets: ['ABCD-1001'], text: 'What changed since ABCD-1001 was last analysed?', known: [] }).find((x) => x.title === 'Hexa · ABCD-1001')!;
    expect(fact.text).toMatch(/Saved UAT analyses of ABCD-1001 \(newest first\):\n- \S+ by Sourav: AC1 \S+/);
    expect(fact.text).toMatch(/Since the newest analysis \(\S+\): no criterion changed status; the story was not edited in Jira since/);
    const mine = f.waiting.find((w) => w.you)!;
    expect(mine.action).toBe('Review cases');
    expect([...mine.stories].sort()).toEqual(['ABCD-1001', 'ABCD-1002']);
    // Ram is not an approver of either: nothing is decided, and he is told who approves.
    const ram = await api.as('u-ram', 'ABCD').post(`/api/flows/${id}/review`, { storyKeys: ['ABCD-1001', 'ABCD-1002'] });
    expect(ram.status).toBe(200);
    const rb = (await ram.json()) as { result: BulkReviewResult };
    expect(rb.result.approved).toEqual([]);
    expect(rb.result.skipped.map((s) => s.key)).toEqual(['ABCD-1001', 'ABCD-1002']);
    expect(rb.result.skipped[0].reason).toBe('Sourav approves these cases, not you');
    // Sourav approves both in one go; a story outside the flow is reported, not touched.
    const r = await sourav.post(`/api/flows/${id}/review`, { storyKeys: ['ABCD-1001', 'ABCD-1002', 'ABCD-1003'] });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { flow: FlowView; result: BulkReviewResult };
    expect(body.result).toEqual({ approved: ['ABCD-1001', 'ABCD-1002'], waiting: [], skipped: [{ key: 'ABCD-1003', reason: 'not in this flow' }] });
    expect(body.flow.items.map((s) => s.steps.find((st) => st.key === 'review')!.state)).toEqual(['done', 'done']);
    expect(body.flow.events.filter((e) => /^Approved the drafted cases for ABCD-100[12]: Added/.test(e.text))).toHaveLength(2);
    // Nothing is left to approve: a second go says so.
    const again = (await (await sourav.post(`/api/flows/${id}/review`, { storyKeys: ['ABCD-1001'] })).json()) as { result: BulkReviewResult };
    expect(again.result.skipped).toEqual([{ key: 'ABCD-1001', reason: 'no drafted cases are waiting for review' }]);
  });
});

describe('work done in chat moves the flow', () => {
  it('records an analysis and an approval made in chat in the timeline, and finds the flow by story', async () => {
    const brian = api.as('u-sourav', 'ABCD');
    const id = ((await (await brian.post('/api/flows', { kind: 'uat', stories: ['ABCD-1001'] })).json()) as { flow: FlowView }).flow.id;
    await until('u-sourav', id, (x) => step(x, 'analyse').state === 'done');
    const older = db.listPendingApprovals('ABCD').find((a) => a.storyKey === 'ABCD-1001')!;
    // Asked again in an ordinary chat, as Brijesh did.
    const events = await brian.run({ text: 'Is ABCD-1001 ready for UAT?', agent: 'auto', scope: {}, testType: 'uat', testTypeSource: 'user', tickets: ['ABCD-1001'], components: [], history: [], chatId: 'own', messageId: 'om1', answerId: 'oa1' });
    const approvalId = (events.find((e) => e.type === 'saved') as { approvals: { id: string }[] }).approvals[0].id;
    // The newer proposal is now the flow's review (no rating asked); the older one was superseded by it.
    expect(db.getApproval(older.id)?.status).toBe('expired');
    expect((await brian.post(`/api/approvals/${older.id}/decision`, { decision: 'approved' })).status).toBe(409);
    expect((await brian.post(`/api/approvals/${approvalId}/decision`, { decision: 'approved' })).status).toBe(200);
    const f = await view('u-sourav', id);
    const texts = f.events.map((e) => e.text).join('\n');
    expect(texts).toMatch(/Sourav analysed ABCD-1001 in chat: 2 of 4 criteria covered, 1 case drafted for review\./);
    expect(texts).toMatch(/Approved the drafted cases for ABCD-1001: Added 1 manual test/);
    expect(step(f, 'review').state).toBe('done');
    // The chat's bar finds the flow by its story; a story in no flow finds none.
    const by = (k: string) => brian.get(`/api/flows?stories=${k}`).then((r) => r.json() as Promise<{ flows: { id: string }[] }>);
    expect((await by('ABCD-1001')).flows.map((x) => x.id)).toEqual([id]);
    expect((await by('ABCD-1002')).flows).toEqual([]);
  });
});

describe('a regression flow', () => {
  it('asks for automation where a criterion has none, then waits for CI', async () => {
    const id = ((await (await api.as('u-sourav', 'ABCD').post('/api/flows', { kind: 'regression', stories: ['ABCD-1002'] })).json()) as { flow: FlowView }).flow.id;
    const f = await until('u-sourav', id, (x) => step(x, 'analyse').state === 'done');
    expect(f.steps.map((s) => s.label)).toEqual(['Analyse', 'Review cases', 'Automate', 'Verify in CI']);
    // The application-wide coverage that a regression starts from.
    const cov = (await (await api.as('u-sourav', 'ABCD').get('/api/flows/coverage')).json()) as { criteria: number; covered: number; gaps: { key: string }[] };
    expect(cov.covered).toBe(2);
    expect(cov.gaps.map((g) => g.key)).toEqual(expect.arrayContaining(['ABCD-1001', 'ABCD-1002']));
  });
});
