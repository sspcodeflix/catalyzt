import { describe, expect, it } from 'vitest';

import { fixtureDb } from './fixture';
import { parseStoryInput, refineByRules, refineStory, splitCriteria, StoryError } from './stories';

const COMPONENTS = ['checkoutservice', 'frontend'];

describe('splitCriteria', () => {
  it('takes criteria as written: one per line, bullets and numbers optional, no duplicates', () => {
    expect(splitCriteria('- merchant can refund\n2) cant refund more than paid\n\nAC3: needs a reason\n- merchant can refund')).toEqual([
      'merchant can refund',
      'cant refund more than paid',
      'needs a reason',
    ]);
  });
});

describe('refineByRules', () => {
  it('tidies, keeps meaning and asks about vague wording instead of guessing', () => {
    const r = refineByRules({ summary: 'refunds should be fast.', description: '', acceptanceCriteria: 'refund page loads fast\nrefund works properly' });
    expect(r.summary).toBe('Refunds should be fast');
    expect(r.acceptanceCriteria).toEqual(['Refund page loads fast', 'Refund works properly']);
    expect(r.questions).toEqual(['AC1 says "fast": how fast, measured how?', 'AC2 says "properly": what is the expected result?']);
  });
});

describe('refineStory', () => {
  it('falls back to rules without a model', async () => {
    const r = await refineStory({ summary: 'x', acceptanceCriteria: 'a' }, null);
    expect(r).toMatchObject({ source: 'rules', model: null });
  });
  it('rejects a secret before any model sees it', async () => {
    await expect(refineStory({ summary: 'login', acceptanceCriteria: 'use password=Hunter2Hunter2' }, null)).rejects.toBeInstanceOf(StoryError);
  });
  it('allows features that mention exporting or deleting data', async () => {
    await expect(refineStory({ summary: 'Admins export the list of users with their emails', acceptanceCriteria: 'Deleting a merchant removes their data' }, null)).resolves.toBeTruthy();
  });
});

describe('stories in the database', () => {
  it('creates stories with the next key, normalised criteria, known components only, and the original kept', () => {
    const db = fixtureDb();
    const refinementId = db.saveRefinement({ input: { summary: 'a' }, output: { summary: 'A', description: '', acceptanceCriteria: ['X'], questions: [] }, source: 'rules', model: null, agentRunId: null, createdBy: 'u-sourav' });
    const input = parseStoryInput({ summary: 'Refund codes', acceptanceCriteria: '- one\n- two', components: ['checkoutservice', 'nope'], status: 'To Do', purpose: 'regression' }, 'u-sourav', COMPONENTS);
    const s = db.createStory({ ...input, original: { summary: 'refund codes', description: '', acceptanceCriteria: '- one\n- two' }, refinementId }, 'ABCD');
    expect(s).toMatchObject({ key: 'ABCD-1004', applicationId: 'ABCD', acceptanceCriteria: ['one', 'two'], components: ['checkoutservice'], source: 'horizon', status: 'To Do', purpose: 'regression', refinementId, assignee: 'Sourav' });
    expect(db.getRefinement(refinementId)?.storyKey).toBe('ABCD-1004');
    expect(db.getStory('ABCD-1004')?.original?.summary).toBe('refund codes');
    // To Do is outside the default filter.
    expect(db.listStories('ABCD').some((x) => x.key === 'ABCD-1004')).toBe(false);
    db.setFilter({ statuses: ['Ready for UAT', 'To Do'], everyMinutes: 30 }, 'u-ram', 'ABCD');
    expect(db.listStories('ABCD').some((x) => x.key === 'ABCD-1004')).toBe(true);
    expect(db.getFilter('ABCD')).toMatchObject({ project: 'ABCD', statuses: ['Ready for UAT', 'To Do'], everyMinutes: 30 });
    // The other application's filter is untouched.
    expect(db.getFilter('IBGM').statuses).toEqual(['Ready for UAT', 'In Progress']);
    expect((db.raw.prepare('SELECT action FROM audit_log ORDER BY id').all() as { action: string }[]).map((a) => a.action)).toEqual(['story.create', 'jira_filter.update']);
  });

  it('rejects a story without a summary or criteria', () => {
    expect(() => parseStoryInput({ summary: '', acceptanceCriteria: 'a' }, 'u-ram', COMPONENTS)).toThrow('Add a summary.');
    expect(() => parseStoryInput({ summary: 's', acceptanceCriteria: '  ' }, 'u-ram', COMPONENTS)).toThrow('Add at least one acceptance criterion.');
  });
});
