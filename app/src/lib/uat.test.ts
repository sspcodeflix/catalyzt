/**
 * Proposed UAT cases are derived from the criterion (R07): a short title, steps that follow the
 * criterion's own shape, and no lower-cased acronyms.
 */
import { describe, expect, it } from 'vitest';

import { isUatCandidate, shortTitle, stepsFor } from './uat';

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
