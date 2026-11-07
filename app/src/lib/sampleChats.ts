// Seed conversation matching the "03-test-authoring" mock-up. All names are placeholders.
import { scopes } from './data';
import type { Chat } from './types';

const code: [number, string][] = [
  [12, '  @Tag("FR-0231") @Tag("ai-written")'],
  [13, '  @Test'],
  [14, '  void partialRefundAboveOriginalIsRejected() {'],
  [15, '    Payment payment = payments.settled(AED, 500);'],
  [16, '    refundPage.open(payment)'],
  [17, '        .requestRefund(payment.amount().plus(1));'],
  [18, '    assertThat(refundPage.error())'],
  [19, '        .contains("exceeds the original amount");'],
  [20, '  }'],
  [21, ''],
  [22, '  @Tag("FR-0233") @Tag("ai-written")'],
  [23, '  @Test'],
  [24, '  void cardRefundNeedsAReason() {'],
  [25, '    refundPage.open(payments.settled(AED, 120))'],
  [26, '        .requestRefund(withoutReason());'],
  [27, '    assertThat(refundPage.fieldError("reason")).isVisible();'],
  [28, '  }'],
];

export const sampleChats: Chat[] = [
  {
    id: 'refund-tests',
    title: 'Refund tests for FR-0231',
    agent: 'authoring',
    scope: scopes[0],
    testType: null,
    messages: [
      { id: 'u1', role: 'user', text: 'Write automation for FR-0231 and FR-0233 and open the pull request.' },
      {
        id: 'a1',
        role: 'assistant',
        capability: 'authoring',
        revision: 1,
        rating: null,
        citations: [
          { n: 1, title: 'Accepted test cases TC-0231-1, TC-0233-1', detail: 'Test authoring · accepted yesterday by Omar K.' },
          { n: 2, title: 'RefundPage.java', detail: 'pay-hub-automation · commit a1b2c3d' },
          { n: 3, title: 'FR-0231, FR-0233', detail: 'Enterprise Knowledge Fabric · Refunds §3.2 v14' },
        ],
        blocks: [
          {
            kind: 'run',
            summary: 'Wrote 2 tests · skills selenium-java-pageobject@a1b2c3d · 41 s',
            steps: [
              { label: 'Read accepted test cases', detail: 'TC-0231-1, TC-0233-1', noModel: true, seconds: 1 },
              { label: 'Found page objects', detail: 'RefundPage, PaymentsFixture', noModel: true, seconds: 3 },
              { label: 'Wrote tests', detail: 'selenium-java-pageobject@a1b2c3d', seconds: 31 },
              { label: 'Compiled and linted', detail: 'mvn -q test-compile, checkstyle', noModel: true, seconds: 6 },
            ],
          },
          {
            kind: 'prose',
            text: 'I wrote 2 tests from the accepted test cases [1] and reused the existing `RefundPage` page object [2]. Each test carries its requirement tag and the `ai-written` tag. Expected results come from the requirements [3].',
          },
          { kind: 'artifact', artifactId: 'partial-refund-test' },
          {
            kind: 'approval',
            approval: {
              title: 'Open a pull request?',
              facts: [
                { label: 'Repository', value: 'payments/pay-hub-automation', mono: true },
                { label: 'Branch', value: 'horizon/fr-0231-refund-tests', mono: true },
                { label: 'Changes', value: '2 files, +86 lines' },
                { label: 'Then', value: 'The CI pipeline runs the PR check from Git. A person reviews and merges.' },
              ],
              credentialNote: 'Uses your GitHub token via the credential broker',
              actionLabel: 'Open pull request',
              status: 'pending',
            },
          },
          { kind: 'followups', items: ['Add a test for refunds in another currency', 'Explain the expected results'] },
        ],
      },
    ],
    artifacts: {
      'partial-refund-test': {
        id: 'partial-refund-test',
        kind: 'code',
        title: 'PartialRefundTest.java',
        subtitle: '2 new tests · pay-hub-automation · draft, not committed',
        cardLabel: 'Script · 2 tests',
        path: 'src/test/java/refunds/PartialRefundTest.java',
        changeLabel: '+86',
        lines: code.map(([n, text]) => ({ n, text, change: 'add' })),
        testCases: [
          { id: 'TC-0231-1', title: 'Partial refund above the original amount is rejected', requirement: 'FR-0231' },
          { id: 'TC-0233-1', title: 'Card refund needs a reason', requirement: 'FR-0233' },
        ],
        note: 'Expected results come from FR-0231 and FR-0233 in the Enterprise Knowledge Fabric (Refunds §3.2, v14). Journeys data was used only to find the screens.',
      },
    },
  },
];
