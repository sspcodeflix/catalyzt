/**
 * Proposed UAT cases are derived from the criterion (R07): a short title, steps that follow the
 * criterion's own shape, and no lower-cased acronyms.
 */
import { describe, expect, it } from 'vitest';

import type { Ticket } from './types';
import { followUps, isUatCandidate, shortTitle, stepsFor, uatAnswer } from './uat';

describe('scan-only repository caveat (R24)', () => {
  const t: Ticket = {
    key: 'IBGM-1015',
    summary: 'Customer login on the Juice Shop portal',
    type: 'Story',
    status: 'Ready for UAT',
    fixVersion: '',
    components: ['customer-portal'],
    assignee: '',
    updated: '2026-11-08T00:00:00Z',
    description: '',
    acceptanceCriteria: ['Login returns 200', 'A wrong password returns 401'],
    requirements: [],
    uat: { state: 'not-analysed', covered: 0, total: 2 },
  };
  const coverage = [
    { status: 'not-run' as const, evidence: 'Manual test, no result yet' },
    { status: 'no-test' as const, evidence: 'No test linked to this criterion' },
  ];
  it('says automated evidence cannot arrive, in the prose, the report subtitle and its note', () => {
    const { answer, artifact } = uatAnswer(t, coverage, { scanOnly: [{ component: 'customer-portal', repo: 'juice-shop/juice-shop' }] });
    const prose = answer.blocks.find((b) => b.kind === 'prose');
    expect(prose?.kind === 'prose' && prose.text).toMatch(/customer-portal \(juice-shop\/juice-shop\) is scanned through GitHub only: no clone, no CI target and no recorded pipeline run, so no automated test result can arrive/);
    expect(artifact.subtitle).toContain('scan-only repository, no automated evidence');
    expect(artifact.note).toContain('scanned through GitHub only');
  });
  it('says nothing when every repository can deliver results', () => {
    const { answer, artifact } = uatAnswer(t, coverage);
    const prose = answer.blocks.find((b) => b.kind === 'prose');
    expect(prose?.kind === 'prose' && prose.text).not.toMatch(/scanned through GitHub/);
    expect(artifact.subtitle).not.toContain('scan-only');
  });
});

describe('follow-up questions', () => {
  it('offers "what changed since" only when an earlier analysis exists, and points suggested tests at the report, not a sign-off note', () => {
    const base = { gaps: false, failing: false, ready: false, suggested: true, previous: false };
    expect(followUps('SALR-1004', base)).toEqual(['Which tests cover this story?', 'Show the latest pipeline run']);
    expect(followUps('SALR-1004', { ...base, previous: true })).toEqual(['Which tests cover this story?', 'What changed since SALR-1004 was last analysed?']);
    expect(followUps('SALR-1004', { ...base, ready: true })).toEqual(['Draft the UAT sign-off note', 'Which tests cover this story?']);
    expect(followUps('SALR-1004', { ...base, ready: true, previous: true })).toEqual(['Draft the UAT sign-off note', 'What changed since SALR-1004 was last analysed?']);
    expect(followUps('SALR-1004', { ...base, gaps: true, previous: true })).toEqual(['Write automation for the gaps', 'Which tests cover this story?']);
    // No pair ever repeats a question.
    for (const s of [base, { ...base, suggested: false }, { ...base, ready: true }]) expect(new Set(followUps('X-1', s)).size).toBe(2);
  });
});

describe('proposed UAT cases', () => {
  it('keeps a short criterion as the title and cuts a long one at a word', () => {
    expect(shortTitle('A card refund needs a reason')).toBe('A card refund needs a reason');
    const long = shortTitle('Starting account-service with a wrong CONFIG_SERVICE_PASSWORD makes the container exit within ten seconds with a clear message in the log');
    expect(long.length).toBeLessThanOrEqual(91);
    expect(long.endsWith('…')).toBe(true);
    expect(long).not.toMatch(/\s…$/);
  });

  it('derives a call step from an HTTP criterion and never lower-cases the method', () => {
    const steps = stepsFor('PUT /statistics/{account} with a ui-scope token returns HTTP 403 and changes nothing');
    expect(steps).toHaveLength(3);
    expect(steps[1]).toBe('Call PUT /statistics/{account} as the criterion describes');
    expect(steps[2]).toBe('Check: returns HTTP 403 and changes nothing');
    expect(steps.join(' ')).not.toContain('pUT');
    expect(steps.join(' ')).not.toContain('Sign in');
  });

  it('describes the situation, then the check, for a criterion with no call in it', () => {
    const steps = stepsFor('Starting account-service with a wrong CONFIG_SERVICE_PASSWORD makes the container exit');
    expect(steps[0]).toBe('Set up: starting account-service with a wrong CONFIG_SERVICE_PASSWORD');
    expect(steps[1]).toBe('Check: makes the container exit');
    expect(steps[2]).toBe('Record the result and a screenshot');
    // No expectation verb: the whole criterion is the check and the set-up is generic.
    expect(stepsFor('Totals in the shopper currency')).toEqual(['Set up the situation the criterion describes (data, roles, configuration)', 'Check: totals in the shopper currency', 'Record the result and a screenshot']);
  });

  it('knows which Jira states are UAT candidates (R06)', () => {
    expect(isUatCandidate('Ready for UAT')).toBe(true);
    expect(isUatCandidate('Done')).toBe(true);
    expect(isUatCandidate('In Progress')).toBe(false);
    expect(isUatCandidate('To Do')).toBe(false);
  });
});

describe('link suggestions in the UAT answer', () => {
  const t: Ticket = {
    key: 'ABCD-1001',
    summary: 'Partial refunds',
    type: 'Story',
    status: 'Ready for UAT',
    fixVersion: '',
    components: ['checkoutservice'],
    assignee: '',
    updated: '2026-11-08T00:00:00Z',
    description: '',
    acceptanceCriteria: ['A card refund needs a reason', 'Partial refunds are allowed for 45 days from settlement'],
    requirements: [],
    uat: { state: 'not-analysed', covered: 0, total: 2 },
  };
  it('drafts no case for a criterion with a passing suggestion and asks a person to link it', () => {
    const coverage = [
      { status: 'no-test' as const, evidence: 'No test linked to this criterion' },
      { status: 'no-test' as const, evidence: 'No test linked to this criterion', suggestions: [{ id: 't1', title: 'Partial refunds allowed within 45 days', result: 'passed', why: 'shares partial, refunds, days, settlement' }] },
    ];
    const { answer, artifact } = uatAnswer(t, coverage);
    const prose = answer.blocks.find((b) => b.kind === 'prose');
    const text = prose?.kind === 'prose' ? prose.text : '';
    expect(text).toMatch(/I drafted 1 UAT test case for the gaps/);
    expect(text).toMatch(/For 1 criterion a CI test that passed looks like it covers it/);
    expect(artifact.criteria[1].suggestions?.[0].id).toBe('t1');
    expect(artifact.criteria[1].status).toBe('no-test');
  });
  it('still drafts a case when the suggested test did not pass', () => {
    const coverage = [{ status: 'no-test' as const, evidence: 'none', suggestions: [{ id: 't1', title: 'x', result: 'failed', why: 'y' }] }];
    const { answer } = uatAnswer({ ...t, acceptanceCriteria: ['A card refund needs a reason'] }, coverage);
    const prose = answer.blocks.find((b) => b.kind === 'prose');
    expect(prose?.kind === 'prose' && prose.text).toMatch(/I drafted 1 UAT test case/);
    expect(prose?.kind === 'prose' && prose.text).not.toMatch(/looks like it covers/);
  });
});
