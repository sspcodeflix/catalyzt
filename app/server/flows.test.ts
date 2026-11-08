/**
 * Test flows (docs/FLOWS.md): a UAT flow over a story moves through Analyse → Review cases → Run tests
 * → Sign off, with every step derived from the records, and the same view for everyone on the team.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { startApi, type TestApi } from './api-harness';
import type { HorizonDb } from './db';
import { fixtureDb, seedRefundTests } from './fixture';
import type { FlowView } from './flows';

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

    // Sourav approves in the chat the flow created (rating first, as everywhere).
    const chatId = f.items[0].chatId!;
    const approvals = db.listPendingApprovals('ABCD').filter((a) => a.chatId === chatId);
    expect(approvals).toHaveLength(1);
    const rev = db.raw.prepare('SELECT revision_id FROM approvals WHERE id = ?').get(approvals[0].id) as { revision_id: string };
    expect((await sourav.post(`/api/answers/${rev.revision_id}/rating`, { stars: 5 })).status).toBe(200);
    expect((await sourav.post(`/api/approvals/${approvals[0].id}/decision`, { decision: 'approved' })).status).toBe(200);

    // Now the testers: AC4's manual case needs a result; AC3's automated test has none either.
    f = await view('u-sourav', id);
    expect(step(f, 'review').state).toBe('done');
    expect(step(f, 'run')).toMatchObject({ state: 'waiting', action: { kind: 'execute' } });
    const ac4 = f.items[0].manual.find((m) => m.criterion === 'AC4')!;
    // A plain member cannot record a result; a failure needs a reason.
    expect((await api.as('u-devi', 'ABCD').post(`/api/hexa/tests/${ac4.id}/executions`, { status: 'passed' })).status).toBe(403);
    expect((await sourav.post(`/api/hexa/tests/${ac4.id}/executions`, { status: 'failed' })).status).toBe(400);
    expect((await sourav.post(`/api/hexa/tests/${ac4.id}/executions`, { status: 'passed', note: 'checked in staging' })).status).toBe(201);
    f = await view('u-sourav', id);
    expect(f.items[0].criteria.find((c) => c.id === 'AC4')!.verified).toBe(true);
    // AC3 still has only an automated test with no result: the run step is not done, so no sign-off.
    expect(step(f, 'run').state).not.toBe('done');
    expect((await api.as('u-ram', 'ABCD').post(`/api/flows/${id}/signoff`, { storyKey: 'ABCD-1001', decision: 'signed_off' })).status).toBe(409);

    // AC3's test passes in CI: everything is verified and the app owner signs off; the flow is done.
    const ac3 = db.coverageFor('ABCD-1001')[2].tests[0].id;
    db.ingestRun({ app: 'ABCD', source: 'webhook', repo: 'acme/shop', workflow: 'CI', externalRunId: 'r2', attempt: 1, runUrl: null, event: 'push', branch: 'main', sha: 'seed124', prNumber: 42, isMerge: true, startedAt: new Date().toISOString() },
      db.coverageFor('ABCD-1001').flatMap((c) => c.tests.filter((t) => t.kind === 'automated')).map((t) => ({ testCaseId: t.id, status: 'passed' as const, durationMs: 1, message: null })), 'u-sourav');
    expect(ac3).toBeTruthy();
    f = await view('u-ram', id);
    expect(step(f, 'run').state).toBe('done');
    expect(step(f, 'signoff')).toMatchObject({ state: 'waiting', waitingOn: [{ id: 'u-ram' }] });
    expect((await sourav.post(`/api/flows/${id}/signoff`, { storyKey: 'ABCD-1001', decision: 'signed_off' })).status).toBe(403);
    expect((await api.as('u-ram', 'ABCD').post(`/api/flows/${id}/signoff`, { storyKey: 'ABCD-1001', decision: 'signed_off' })).status).toBe(200);
    f = await view('u-sourav', id);
    expect(f.status).toBe('done');
    expect(f.coverage.now).toBe(100);
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
  it('leaves cases for components of two managers to the app owner, who alone can approve them', async () => {
    // ABCD-1001 now spans checkoutservice (Sourav) and frontend (Devi as its manager, for this test).
    db.raw.prepare("UPDATE components SET manager_id = 'u-devi' WHERE application_id = 'ABCD' AND name = 'frontend'").run();
    db.raw.prepare("INSERT INTO story_components (story_key, component_id) SELECT 'ABCD-1001', id FROM components WHERE application_id = 'ABCD' AND name = 'frontend'").run();
    await api.close();
    api = await startApi(db);
    const id = ((await (await api.as('u-ram', 'ABCD').post('/api/flows', { kind: 'uat', stories: ['ABCD-1001'] })).json()) as { flow: FlowView }).flow.id;
    const f = await until('u-ram', id, (x) => step(x, 'analyse').state === 'done');
    expect(step(f, 'review')).toMatchObject({ state: 'waiting', waitingOn: [{ id: 'u-ram' }] });
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
