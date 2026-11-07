import { describe, expect, it } from 'vitest';

import { comment, createItem, decide, findOpenItem, getItem, listItems, markNeedsInput, raiseFeedbackPattern, vote } from './huddle';
import { fixtureDb } from './fixture';

const raise = (db: ReturnType<typeof fixtureDb>, by: { type: 'user' | 'agent'; ref: string } = { type: 'user', ref: 'u-sourav' }) =>
  createItem(db, db.getApp('ABCD')!, by, {
    kind: 'mapping',
    title: 'Which component owns refunds?',
    summary: 'The story names checkoutservice; the tests live in paymentservice.',
    scope: "Ram's Portfolio · payments",
    aiSummary: 'Two owners are plausible [1].',
    citations: [{ n: 1, title: 'ABCD-1001', detail: 'Jira', href: '/tickets/ABCD-1001' }],
    options: [
      { title: 'checkoutservice', detail: 'As the story says.' },
      { title: 'paymentservice', detail: 'Where the tests are.' },
    ],
    affects: [{ label: 'ABCD-1001', href: '/tickets/ABCD-1001' }],
  });

describe('Huddle items', () => {
  it('are raised with ordered options and links, listed per application, and need two options', () => {
    const db = fixtureDb();
    const item = raise(db);
    expect(item).toMatchObject({ kind: 'mapping', raisedBy: 'Sourav', raisedByType: 'user', people: ['SV'], openLabel: 'Needs a decision', needsInput: false, myVote: null });
    expect(item.options.map((o) => o.title)).toEqual(['checkoutservice', 'paymentservice']);
    expect(item.affects).toEqual([{ label: 'ABCD-1001', href: '/tickets/ABCD-1001' }]);
    expect(listItems(db, 'ABCD').map((i) => i.id)).toEqual([item.id]);
    expect(listItems(db, 'IBGM')).toEqual([]);
    expect(getItem(db, 'IBGM', item.id)).toBeNull();
    expect(() => createItem(db, db.getApp('ABCD')!, { type: 'user', ref: 'u-ram' }, { kind: 'risk', title: 'x', summary: '', scope: '', aiSummary: '', citations: [], options: [{ title: 'only one', detail: '' }], affects: [] })).toThrow(/two options/);
  });

  it('one vote per person that can move, comments with authors, and needs-input', () => {
    const db = fixtureDb();
    const item = raise(db);
    const [a, b] = item.options.map((o) => o.id);
    expect(vote(db, 'ABCD', item.id, 'u-ram', a).options.map((o) => o.votes)).toEqual([['RK'], []]);
    expect(vote(db, 'ABCD', item.id, 'u-ram', b).options.map((o) => o.votes)).toEqual([[], ['RK']]);
    expect(vote(db, 'ABCD', item.id, 'u-devi', b).options[1].votes).toEqual(['RK', 'DV']);
    expect(() => vote(db, 'ABCD', item.id, 'u-ram', 'nope')).toThrow(/does not belong/);
    const c = comment(db, 'ABCD', item.id, 'u-devi', 'The page objects are in paymentservice too.');
    expect(c.comments[0]).toMatchObject({ who: { name: 'Devi', initials: 'DV' }, text: 'The page objects are in paymentservice too.' });
    expect(c.people.sort()).toEqual(['DV', 'RK', 'SV']);
    expect(getItem(db, 'ABCD', item.id, 'u-devi')?.myVote).toBe(b);
    expect(markNeedsInput(db, 'ABCD', item.id, 'u-ram').needsInput).toBe(true);
  });

  it('a decision needs a reason, closes the item, and blocks further votes and decisions', () => {
    const db = fixtureDb();
    const item = raise(db);
    expect(() => decide(db, 'ABCD', item.id, 'u-ram', item.options[0].id, '  ')).toThrow(/reason is required/);
    const d = decide(db, 'ABCD', item.id, 'u-ram', item.options[1].id, 'The tests and the page objects are there; the story is wrong.');
    expect(d.item.decision).toMatchObject({ optionId: item.options[1].id, by: 'Ram Kumar' });
    expect(d.item.needsInput).toBe(false);
    expect(() => vote(db, 'ABCD', item.id, 'u-devi', item.options[0].id)).toThrow(/already decided/);
    expect(() => decide(db, 'ABCD', item.id, 'u-ram', item.options[0].id, 'again')).toThrow(/already decided/);
    expect((db.raw.prepare("SELECT action FROM audit_log WHERE action LIKE 'huddle.%' ORDER BY id").all() as { action: string }[]).map((a) => a.action)).toEqual(['huddle.raise', 'huddle.decide']);
  });

  it('the feedback-pattern rule raises one item per open pattern, by Catalyzt, linking the rated chats', () => {
    const db = fixtureDb();
    db.upsertChat({ id: 'c1', title: 'Coverage of refunds', agent: 'auto', workspace: 'payments', userId: 'u-ram' }, 'ABCD');
    db.addUserMessage({ id: 'm1', chatId: 'c1', text: 'coverage?', testType: null, testTypeSource: null, userId: 'u-ram', items: [] });
    const saved = db.saveAnswer({ app: 'ABCD', chatId: 'c1', answerId: 'a1', userMessageId: 'm1', workflowRunId: null, userId: 'u-ram', status: 'done', intent: { capability: 'analysis', testType: null, action: 'x', tickets: [], components: [], confidence: 1, question: null, options: [], source: 'rules' }, blocks: [], citations: [], artifact: null });
    for (const u of ['u-ram', 'u-sourav', 'u-devi']) db.rateAnswer({ revisionId: saved.revisionId, userId: u, stars: 2, reasons: ['Wrong coverage'], comment: 'Expected the linked tests to be named.' });
    const patterns = db.lowRatingPatterns('ABCD');
    expect(patterns).toEqual([{ capability: 'analysis', reason: 'Wrong coverage', count: 3 }]);
    const item = raiseFeedbackPattern(db, db.getApp('ABCD')!, patterns[0])!;
    expect(item).toMatchObject({ kind: 'feedback', raisedBy: 'Catalyzt', raisedByType: 'agent', openLabel: 'Pattern to review', title: 'Test analysis answers rated low for "Wrong coverage"' });
    expect(item.affects).toEqual([{ label: 'Coverage of refunds', href: '/chat/c1' }]);
    expect(raiseFeedbackPattern(db, db.getApp('ABCD')!, patterns[0])).toBeNull();
    expect(findOpenItem(db, 'ABCD', 'feedback_pattern', 'analysis|Wrong coverage')?.id).toBe(item.id);
    expect(listItems(db, 'ABCD')).toHaveLength(1);
    // Once decided, a continuing pattern can be raised again.
    decide(db, 'ABCD', item.id, 'u-ram', item.options[1].id, 'Watching for now.');
    expect(raiseFeedbackPattern(db, db.getApp('ABCD')!, patterns[0])).not.toBeNull();
  });
});
