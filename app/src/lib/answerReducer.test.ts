import { describe, expect, it } from 'vitest';

import { answerBlocks, applyEvent, initialAnswer } from './answerReducer';
import type { WorkflowEvent } from './workflow';

const approval = { title: 'Add 1 UAT test case?', facts: [], credentialNote: '', actionLabel: 'Add', status: 'pending' as const, action: 'add_uat_cases' as const, artifactId: 'uat-x' };

const play = (events: WorkflowEvent[]) => events.reduce(applyEvent, initialAnswer());

describe('answerReducer', () => {
  it('gives approvals the ids the server assigned, by their position in the full block list', () => {
    const answered = play([
      { type: 'answer', citations: [], blocks: [{ kind: 'prose', text: 'Two of four criteria are covered.' }, { kind: 'artifact', artifactId: 'uat-x' }, { kind: 'approval', approval }, { kind: 'followups', items: ['Why?'] }] },
      { type: 'done', summary: 'UAT analyst checked X', tokens: 0 },
    ]);
    const blocks = answerBlocks(answered);
    // run, prose, artifact, approval, followups: the approval is the fourth block, index 3.
    expect(blocks.map((b) => b.kind)).toEqual(['run', 'prose', 'artifact', 'approval', 'followups']);
    const saved = applyEvent(answered, { type: 'saved', revisionId: 'a1-r1', revision: 1, approvals: [{ index: 3, id: 'a1-r1-a3' }] });
    const block = answerBlocks(saved).find((b) => b.kind === 'approval');
    expect(block && block.kind === 'approval' ? block.approval.id : undefined).toBe('a1-r1-a3');
    expect(saved.revisionId).toBe('a1-r1');
    expect(saved.revision).toBe(1);
  });

  it('matches positions without a prose block too', () => {
    const s = play([
      { type: 'answer', citations: [], blocks: [{ kind: 'approval', approval }] },
      { type: 'done', summary: 'done', tokens: 0 },
      { type: 'saved', revisionId: 'a2-r1', approvals: [{ index: 1, id: 'a2-r1-a1' }] },
    ]);
    const block = answerBlocks(s).find((b) => b.kind === 'approval');
    expect(block && block.kind === 'approval' ? block.approval.id : undefined).toBe('a2-r1-a1');
  });

  it('keeps streamed text and citations, and closes the answer on done', () => {
    const s = play([
      { type: 'citations', citations: [{ n: 1, title: 'notes.md', detail: 'Attached file' }] },
      { type: 'text', text: 'Hello ' },
      { type: 'text', text: 'world [1].' },
      { type: 'done', summary: 'Analysis agent answered', tokens: 120 },
    ]);
    expect(s.status).toBe('done');
    expect(s.text).toBe('Hello world [1].');
    expect(s.citations).toHaveLength(1);
    expect(s.summary).toBe('Analysis agent answered · 120 tokens');
    expect(answerBlocks(s).map((b) => b.kind)).toEqual(['run', 'prose']);
  });
});
