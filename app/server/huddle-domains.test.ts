/**
 * Huddle across testing, reliability and security (docs/HUDDLE.md): the version-22 migration keeps
 * every old item, deciders are enforced per domain, accepted risks reopen at expiry, actions close an
 * item, concerns are answered, "waiting on me", and "Raise with the team" from a chat answer.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { startApi, type TestApi } from './api-harness';
import { openDb, type HorizonDb } from './db';
import { addAction, answerConcern, canDecide, completeAction, createItem, decide, EXPIRY_DAYS, getItem, listPage, raiseFromChat, reopenExpired, type NewHuddleItem } from './huddle';
import { huddleFixtureDb, seedHuddleExamples } from './huddle-fixture';
import { MIGRATIONS } from './schema';

const base = { summary: '', scope: 'ABCD', aiSummary: '', citations: [], affects: [] };
const two = [
  { title: 'Option A', detail: '' },
  { title: 'Option B', detail: '' },
];
const raise = (db: HorizonDb, input: Partial<NewHuddleItem> & Pick<NewHuddleItem, 'kind' | 'title'>, by = 'u-devi') => createItem(db, db.getApp('ABCD')!, { type: 'user', ref: by }, { ...base, options: two, ...input });

describe('migration 22', () => {
  it('rebuilds huddle_items keeping every row, its options, votes, comments, decision and links, with a domain from its kind', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'hz-')), 'v21.db');
    const raw = new Database(path);
    for (const m of MIGRATIONS.slice(0, 21)) raw.exec(m);
    raw.pragma('user_version = 21');
    raw.exec(`INSERT INTO applications (id, name, jira_project) VALUES ('OLD', 'Old app', 'OLD');
      INSERT INTO users VALUES ('u-o', 'Owner', 'OW', 'o@example.com', '2026-01-01');
      INSERT INTO users VALUES ('u-m', 'Member', 'ME', 'm@example.com', '2026-01-01');
      INSERT INTO memberships VALUES ('u-o', 'OLD', 'app_owner'), ('u-m', 'OLD', 'member'), ('u-m', 'OLD', 'component_manager');
      INSERT INTO huddle_items (id, application_id, kind, title, summary, status, needs_input, raised_by_type, raised_by, created_at, scope, ai_summary, citations)
        VALUES ('h1', 'OLD', 'conflict', 'Conflict', 's', 'open', 1, 'user', 'u-m', '2026-10-01T00:00:00.000Z', 'OLD', 'cited [1]', '[{"n":1,"title":"x","detail":"y"}]'),
               ('h2', 'OLD', 'mapping', 'Mapping', '', 'decided', 0, 'user', 'u-m', '2026-10-02T00:00:00.000Z', '', '', '[]'),
               ('h3', 'OLD', 'risk', 'Risk', '', 'open', 0, 'agent', 'Catalyzt', '2026-10-03T00:00:00.000Z', '', '', '[]'),
               ('h4', 'OLD', 'feedback', 'Feedback', '', 'open', 0, 'agent', 'Catalyzt', '2026-10-04T00:00:00.000Z', '', '', '[]');
      INSERT INTO huddle_options (id, item_id, label, detail, seq) VALUES ('h1-o1', 'h1', 'Keep upload', '', 1), ('h1-o2', 'h1', 'Keep repo', '', 2),
        ('h2-o1', 'h2', 'A', '', 1), ('h2-o2', 'h2', 'B', '', 2), ('h3-o1', 'h3', 'Accept for this release', '', 1), ('h3-o2', 'h3', 'Block', '', 2);
      INSERT INTO huddle_votes (item_id, user_id, option_id, created_at) VALUES ('h1', 'u-m', 'h1-o2', 'x');
      INSERT INTO huddle_comments VALUES ('c1', 'h1', 'u-m', 'Repo is right.', '2026-10-01T01:00:00.000Z');
      INSERT INTO huddle_decisions VALUES ('h2', 'h2-o2', 'Because.', 'u-o', '2026-10-02T01:00:00.000Z');
      INSERT INTO huddle_links (item_id, entity_type, entity_ref, label, href) VALUES ('h1', 'affects', '/tickets/OLD-1', 'OLD-1', '/tickets/OLD-1');`);
    raw.close();
    const db = openDb(path);
    expect(db.raw.pragma('user_version', { simple: true })).toBe(MIGRATIONS.length);
    const h1 = getItem(db, 'OLD', 'h1', 'u-m')!;
    expect(h1).toMatchObject({ kind: 'conflict', domain: 'knowledge', stage: 'needs_input', needsInput: true, myVote: 'h1-o2', citations: [{ n: 1 }], affects: [{ label: 'OLD-1', href: '/tickets/OLD-1' }] });
    expect(h1.comments.map((c) => c.text)).toEqual(['Repo is right.']);
    expect(getItem(db, 'OLD', 'h2')).toMatchObject({ domain: 'testing', stage: 'decided', decision: { optionId: 'h2-o2', reason: 'Because.', by: 'Owner' } });
    expect(getItem(db, 'OLD', 'h3')).toMatchObject({ domain: 'testing', options: [{ accepts: true }, { accepts: false }] });
    expect(getItem(db, 'OLD', 'h4')).toMatchObject({ domain: 'process' });
    expect(db.rolesFor('u-m', 'OLD').sort()).toEqual(['component_manager', 'member']);
    // The new roles are accepted after the rebuild.
    for (const r of ['sre_lead', 'product_owner', 'uat_tester', 'automation_engineer']) db.raw.prepare('INSERT INTO memberships VALUES (?, ?, ?)').run('u-m', 'OLD', r);
    expect(() => db.raw.prepare('INSERT INTO memberships VALUES (?, ?, ?)').run('u-m', 'OLD', 'wizard')).toThrow(/CHECK/);
    expect(db.raw.pragma('foreign_key_check')).toEqual([]);
  });
});

describe('deciders by domain', () => {
  let db: HorizonDb;
  beforeEach(() => {
    db = huddleFixtureDb();
  });

  it('roles from personas "roles" and team.json "roles" are seeded', () => {
    expect(db.rolesFor('u-omar', 'ABCD')).toContain('sre_lead');
    expect(db.rolesFor('u-lena', 'ABCD')).toContain('security_champion');
  });

  it('testing: the manager of a linked component (directly or through a story) or the app owner', () => {
    const viaStory = raise(db, { kind: 'decision', title: 'Which refund rule stands?', links: [{ type: 'story', ref: 'ABCD-1001' }] });
    const viaComp = raise(db, { kind: 'decision', title: 'Frontend currency rounding', links: [{ type: 'component', ref: 'frontend' }] });
    const unlinked = raise(db, { kind: 'decision', title: 'Nothing linked' });
    expect(canDecide(db, 'ABCD', viaStory.id, 'u-sourav')).toBe(true);
    expect(canDecide(db, 'ABCD', viaComp.id, 'u-sourav')).toBe(true);
    expect(canDecide(db, 'ABCD', unlinked.id, 'u-sourav')).toBe(false);
    expect(canDecide(db, 'ABCD', viaStory.id, 'u-devi')).toBe(false);
    expect(canDecide(db, 'ABCD', viaStory.id, 'u-omar')).toBe(false);
    for (const i of [viaStory, viaComp, unlinked]) expect(canDecide(db, 'ABCD', i.id, 'u-ram')).toBe(true);
  });

  it('reliability: an sre_lead or the app owner; security: a security champion or the app owner; knowledge and process: the app owner', () => {
    const rel = raise(db, { kind: 'capacity_warning', title: 'Memory at the limit in 3 h' });
    const sec = raise(db, { kind: 'vulnerability', severity: 'critical', title: 'CVE in x/net' });
    const proc = raise(db, { kind: 'decision', domain: 'process', title: 'Who reviews flaky tests?' });
    expect(rel.domain).toBe('reliability');
    expect(sec.domain).toBe('security');
    expect([canDecide(db, 'ABCD', rel.id, 'u-omar'), canDecide(db, 'ABCD', rel.id, 'u-lena'), canDecide(db, 'ABCD', rel.id, 'u-devi'), canDecide(db, 'ABCD', rel.id, 'u-ram')]).toEqual([true, false, false, true]);
    expect([canDecide(db, 'ABCD', sec.id, 'u-lena'), canDecide(db, 'ABCD', sec.id, 'u-omar'), canDecide(db, 'ABCD', sec.id, 'u-sourav'), canDecide(db, 'ABCD', sec.id, 'u-ram')]).toEqual([true, false, false, true]);
    expect([canDecide(db, 'ABCD', proc.id, 'u-omar'), canDecide(db, 'ABCD', proc.id, 'u-lena'), canDecide(db, 'ABCD', proc.id, 'u-sourav'), canDecide(db, 'ABCD', proc.id, 'u-ram')]).toEqual([false, false, false, true]);
  });

  describe('through the API', () => {
    let api: TestApi;
    beforeEach(async () => {
      api = await startApi(db);
    });
    afterEach(() => api.close());

    it('an sre_lead decides a reliability item; a member and a component manager are refused; votes stay advisory', async () => {
      const r = await api.as('u-devi', 'ABCD').post('/api/huddle', { kind: 'capacity_warning', title: 'cartservice memory at the limit in 3 h', summary: '40 MB an hour', options: ['Scale to 3 replicas', 'Restart in the quiet hour'], links: [{ type: 'deployment', ref: 'cart@0900' }] });
      expect(r.status).toBe(201);
      const { item } = (await r.json()) as { item: { id: string; domain: string; canDecide: boolean; options: { id: string }[]; links: { type: string }[] } };
      expect(item).toMatchObject({ domain: 'reliability', canDecide: false, links: [{ type: 'deployment' }] });
      expect((await api.as('u-devi', 'ABCD').post(`/api/huddle/${item.id}/vote`, { optionId: item.options[0].id })).status).toBe(200);
      const refused = await api.as('u-devi', 'ABCD').post(`/api/huddle/${item.id}/decide`, { optionId: item.options[0].id, reason: 'Scale' });
      expect(refused.status).toBe(403);
      expect(((await refused.json()) as { error: string }).error).toMatch(/SRE lead or an app owner/);
      expect((await api.as('u-sourav', 'ABCD').post(`/api/huddle/${item.id}/decide`, { optionId: item.options[0].id, reason: 'Scale' })).status).toBe(403);
      const seen = (await (await api.as('u-omar', 'ABCD').get(`/api/huddle/${item.id}`)).json()) as { item: { canDecide: boolean; waitingOnMe: boolean } };
      expect(seen.item).toMatchObject({ canDecide: true, waitingOnMe: true });
      const ok = await api.as('u-omar', 'ABCD').post(`/api/huddle/${item.id}/decide`, { optionId: item.options[1].id, reason: 'Restart is safe at night; scaling waits for the profile.' });
      expect(ok.status).toBe(200);
      expect(((await ok.json()) as { item: { decision: { by: string; optionId: string } } }).item.decision).toMatchObject({ by: 'Omar', optionId: item.options[1].id });
    });

    it('validates kinds, domains, links and severities, and lists by domain and waiting=me', async () => {
      const devi = api.as('u-devi', 'ABCD');
      expect((await devi.post('/api/huddle', { kind: 'nonsense', title: 'x', options: ['a', 'b'] })).status).toBe(400);
      expect((await devi.post('/api/huddle', { kind: 'decision', domain: 'weather', title: 'x', options: ['a', 'b'] })).status).toBe(400);
      expect((await devi.post('/api/huddle', { kind: 'decision', title: 'x', options: ['a'] })).status).toBe(400);
      expect((await devi.post('/api/huddle', { kind: 'vulnerability', title: 'x', options: ['a', 'b'] })).status).toBe(400);
      expect((await devi.post('/api/huddle', { kind: 'vulnerability', severity: 'high', title: 'x', options: ['a', 'b'], links: [{ type: 'cve', ref: 'not-a-cve' }] })).status).toBe(400);
      const concern = await devi.post('/api/huddle', { kind: 'concern', title: 'Is this flaky test hiding a bug?', summary: 'Twice this week.', links: [{ type: 'story', ref: 'ABCD-1001' }, { type: 'test', ref: 'T-1' }] });
      expect(concern.status).toBe(201);
      expect(((await concern.json()) as { item: { links: { href?: string }[] } }).item.links.map((l) => l.href)).toEqual(['/tickets/ABCD-1001', '/hexa/test/T-1']);
      expect((await devi.post('/api/huddle', { kind: 'vulnerability', severity: 'medium', title: 'CVE-2026-1 in lib', options: ['Upgrade', 'Accept until a date'], links: [{ type: 'cve', ref: 'cve-2026-12345' }] })).status).toBe(201);
      const sec = (await (await devi.get('/api/huddle?domain=security')).json()) as { items: { kind: string; links: { ref: string }[] }[]; domains: Record<string, number> };
      expect(sec.items.map((i) => i.kind)).toEqual(['vulnerability']);
      expect(sec.items[0].links[0].ref).toBe('CVE-2026-12345');
      expect(sec.domains).toMatchObject({ testing: 1, security: 1, reliability: 0 });
      expect((await devi.get('/api/huddle?domain=weather')).status).toBe(400);
      // Sourav manages checkoutservice, which ABCD-1001 touches: the concern waits on him, not on Lena.
      const souravWaiting = (await (await api.as('u-sourav', 'ABCD').get('/api/huddle?waiting=me')).json()) as { items: { title: string }[]; waiting: number };
      expect(souravWaiting.items.map((i) => i.title)).toEqual(['Is this flaky test hiding a bug?']);
      expect(souravWaiting.waiting).toBe(1);
      const lena = (await (await api.as('u-lena', 'ABCD').get('/api/huddle?waiting=me')).json()) as { items: { kind: string }[] };
      expect(lena.items.map((i) => i.kind)).toEqual(['vulnerability']);
      const people = (await (await devi.get('/api/huddle/people')).json()) as { people: { id: string; roles: string[] }[] };
      expect(people.people.find((p) => p.id === 'u-omar')?.roles).toContain('sre_lead');
    });

    it('answers a concern (raiser or decider), adds and completes actions, and refuses others', async () => {
      const devi = api.as('u-devi', 'ABCD');
      const { item } = (await (await devi.post('/api/huddle', { kind: 'concern', title: 'Safe to restart checkout during the sale?', domain: 'reliability' })).json()) as { item: { id: string } };
      expect((await api.as('u-sourav', 'ABCD').post(`/api/huddle/${item.id}/answer`, { text: 'Yes' })).status).toBe(403);
      const add = await devi.post(`/api/huddle/${item.id}/actions`, { title: 'Check the sale traffic forecast', ownerId: 'u-omar', dueAt: '2026-11-20' });
      expect(add.status).toBe(201);
      const withAction = ((await add.json()) as { item: { actions: { id: string; owner: { name: string }; dueAt: string }[] } }).item;
      expect(withAction.actions[0]).toMatchObject({ owner: { name: 'Omar' }, dueAt: '2026-11-20T23:59:59.000Z' });
      expect((await devi.post(`/api/huddle/${item.id}/actions`, { title: 'x', ownerId: 'u-nabih' })).status).toBe(400);
      const answered = (await (await api.as('u-omar', 'ABCD').post(`/api/huddle/${item.id}/answer`, { text: 'Only between 02:00 and 04:00, with one replica at a time.' })).json()) as { item: { stage: string; answer: { by: string } } };
      expect(answered.item).toMatchObject({ stage: 'follow_up', answer: { by: 'Omar' } });
      expect((await api.as('u-sourav', 'ABCD').post(`/api/huddle/${item.id}/actions/${withAction.actions[0].id}/done`)).status).toBe(403);
      const done = (await (await api.as('u-omar', 'ABCD').post(`/api/huddle/${item.id}/actions/${withAction.actions[0].id}/done`)).json()) as { item: { stage: string; actions: { status: string; doneBy: string }[] } };
      expect(done.item).toMatchObject({ stage: 'closed', actions: [{ status: 'done', doneBy: 'Omar' }] });
    });

    it('raises a concern from a finished chat answer with the question, the opening and the citations', async () => {
      db.upsertChat({ id: 'c1', title: 'Coverage of refunds', agent: 'auto', workspace: 'payments', userId: 'u-devi' }, 'ABCD');
      db.addUserMessage({ id: 'm1', chatId: 'c1', text: 'Which tests cover partial refunds?', testType: null, testTypeSource: null, userId: 'u-devi', items: [{ type: 'story', ref: 'ABCD-1001' }] });
      db.saveAnswer({
        app: 'ABCD',
        chatId: 'c1',
        answerId: 'a1',
        userMessageId: 'm1',
        workflowRunId: null,
        userId: 'u-devi',
        status: 'done',
        intent: { capability: 'analysis', testType: null, action: 'x', tickets: [], components: [], confidence: 1, question: null, options: [], source: 'rules' },
        blocks: [{ kind: 'prose', text: 'Two tests cover AC1 [1]. Nothing covers AC4. The rest of this answer is long. '.repeat(20) }],
        citations: [{ n: 1, title: 'PartialRefundsTest', detail: 'JUnit · passed' }],
        artifact: null,
      });
      const r = await api.as('u-devi', 'ABCD').post('/api/huddle/from-chat', { chatId: 'c1', messageId: 'a1', title: 'Is AC4 really uncovered?', note: 'Product says the 45-day rule is tested manually.' });
      expect(r.status).toBe(201);
      const { item } = (await r.json()) as { item: { id: string; kind: string; domain: string; title: string; options: unknown[]; summary: string; links: { type: string; ref: string }[]; canDecide: boolean } };
      expect(item).toMatchObject({ kind: 'concern', domain: 'testing', title: 'Is AC4 really uncovered?', options: [], summary: 'Product says the 45-day rule is tested manually.' });
      expect(item.links.map((l) => `${l.type}:${l.ref}`)).toEqual(['chat:c1', 'story:ABCD-1001']);
      const full = (await (await api.as('u-sourav', 'ABCD').get(`/api/huddle/${item.id}`)).json()) as { item: { aiSummary: string; citations: { n: number; title: string }[]; canDecide: boolean } };
      expect(full.item.aiSummary).toMatch(/^Question: Which tests cover partial refunds\?/);
      expect(full.item.aiSummary).toMatch(/The answer began: Two tests cover AC1 \[1\]\./);
      expect(full.item.aiSummary.length).toBeLessThan(1400);
      expect(full.item.citations).toEqual([{ n: 1, title: 'PartialRefundsTest', detail: 'JUnit · passed' }]);
      // The story links checkoutservice, so its manager is the testing decider.
      expect(full.item.canDecide).toBe(true);
      // Raising the same answer again returns the open concern.
      const again = await api.as('u-devi', 'ABCD').post('/api/huddle/from-chat', { chatId: 'c1', messageId: 'a1' });
      expect(again.status).toBe(200);
      expect(((await again.json()) as { item: { id: string }; already: boolean })).toMatchObject({ item: { id: item.id }, already: true });
      expect((await api.as('u-nabih', 'IBGM').post('/api/huddle/from-chat', { chatId: 'c1', messageId: 'a1' })).status).toBe(404);
      expect((await api.as('u-devi', 'ABCD').post('/api/huddle/from-chat', { chatId: 'c1', messageId: 'm1' })).status).toBe(404);
    });
  });
});

describe('lifecycle', () => {
  let db: HorizonDb;
  beforeEach(() => {
    db = huddleFixtureDb();
  });

  it('vulnerability acceptances default their expiry by severity; risks to 30 days', () => {
    const at = '2026-11-01T00:00:00.000Z';
    const app = db.getApp('ABCD')!;
    for (const severity of ['critical', 'high', 'medium'] as const) {
      const v = createItem(db, app, { type: 'user', ref: 'u-lena' }, { ...base, kind: 'vulnerability', severity, title: `A ${severity} finding`, options: two }, at);
      expect((new Date(v.expiresAt!).getTime() - new Date(at).getTime()) / 86_400_000).toBe(EXPIRY_DAYS[severity]);
    }
    expect(EXPIRY_DAYS).toMatchObject({ critical: 7, high: 30, medium: 90 });
    const r = createItem(db, app, { type: 'user', ref: 'u-ram' }, { ...base, kind: 'risk', title: 'Ship without negative tests', options: two }, at);
    expect(r.expiresAt).toBe('2026-12-01T00:00:00.000Z');
    expect(raise(db, { kind: 'risk', title: 'Explicit', expiresAt: '2027-01-15' }).expiresAt).toBe('2027-01-15T23:59:59.000Z');
  });

  it('an accepted risk reopens at its expiry with a note; a refused one does not', () => {
    const accept = raise(db, { kind: 'risk', title: 'Ship without negative tests', options: [{ title: 'Accept until the next release', detail: '' }, { title: 'Do not accept', detail: '' }] }, 'u-ram');
    const refuse = raise(db, { kind: 'risk', title: 'Ship with a known crash', options: [{ title: 'Accept for a week', detail: '' }, { title: 'Do not accept', detail: '' }] }, 'u-ram');
    expect(accept.options.map((o) => o.accepts)).toEqual([true, false]);
    decide(db, 'ABCD', accept.id, 'u-ram', accept.options[0].id, 'Manual checks cover it.', { expiresAt: '2026-12-01' });
    decide(db, 'ABCD', refuse.id, 'u-ram', refuse.options[1].id, 'Too risky.');
    expect(getItem(db, 'ABCD', accept.id)).toMatchObject({ stage: 'decided', expiresAt: '2026-12-01T23:59:59.000Z' });
    expect(reopenExpired(db, 'ABCD', '2026-12-01T12:00:00.000Z')).toBe(0);
    expect(reopenExpired(db, 'ABCD', '2026-12-02T00:00:00.000Z')).toBe(1);
    const back = getItem(db, 'ABCD', accept.id, 'u-ram')!;
    expect(back).toMatchObject({ stage: 'open', decision: undefined, canDecide: true });
    expect(back.reopenNote).toMatch(/Accepted "Accept until the next release" by Ram Kumar .* until 2026-12-01 \(reason: Manual checks cover it\.\)\. The acceptance expired/);
    expect(getItem(db, 'ABCD', refuse.id)!.stage).toBe('decided');
    // It can be decided again.
    expect(decide(db, 'ABCD', accept.id, 'u-ram', accept.options[1].id, 'Tests exist now.').item.stage).toBe('decided');
    expect((db.raw.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'huddle.expired'").get() as { n: number }).n).toBe(1);
  });

  it('reopening happens on read: an acceptance whose date passed is open the next time it is listed', () => {
    const v = raise(db, { kind: 'vulnerability', severity: 'critical', title: 'CVE in x/net', options: [{ title: 'Accept until patched', detail: '' }, { title: 'Upgrade now', detail: '' }] }, 'u-lena');
    decide(db, 'ABCD', v.id, 'u-lena', v.options[0].id, 'Behind the LB.');
    db.raw.prepare('UPDATE huddle_items SET expires_at = ? WHERE id = ?').run('2020-01-01T00:00:00.000Z', v.id);
    expect(listPage(db, 'ABCD', 'u-lena', { status: 'open' }).items.map((i) => i.id)).toEqual([v.id]);
  });

  it('decided → follow-up while actions are open → closed when all are done; overdue is flagged', () => {
    const d = raise(db, { kind: 'incident_followup', title: 'Checkout errors after deploy', domain: 'reliability' }, 'u-omar');
    const a1 = addAction(db, 'ABCD', d.id, 'u-omar', { title: 'Add a canary', ownerId: 'u-sourav', dueAt: '2020-01-01' });
    expect(a1).toMatchObject({ stage: 'open', overdue: true });
    const a2 = addAction(db, 'ABCD', d.id, 'u-omar', { title: 'Write the review', ownerId: 'u-omar', link: '/tickets/ABCD-1003' });
    expect(() => addAction(db, 'ABCD', d.id, 'u-omar', { title: 'x', ownerId: 'u-omar', link: 'javascript:alert(1)' })).toThrow(/link/);
    expect(decide(db, 'ABCD', d.id, 'u-omar', d.options[0].id, 'Canary first.').item.stage).toBe('follow_up');
    const [x, y] = a2.actions;
    expect(completeAction(db, 'ABCD', d.id, x.id, 'u-sourav').stage).toBe('follow_up');
    expect(() => completeAction(db, 'ABCD', d.id, y.id, 'u-devi')).toThrow(/owner/);
    const closed = completeAction(db, 'ABCD', d.id, y.id, 'u-omar');
    expect(closed).toMatchObject({ stage: 'closed', overdue: false });
    expect(() => addAction(db, 'ABCD', d.id, 'u-omar', { title: 'More', ownerId: 'u-omar' })).toThrow(/closed/);
    expect(listPage(db, 'ABCD', 'u-omar', { status: 'decided' }).items.map((i) => i.id)).toEqual([d.id]);
    // Overdue items: open past their due date.
    expect(raise(db, { kind: 'decision', title: 'Late one', dueAt: '2020-01-01' }).overdue).toBe(true);
  });

  it('a concern may have no options and is answered; other kinds still need two options', () => {
    const c = raise(db, { kind: 'concern', title: 'Is this flaky test hiding a bug?', options: [] });
    expect(c).toMatchObject({ kind: 'concern', options: [], stage: 'open', openLabel: 'Question for the team' });
    expect(() => raise(db, { kind: 'concern', title: 'One option', options: [{ title: 'only', detail: '' }] })).toThrow(/concern/);
    expect(() => raise(db, { kind: 'decision', title: 'No options', options: [] })).toThrow(/two options/);
    const answered = answerConcern(db, 'ABCD', c.id, 'u-ram', 'It is a timing issue in the test; the code is fine.');
    expect(answered).toMatchObject({ stage: 'closed', answer: { text: 'It is a timing issue in the test; the code is fine.', by: 'Ram Kumar' } });
    expect(() => answerConcern(db, 'ABCD', c.id, 'u-ram', 'again')).toThrow(/closed/);
    const d = raise(db, { kind: 'decision', title: 'Not a concern' });
    expect(() => answerConcern(db, 'ABCD', d.id, 'u-ram', 'x')).toThrow(/Only a concern/);
  });

  it('waiting on me: items to decide and open actions I own', () => {
    const ex = seedHuddleExamples(db);
    const ids = (u: string) => listPage(db, 'ABCD', u, { waiting: true }).items.map((i) => i.id).sort();
    expect(ids('u-omar')).toEqual([ex.restart.id]);
    expect(ids('u-lena')).toEqual([ex.cve.id]);
    // Sourav manages the frontend the CVE touches, but security is the champion's to decide.
    expect(ids('u-sourav')).toEqual([ex.flaky.id]);
    expect(ids('u-devi')).toEqual([]);
    addAction(db, 'ABCD', ex.cve.id, 'u-lena', { title: 'Check the LB stream limit', ownerId: 'u-devi' });
    expect(ids('u-devi')).toEqual([ex.cve.id]);
    expect(ids('u-ram')).toHaveLength(3);
    expect(listPage(db, 'IBGM', 'u-nabih', { waiting: true }).items.map((i) => i.id)).toEqual([ex.followup.id]);
  });

  it('raiseFromChat refuses an unfinished answer', () => {
    db.upsertChat({ id: 'c2', title: 'Restart?', agent: 'auto', workspace: 'payments', userId: 'u-devi' }, 'ABCD');
    db.addUserMessage({ id: 'm2', chatId: 'c2', text: 'Can I restart cartservice?', testType: null, testTypeSource: null, userId: 'u-devi', items: [] });
    db.saveAnswer({ app: 'ABCD', chatId: 'c2', answerId: 'a2', userMessageId: 'm2', workflowRunId: null, userId: 'u-devi', status: 'error', intent: undefined, blocks: [], citations: [], artifact: null });
    expect(() => raiseFromChat(db, db.getApp('ABCD')!, 'u-devi', { chatId: 'c2', messageId: 'a2' })).toThrow(/finished answer/);
  });
});
