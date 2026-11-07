import { describe, expect, it } from 'vitest';

import { JUnitError, parseJUnit } from './junit';
import { matchCase, type Candidate } from './results';

const SUREFIRE = `<?xml version="1.0" encoding="UTF-8"?>
<testsuite name="payments.PartialRefundsForTest" tests="3" failures="1" skipped="1" time="1.2">
  <testcase name="aMerchantCanRefundPartOfASettledCardPayment" classname="payments.PartialRefundsForTest" time="0.4"/>
  <testcase name="aRefundAboveTheOriginalAmountIsRejectedWithAClearMessage()" classname="payments.PartialRefundsForTest" time="0.5">
    <failure message="expected 422 but was 200" type="AssertionError">at PartialRefundsForTest.java:31</failure>
  </testcase>
  <testcase name="aCardRefundNeedsAReason" classname="payments.PartialRefundsForTest" time="0"><skipped/></testcase>
</testsuite>`;

const PYTEST = `<testsuites><testsuite name="pytest"><testcase classname="tests.test_refunds.TestRefund" name="test_needs_reason" time="0.01" file="tests/test_refunds.py"/></testsuite></testsuites>`;
const GO = `<testsuites><testsuite name="github.com/x/shop/src/checkoutservice/money" tests="1"><testcase classname="github.com/x/shop/src/checkoutservice/money" name="TestIsValid" time="0.000"/></testsuite></testsuites>`;
const JEST = `<testsuites name="jest tests"><testsuite name="cart"><testcase classname="cart adds an item" name="cart adds an item" time="0.003"><error message="boom"/></testcase></testsuite></testsuites>`;

describe('parseJUnit', () => {
  it('reads Maven Surefire with failures and skips', () => {
    expect(parseJUnit(SUREFIRE)).toEqual([
      { classname: 'payments.PartialRefundsForTest', name: 'aMerchantCanRefundPartOfASettledCardPayment', file: null, status: 'passed', durationMs: 400, message: null },
      { classname: 'payments.PartialRefundsForTest', name: 'aRefundAboveTheOriginalAmountIsRejectedWithAClearMessage()', file: null, status: 'failed', durationMs: 500, message: 'expected 422 but was 200\nat PartialRefundsForTest.java:31' },
      { classname: 'payments.PartialRefundsForTest', name: 'aCardRefundNeedsAReason', file: null, status: 'skipped', durationMs: 0, message: null },
    ]);
  });
  it('reads pytest, go-junit-report and jest-junit', () => {
    expect(parseJUnit(PYTEST)[0]).toMatchObject({ name: 'test_needs_reason', file: 'tests/test_refunds.py', status: 'passed' });
    expect(parseJUnit(GO)[0]).toMatchObject({ name: 'TestIsValid', status: 'passed' });
    expect(parseJUnit(JEST)[0]).toMatchObject({ status: 'failed', message: 'boom' });
  });
  it('rejects DOCTYPE and non-JUnit XML', () => {
    expect(() => parseJUnit('<!DOCTYPE x [<!ENTITY a "b">]><testsuite/>')).toThrow(JUnitError);
    expect(() => parseJUnit('<html/>')).toThrow(/JUnit/);
  });
});

describe('matchCase', () => {
  const cands: Candidate[] = [
    { id: 'A', suite: 'PartialRefundsForTest', codeName: 'aMerchantCanRefundPartOfASettledCardPayment', title: 'x', path: 'src/test/java/payments/PartialRefundsForTest.java' },
    { id: 'B', suite: 'OtherTest', codeName: 'isValid', title: 'Is valid', path: 'src/a/OtherTest.java' },
    { id: 'C', suite: 'money_test.go', codeName: 'TestIsValid', title: 'Is valid', path: 'src/checkoutservice/money/money_test.go' },
    { id: 'D', suite: 'money_test.go', codeName: 'TestIsValid', title: 'Is valid', path: 'src/other/money/x_test.go' },
    { id: 'E', suite: 'cart', codeName: 'adds an item', title: 'adds an item', path: 'web/cart.test.ts' },
  ];
  it('matches by method and class', () => expect(matchCase(parseJUnit(SUREFIRE)[0], cands)?.id).toBe('A'));
  it('uses the package path to choose between same-named Go tests', () => expect(matchCase(parseJUnit(GO)[0], cands)?.id).toBe('C'));
  it('matches Jest by suite and title', () => expect(matchCase(parseJUnit(JEST)[0], cands)?.id).toBe('E'));
  it('matches a test recorded before code names were stored, by its title', () => {
    const old: Candidate[] = [{ id: 'S', suite: 'PartialRefundsForTest', codeName: null, title: 'A merchant can refund part of a settled card payment', path: null }];
    expect(matchCase(parseJUnit(SUREFIRE)[0], old)?.id).toBe('S');
  });
  it('returns nothing when unsure', () => expect(matchCase({ classname: 'z.Zed', name: 'nothingLikeIt', file: null, status: 'passed', durationMs: 1, message: null }, cands)).toBeUndefined());
});
