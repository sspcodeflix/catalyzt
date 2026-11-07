import { describe, expect, it } from 'vitest';

import { detectTestType, findTickets } from './testType';

describe('findTickets', () => {
  it('finds Jira keys and links, without duplicates', () => {
    expect(findTickets('Check PAY-1482 and https://acme.atlassian.net/browse/PAY-1482')).toEqual(['PAY-1482']);
    expect(findTickets('see https://jira.example.com/browse/MRCH-77?focusedCommentId=1')).toEqual(['MRCH-77']);
  });

  it('ignores requirement, test case, CVE and scan ids', () => {
    expect(findTickets('FR-0231, TC-0231-1, CVE-2026-10421 and scan S-023')).toEqual([]);
  });
});

describe('detectTestType', () => {
  it('says regression when the user says regression, even with a ticket', () => {
    const d = detectTestType('Run the regression for PAY-1482');
    expect(d).toMatchObject({ type: 'regression', ambiguous: false, tickets: ['PAY-1482'] });
  });

  it('treats nightly, smoke and suite as regression', () => {
    expect(detectTestType('Why did nightly fail?').type).toBe('regression');
    expect(detectTestType('Run the smoke tests').type).toBe('regression');
  });

  it('says UAT for a Jira key or link', () => {
    expect(detectTestType('Is PAY-1482 ready?')).toMatchObject({ type: 'uat', reason: 'from PAY-1482' });
    expect(detectTestType('https://acme.atlassian.net/browse/PAY-1490').type).toBe('uat');
  });

  it('says UAT for explicit words', () => {
    expect(detectTestType('Plan the UAT for release 24.11').type).toBe('uat');
    expect(detectTestType('Check the acceptance criteria').type).toBe('uat');
    expect(detectTestType('Who gives sign-off?').type).toBe('uat');
  });

  it('says regression when a component is attached', () => {
    expect(detectTestType('What should we test?', { components: ['refund-service'] })).toMatchObject({
      type: 'regression',
      reason: 'for refund-service',
    });
  });

  it('is ambiguous for a ticket plus a component, or both words', () => {
    expect(detectTestType('Test this', { tickets: ['PAY-1482'], components: ['refund-service'] }).ambiguous).toBe(true);
    expect(detectTestType('UAT and regression for 24.11').ambiguous).toBe(true);
  });

  it('detects nothing when there is nothing to go on', () => {
    expect(detectTestType('How well is Payments Hub covered?')).toEqual({ type: null, ambiguous: false, reason: '', tickets: [] });
  });

  it('does not treat words inside other words as keywords', () => {
    expect(detectTestType('Show the pursuit of quality').type).toBeNull();
  });
});
