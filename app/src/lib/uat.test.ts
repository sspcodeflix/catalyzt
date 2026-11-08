/**
 * Proposed UAT cases are derived from the criterion (R07): a short title, steps that follow the
 * criterion's own shape, and no lower-cased acronyms.
 */
import { describe, expect, it } from 'vitest';

import type { Ticket } from './types';
import { isUatCandidate, shortTitle, stepsFor, uatAnswer } from './uat';

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
