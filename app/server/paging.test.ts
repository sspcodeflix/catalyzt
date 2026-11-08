/**
 * Stable cursor pages for growing lists (hardening: conversation and Huddle growth): recent chats,
 * a chat's messages (latest first, older on demand) and Huddle summaries. Pages never repeat or skip
 * an item while new ones arrive, and revision and approval identities are the same on every page.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Block } from '../src/lib/types';
import type { WorkflowEvent } from '../src/lib/workflow';
import { startApi, type TestApi } from './api-harness';
import { seedContext } from './context';
import type { HorizonDb } from './db';
import { FIXTURE, fixtureDb, seedRefundTests } from './fixture';
import { createItem, getItem, listPage, similarTitles, vote, comment } from './huddle';

type Saved = Extract<WorkflowEvent, { type: 'saved' }>;
interface PagedChat {
  messages: { id: string; role: string; revisionId?: string; blocks?: Block[] }[];
  olderCursor: number | null;
}

let db: HorizonDb;
let api: TestApi;
beforeEach(async () => {
  db = fixtureDb();
  seedRefundTests(db);
  seedContext(db, FIXTURE);
  api = await startApi(db);
});
afterEach(() => api.close());

const uat = (chatId: string, n: number) => ({
  text: 'Is ABCD-1001 ready for UAT?',
  agent: 'auto',
  scope: {},
  testType: 'uat',
  testTypeSource: 'user',
  tickets: ['ABCD-1001'],
  components: [],
  history: [],
  chatTitle: 'UAT · ABCD-1001',
  chatId,
  messageId: `${chatId}-m${n}`,
  answerId: `${chatId}-a${n}`,
});

describe('recent chats', () => {
  it('page by cursor with no duplicates or gaps while new chats start, and the first page is the default', async () => {
    for (let i = 0; i < 23; i++) db.upsertChat({ id: `chat-${String(i).padStart(2, '0')}`, title: `Chat ${i}`, agent: 'auto', workspace: 'payments', userId: 'u-sourav' }, 'ABCD');
    const sourav = api.as('u-sourav', 'ABCD');
    const first = (await (await sourav.get('/api/chats')).json()) as { chats: { id: string }[]; nextCursor: string | null };
    expect(first.chats).toHaveLength(12);
    expect(first.nextCursor).toBeTruthy();

    const seen: string[] = [];
    let cursor: string | null = null;
    let n = 0;
    do {
      const page = (await (await sourav.get(`/api/chats?limit=5${cursor ? `&cursor=${cursor}` : ''}`)).json()) as { chats: { id: string }[]; nextCursor: string | null };
      seen.push(...page.chats.map((c) => c.id));
      cursor = page.nextCursor;
      // New chats arrive between pages; they belong above the cursor.
      db.upsertChat({ id: `new-${n++}`, title: 'New', agent: 'auto', workspace: 'payments', userId: 'u-sourav' }, 'ABCD');
    } while (cursor);
    const originals = seen.filter((id) => id.startsWith('chat-'));
    expect(new Set(seen).size).toBe(seen.length);
    expect(originals.sort()).toEqual(Array.from({ length: 23 }, (_, i) => `chat-${String(i).padStart(2, '0')}`));
    // A bad cursor reads the first page instead of failing; a teammate sees only their own.
    expect(((await (await sourav.get('/api/chats?cursor=garbage&limit=3')).json()) as { chats: unknown[] }).chats).toHaveLength(3);
    expect(((await (await api.as('u-ram', 'ABCD').get('/api/chats')).json()) as { chats: unknown[] }).chats).toHaveLength(0);
  });
});

describe('chat messages', () => {
  it('load the latest page first and older pages on demand, with the same revision and approval ids', async () => {
    const sourav = api.as('u-sourav', 'ABCD');
    const savedIds: string[] = [];
    for (let i = 1; i <= 7; i++) {
      const events = await sourav.run(uat('c1', i));
      savedIds.push(events.find((e): e is Saved => e.type === 'saved')!.revisionId);
    }
    const all = ((await (await sourav.get('/api/chats/c1?limit=200')).json()) as { chat: PagedChat }).chat;
    expect(all.messages).toHaveLength(14);
    expect(all.olderCursor).toBeNull();
    const approvals = (m: PagedChat['messages'][number]) => (m.blocks ?? []).flatMap((b) => (b.kind === 'approval' ? [b.approval.id] : []));
    const identity = (ms: PagedChat['messages']) => ms.map((m) => `${m.id}|${m.revisionId ?? ''}|${approvals(m).join(',')}`);

    // Default: the latest 40, so this short chat comes whole.
    expect(((await (await sourav.get('/api/chats/c1')).json()) as { chat: PagedChat }).chat.messages).toHaveLength(14);

    const pages: PagedChat['messages'][] = [];
    let before: number | null = null;
    let first = true;
    do {
      const page: PagedChat = ((await (await sourav.get(`/api/chats/c1?limit=4${before != null ? `&before=${before}` : ''}`)).json()) as { chat: PagedChat }).chat;
      // A page never starts with an answer whose question is on the older page.
      expect(page.messages[0].role).toBe('user');
      pages.unshift(page.messages);
      before = page.olderCursor;
      if (first) {
        // A new turn while older pages are read does not shift them.
        await sourav.run(uat('c1', 8));
        first = false;
      }
    } while (before != null);
    const stitched = pages.flat();
    expect(new Set(stitched.map((m) => m.id)).size).toBe(stitched.length);
    expect(identity(stitched)).toEqual(identity(all.messages));
    expect(stitched.filter((m) => m.role === 'assistant').map((m) => m.revisionId)).toEqual(savedIds);
    expect(stitched.some((m) => approvals(m).length > 0)).toBe(true);
  });
});

describe('Huddle pages', () => {
  const app = () => db.getApp('ABCD')!;
  const raise = (title: string, kind: 'mapping' | 'risk' = 'mapping', at?: string) =>
    createItem(db, app(), { type: 'user', ref: 'u-sourav' }, { kind, title, summary: `About ${title}`, scope: 'ABCD', aiSummary: 'cited [1]', citations: [{ n: 1, title: 'x', detail: 'y' }], options: [{ title: 'A', detail: '' }, { title: 'B', detail: '' }], affects: [{ label: 'ABCD-1001', href: '/tickets/ABCD-1001' }] }, at);

  it('page summaries by cursor with no duplicates or gaps under inserts, with whole-application counts', async () => {
    // Several items share a timestamp, so the id breaks ties.
    for (let i = 0; i < 25; i++) raise(`Decision number ${i}`, 'mapping', `2026-11-0${1 + (i % 5)}T10:00:00.000Z`);
    const ram = api.as('u-ram', 'ABCD');
    const seen: string[] = [];
    let cursor: string | null = null;
    let n = 0;
    do {
      const page = (await (await ram.get(`/api/huddle?limit=6${cursor ? `&cursor=${cursor}` : ''}`)).json()) as { items: { id: string; detail: boolean; comments?: unknown }[]; nextCursor: string | null; counts: { open: number } };
      expect(page.items.every((i) => i.detail === false && i.comments === undefined)).toBe(true);
      seen.push(...page.items.map((i) => i.id));
      cursor = page.nextCursor;
      raise(`Raised while paging ${n++}`);
    } while (cursor);
    const originals = seen.filter((id) => db.raw.prepare("SELECT 1 FROM huddle_items WHERE id = ? AND title LIKE 'Decision number%'").get(id));
    expect(new Set(seen).size).toBe(seen.length);
    expect(originals).toHaveLength(25);
    const body = (await (await ram.get('/api/huddle')).json()) as { items: unknown[]; counts: { open: number; decided: number } };
    expect(body.counts.open).toBe(25 + n);
    expect(body.items.length).toBeLessThanOrEqual(50);
  });

  it('a summary agrees with the full item, and filters run on the server', () => {
    const a = raise('Who owns refunds?');
    raise('Accept the risk of missing negative tests?', 'risk');
    vote(db, 'ABCD', a.id, 'u-devi', a.options[1].id);
    comment(db, 'ABCD', a.id, 'u-devi', 'The tests live in paymentservice.');
    const page = listPage(db, 'ABCD', 'u-devi', {});
    const summary = page.items.find((i) => i.id === a.id)!;
    const full = getItem(db, 'ABCD', a.id, 'u-devi')!;
    expect(summary).toMatchObject({ title: full.title, people: full.people, myVote: full.myVote, options: full.options, affects: full.affects, commentCount: 1 });
    expect(page.counts).toEqual({ open: 2, decided: 0, mine: 1 });
    expect(listPage(db, 'ABCD', 'u-devi', { mine: true }).items.map((i) => i.id)).toEqual([a.id]);
    expect(listPage(db, 'ABCD', 'u-devi', { q: 'negative' }).items).toHaveLength(1);
    expect(listPage(db, 'ABCD', 'u-devi', { status: 'decided' }).items).toHaveLength(0);
  });
});

describe('R17: likely duplicates', () => {
  it('open items of the same kind with near-identical titles are flagged as similar, never merged', () => {
    const app = db.getApp('ABCD')!;
    const risk = (title: string) => createItem(db, app, { type: 'user', ref: 'u-ram' }, { kind: 'risk', title, summary: '', scope: 'ABCD', aiSummary: '', citations: [], options: [{ title: 'Accept', detail: '' }, { title: 'Block', detail: '' }], affects: [] });
    const first = risk('Accept the missing negative tests for account-service this release? (run-1)');
    const second = risk('Accept the missing negative tests for account-service this release? (run-2)');
    const other = risk('Accept a slower checkout during the migration?');
    const mapping = createItem(db, app, { type: 'user', ref: 'u-ram' }, { kind: 'mapping', title: 'Accept the missing negative tests for account-service this release?', summary: '', scope: 'ABCD', aiSummary: '', citations: [], options: [{ title: 'A', detail: '' }, { title: 'B', detail: '' }], affects: [] });
    const items = new Map(listPage(db, 'ABCD', 'u-ram').items.map((i) => [i.id, i]));
    expect(items.get(second.id)!.similar).toEqual([{ id: first.id, title: first.title }]);
    expect(items.get(first.id)!.similar).toEqual([{ id: second.id, title: second.title }]);
    expect(items.get(other.id)!.similar).toEqual([]);
    // Another kind is not a duplicate.
    expect(items.get(mapping.id)!.similar).toEqual([]);
    expect(getItem(db, 'ABCD', second.id)!.similar.map((s) => s.id)).toEqual([first.id]);
    expect(items.size).toBe(4);
    expect(similarTitles('Who owns refunds?', 'Who owns payouts?')).toBe(false);
  });
});
