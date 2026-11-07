import { describe, expect, it } from 'vitest';

import { routeByRules, rulesIntent } from './routing';

describe('routeByRules', () => {
  it.each([
    ['Fix critical CVEs in ABCD', 'security'],
    ['Why is payments-api restarting?', 'cloudops'],
    ['Why did last night fail?', 'execution'],
    ['Write tests for PAY-1482', 'authoring'],
    ['Is PAY-1482 ready for UAT?', 'analysis'],
    ['How well is Payments Hub covered?', 'analysis'],
  ])('%s -> %s', (text, cap) => expect(routeByRules(text)).toBe(cap));
});

describe('rulesIntent', () => {
  it('keeps the user-chosen agent and test type', () => {
    const i = rulesIntent({ text: 'Why did last night fail?', agent: 'security', testType: 'uat', tickets: [], components: [] });
    expect(i).toMatchObject({ capability: 'security', testType: 'uat', confidence: 1, source: 'rules' });
  });

  it('finds the ticket for a UAT question', () => {
    const i = rulesIntent({ text: 'Is PAY-1482 ready for UAT?', agent: 'auto', testType: null, tickets: [], components: [] });
    expect(i).toMatchObject({ capability: 'analysis', testType: 'uat', tickets: ['PAY-1482'] });
  });
});
