import { describe, expect, it } from 'vitest';

import { reasonFavoursOther } from './huddleReason';

describe('R16: a reason that argues for another option', () => {
  const options = [
    { id: 'o1', title: 'Keep Jira · project IBGM: the README does not state a rule' },
    { id: 'o2', title: 'Use team-notes-0303.md: at least one linked test per criterion' },
  ];

  it('warns when the reason names the other option more than the chosen one (the reviewed case)', () => {
    const reason = 'Team notes stand: one linked test per criterion, until the README says otherwise';
    expect(reasonFavoursOther(reason, options, 'o1')?.id).toBe('o2');
    expect(reasonFavoursOther(reason, options, 'o2')).toBeNull();
  });

  it('stays quiet for a neutral or matching reason', () => {
    expect(reasonFavoursOther('Product confirmed it.', options, 'o1')).toBeNull();
    expect(reasonFavoursOther('Jira is the agreed source until the IBGM project changes it', options, 'o1')).toBeNull();
    expect(reasonFavoursOther('', options, 'o1')).toBeNull();
    // A single shared word is not enough to warn.
    expect(reasonFavoursOther('We need a test.', options, 'o1')).toBeNull();
  });

  it('works for ordinary decisions', () => {
    const opts = [
      { id: 'a', title: 'checkoutservice' },
      { id: 'b', title: 'paymentservice owns the refund tests' },
    ];
    expect(reasonFavoursOther('The refund tests and page objects live in paymentservice.', opts, 'a')?.id).toBe('b');
  });
});
