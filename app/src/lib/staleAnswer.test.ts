import { describe, expect, it } from 'vitest';

import type { Intent } from './intent';
import { HEXA_COMPONENT_FACTS, questionFor, staleTestFacts } from './staleAnswer';
import type { AssistantMessage, Citation, Message } from './types';

const intent = (components: string[], extra: Partial<Intent> = {}): Intent => ({
  capability: 'analysis',
  testType: 'uat',
  action: 'Identify tests',
  tickets: [],
  components,
  confidence: 0.85,
  question: null,
  options: [],
  source: 'model',
  ...extra,
});
const answer = (i: Intent | undefined, citations: Citation[], extra: Partial<AssistantMessage> = {}): AssistantMessage => ({
  id: 'a1',
  role: 'assistant',
  capability: 'analysis',
  revision: 1,
  rating: null,
  status: 'done',
  intent: i,
  citations,
  blocks: [{ kind: 'run', summary: 'Analysis agent answered', steps: [] }, { kind: 'prose', text: 'No automated tests.' }],
  ...extra,
});
const passage: Citation = { n: 1, title: 'piggymetrics', detail: 'App Context · README.md ¶3 · v1', href: '/context/source/x#chunk-3' };

describe('saved answers with old test facts (R04)', () => {
  it('flags an answer about a component that never read Hexa (the 03:07 simulated chats)', () => {
    expect(staleTestFacts(answer(intent(['account-service']), [passage]))).toBe('no-hexa');
  });

  it('flags Hexa facts from the title-only match, and accepts the current ones', () => {
    const old: Citation = { n: 2, title: 'Hexa · account-service', detail: 'account-service · tests and latest results', href: '/hexa?tab=automated&q=account-service' };
    expect(staleTestFacts(answer(intent(['account-service']), [passage, old]))).toBe('old-matching');
    const now: Citation = { ...old, detail: `account-service · ${HEXA_COMPONENT_FACTS} · latest results` };
    expect(staleTestFacts(answer(intent(['account-service']), [passage, now]))).toBeNull();
  });

  it('leaves alone what it cannot judge: no components, UAT reports, questions, unfinished answers', () => {
    expect(staleTestFacts(answer(intent([]), [passage]))).toBeNull();
    expect(staleTestFacts(answer(undefined, [passage]))).toBeNull();
    expect(staleTestFacts(answer(intent(['account-service'], { question: 'UAT or regression?' }), []))).toBeNull();
    expect(staleTestFacts(answer(intent(['account-service']), [], { blocks: [{ kind: 'artifact', artifactId: 'uat-ibgm-1001' }] }))).toBeNull();
    expect(staleTestFacts(answer(intent(['account-service']), [], { status: 'stopped' }))).toBeNull();
  });

  it('resends the question the answer replied to, never a removed one', () => {
    const msgs: Message[] = [
      { id: 'u1', role: 'user', text: 'Which tests cover account-service?', components: ['account-service'] },
      answer(intent(['account-service']), []),
      { id: 'u2', role: 'user', text: '[Message removed: it contained a secret]' },
      { ...answer(intent(['x']), []), id: 'a2' },
    ];
    expect(questionFor(msgs, 'a1')).toMatchObject({ text: 'Which tests cover account-service?', components: ['account-service'] });
    expect(questionFor(msgs, 'a2')).toBeNull();
  });
});
