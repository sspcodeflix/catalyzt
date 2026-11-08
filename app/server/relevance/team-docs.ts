/**
 * Team documents written for the retrieval evaluation: the kind of internal pages a quality team
 * uploads to App Context (policies, runbooks, handbooks). Fictional, written for this fixture; no
 * real organisation, person or system is described. The open-source excerpts that sit beside them
 * in the corpus are in excerpts.json, with their licences.
 */
export interface TeamDoc {
  /** Source title, as App Context shows it. */
  title: string;
  /** File name, used in the passage locator. */
  file: string;
  /** One entry per passage; the passage id is `<file> ¶<n>`. */
  passages: string[];
}

export const TEAM_DOCS: TeamDoc[] = [
  {
    title: 'Refund policy',
    file: 'refund-policy.md',
    passages: [
      'Partial refunds of a settled card payment are allowed for 45 days from settlement. After that window only a full refund through the support desk is possible, and it needs a team lead to approve it.',
      'Every card refund needs a reason code from the list in the merchant console: duplicate charge, item not received, item damaged, goodwill, or other. Refunds coded "other" must carry a free-text note of at least ten words.',
      'A refund can never exceed the original captured amount. The checkout service rejects such a request with error REFUND_EXCEEDS_CAPTURE and the console shows "The refund is larger than what was paid".',
      'Refunds to a wallet (Apple Pay, Google Pay) follow the card rules, because the wallet passes a tokenised card. Refunds of bank transfers are made as a new outgoing transfer and take two to three business days to arrive.',
      'Refunds above 5,000 EUR need a second approver from the finance operations team. The first approver cannot be the person who issued the original payment link.',
      'A refund issued in a different currency from the original payment is converted at the rate of the refund day, not the purchase day. The customer may therefore receive slightly more or less than they paid.',
    ],
  },
  {
    title: 'Release process',
    file: 'release-process.md',
    passages: [
      'We ship on a two-week release train. The branch for the next release is cut every second Wednesday at 10:00 Dubai time; from then on only fixes approved by the release captain are merged into it.',
      'Code freeze starts 48 hours before production deployment. During the freeze the release branch accepts only blocker fixes, each with a linked Jira ticket and a passing regression run.',
      'A hotfix skips the train: it branches from the production tag, needs two reviewers, and is deployed after the smoke suite passes in staging. The fix is then merged back into main the same day.',
      'Rollback is done by redeploying the previous production tag with the deploy pipeline, never by reverting commits on the release branch. The on-call engineer may roll back without asking anyone when error rates double after a deployment.',
      'Release notes are drafted by the release captain from the merged pull requests and reviewed by product owners on the Monday before deployment. Customer-facing changes need a line in plain language.',
      'Production deployments happen on Tuesdays and Thursdays between 07:00 and 11:00. No deployments are allowed on Fridays, on public holidays, or during the end-of-month financial close.',
    ],
  },
  {
    title: 'Flaky test policy',
    file: 'flaky-tests.md',
    passages: [
      'A test is considered flaky when it both passes and fails on the same commit within seven days. The nightly job marks such tests and opens a ticket for the owning component.',
      'Flaky tests are quarantined: they keep running but their failures no longer block a merge. A quarantined test must be fixed or deleted within 14 days, otherwise the component manager is notified.',
      'The CI pipeline retries a failed test once. A test that passes on retry is reported as passed-with-retry and counts towards its flakiness score; two retries in a week trigger quarantine.',
      'Never add sleeps to make a test stable. Wait for an observable condition instead (an element visible, a message on the queue, a row in the database) with an explicit timeout.',
      'Tests that depend on the current date must freeze the clock. Most of our historical flakiness came from tests that ran across midnight UTC or on the last day of a month.',
    ],
  },
  {
    title: 'UAT handbook',
    file: 'uat-handbook.md',
    passages: [
      'User acceptance testing is run by the business owner of the story, not by the developer who built it. The QA engineer prepares the cases and the environment; the business owner executes them and records the outcome.',
      'A story can be signed off for UAT only when every acceptance criterion has at least one executed case with evidence: a screenshot, an exported report or a recorded session. Criteria without evidence keep the story open.',
      'UAT sign-off is recorded in Jira by moving the story to "UAT Passed" and attaching the evidence pack. The approver must be a named product owner; team aliases are not accepted.',
      'When a UAT case fails, the tester raises a defect linked to the story with steps, expected and actual results. The story returns to development and its UAT cases are re-run in full after the fix.',
      'UAT runs in the UAT environment with masked production data refreshed every Monday. Testers must not use their own real card or bank details.',
      'The UAT window for a release closes 24 hours before code freeze. Stories that have not passed UAT by then move to the next release train.',
    ],
  },
  {
    title: 'On-call runbook',
    file: 'on-call-runbook.md',
    passages: [
      'The primary on-call engineer must acknowledge a page within 5 minutes and start working on it within 15. If the primary does not acknowledge, the page escalates to the secondary and then to the engineering manager.',
      'Severity 1 means customers cannot pay or check out. A severity 1 incident opens a bridge call immediately, the incident commander posts updates every 30 minutes, and the status page is updated within 10 minutes.',
      'When the checkout service crashloops after a deployment, first roll back to the previous tag. Only then read the pod logs; restarting the pods without a rollback usually brings the same crash back.',
      'If the payment gateway returns timeouts for more than five minutes, switch traffic to the secondary acquirer with the feature flag payments.failover. Announce the switch in the incidents channel.',
      'After every severity 1 or 2 incident a blameless post-incident review is held within five working days. The review lists the timeline, the contributing factors and owners for each follow-up action.',
      'On-call shifts are one week long, handed over on Monday at 10:00 with a written summary of open alerts. Engineers on call get a day off in lieu for every weekend they were paged.',
    ],
  },
  {
    title: 'Test data management',
    file: 'test-data.md',
    passages: [
      'Production data is never copied to test environments as is. The weekly refresh job masks names, emails, phone numbers and card numbers before the data leaves the production network.',
      'Masked card numbers keep the first six and last four digits so that card brand detection still works; the middle digits are replaced and the result fails the Luhn check on purpose.',
      'Automated tests create their own data through the public APIs and delete it afterwards. Shared fixture accounts in the QA environment are read-only and must not be modified by a test.',
      'Synthetic customer profiles for performance tests are generated from the seed file in the test-data repository. Each run uses a new seed so caches do not hide slow paths.',
      'Personal data in bug reports must be removed before the report is shared outside the team. Attach masked exports, never screenshots that show a customer name or address.',
    ],
  },
  {
    title: 'Performance testing guide',
    file: 'performance-testing.md',
    passages: [
      'The checkout API must answer within 300 ms at the 95th percentile and 800 ms at the 99th percentile under the expected peak load of 400 requests per second.',
      'Load tests run every night against the performance environment, which is sized at half of production. Results are compared with the previous seven nights and a regression of more than 10 percent fails the run.',
      'A soak test of eight hours at 60 percent of peak load runs before every major release to catch memory leaks and connection pool exhaustion.',
      'Performance test scripts live in the perf directory of each service and are written with k6. A new endpoint is not done until it has a script and a threshold.',
      'When a load test fails, the first thing to check is whether the performance environment was shared with another run at the same time; the scheduler keeps a lock but manual runs can bypass it.',
    ],
  },
  {
    title: 'Accessibility checklist',
    file: 'accessibility.md',
    passages: [
      'Every customer-facing screen must meet WCAG 2.1 level AA. The automated axe scan in CI catches about a third of issues; the rest need a manual pass with a screen reader.',
      'Text must have a contrast ratio of at least 4.5 to 1 against its background, 3 to 1 for large text and for icons that carry meaning.',
      'All interactive elements must be reachable and usable with the keyboard alone, in a logical order, with a visible focus outline. Focus must never be trapped inside a dialog without a way out.',
      'Images that carry information need alternative text; decorative images get an empty alt attribute so screen readers skip them. Form fields need visible labels, not only placeholders.',
      'Manual accessibility checks are done with NVDA on Windows and VoiceOver on iOS for each release that changes the checkout or sign-up flows.',
    ],
  },
  {
    title: 'Mobile app QA',
    file: 'mobile-qa.md',
    passages: [
      'The device matrix covers the three latest iOS versions and Android 11 to 14, on at least one small-screen phone, one large phone and one tablet per platform.',
      'Release candidates of the mobile app go to internal testers through TestFlight and the Play Console internal track at least three days before store submission.',
      'Crash-free sessions must stay above 99.5 percent for a release to be rolled out beyond 20 percent of users. The rollout is paused automatically when the rate drops below that.',
      'Deep links from payment confirmation emails must open the order screen in the app when it is installed, and the web order page otherwise. This is checked on both platforms for every release.',
      'Push notification tests use a dedicated test project in Firebase; never send test pushes from the production project, even to your own device.',
    ],
  },
  {
    title: 'Security testing',
    file: 'security-testing.md',
    passages: [
      'An external penetration test of the payment flows is commissioned once a year and after any change to authentication or card handling. Findings rated high must be fixed before the next release.',
      'Dependency scanning runs on every pull request. A critical vulnerability in a direct dependency blocks the merge; in a transitive dependency it opens a ticket with a 30-day deadline.',
      'Static analysis rules for injection, unsafe deserialisation and hard-coded credentials run in CI. A suppression needs a comment explaining why and the approval of a security champion.',
      'Secrets are stored in the vault and injected at deploy time. A secret found in a repository is treated as leaked: it is rotated first and removed from the history afterwards.',
      'Test accounts with elevated rights expire after 30 days. Requests for longer access go through the access review board every quarter.',
    ],
  },
  {
    title: 'Environment guide',
    file: 'environments.md',
    passages: [
      'There are four environments: dev (deployed on every merge to main), QA (deployed nightly), UAT (deployed per release candidate) and production. Staging is the name we use for the UAT environment in older documents.',
      'Feature flags are managed in the flag service and default to off in production. A flag that has been fully on for 30 days must be removed from the code together with the old path.',
      'The QA environment is reset every night at 02:00 UTC. Data created during the day is gone the next morning, so long-running manual tests should use the UAT environment.',
      'Third-party payment providers are replaced by their sandbox in dev, QA and UAT. Only production talks to the live acquirer; test card numbers are listed in the provider documentation.',
      'Environment access is requested through the self-service portal. QA access is granted automatically to engineers; UAT access needs the product owner of the application.',
    ],
  },
  {
    title: 'Payments operations',
    file: 'payments-ops.md',
    passages: [
      'Card payments are captured at dispatch, not at order time. An authorisation that is not captured within seven days expires and the order has to be paid again.',
      'Settlement files from the acquirer arrive daily at 06:00 and are reconciled against our ledger by 09:00. Any unmatched transaction is put on the reconciliation exceptions list for the finance team.',
      'A chargeback is a dispute raised by the cardholder through their bank. The merchant has 10 days to submit evidence; without a response the dispute is lost automatically.',
      'Prices are stored in the merchant currency and shown in the shopper currency at checkout, using the exchange rate published by the treasury service every hour.',
      'Duplicate payment protection: the same order cannot be charged twice within 24 hours unless the first attempt failed. The idempotency key is the order number plus the attempt number.',
      'Payouts to merchants run every weekday at 15:00 for all settled transactions, minus fees and any chargeback amounts. Payouts below 10 EUR are carried over to the next run.',
    ],
  },
  {
    title: 'Defect triage',
    file: 'defect-triage.md',
    passages: [
      'Defects are triaged twice a week by the QA lead, a developer and the product owner. Each defect gets a severity (impact) and a priority (order of work); they are decided separately.',
      'Severity is about impact: S1 blocks a core journey for all users with no workaround, S2 blocks it for some users or has a painful workaround, S3 is a minor problem, S4 is cosmetic.',
      'Target fix times: S1 within 24 hours, S2 within the current release, S3 within two releases. S4 defects are fixed when the area is touched next.',
      'A defect found in production also gets a missing-test analysis: which test should have caught it, and why it did not. The answer is recorded on the defect before it is closed.',
      'Defects that cannot be reproduced after two attempts by two people are closed as not reproducible with the attempts described; they are reopened if the reporter sees them again.',
    ],
  },
  {
    title: 'Code review guidelines',
    file: 'code-review.md',
    passages: [
      'Every pull request needs one approving review from a member of the owning team; changes to payment, authentication or database migrations need two.',
      'New and changed code must be covered by tests. The coverage gate fails a pull request when line coverage of the changed files drops below 80 percent.',
      'Pull requests should stay below 400 changed lines. Larger changes are split, or reviewed in a walkthrough call with the reviewer.',
      'A reviewer should answer within one working day. If the review takes longer the author may ask another team member, saying so on the pull request.',
      'Database migrations must be backwards compatible with the previous release, so that a rollback of the application does not require a rollback of the schema.',
    ],
  },
  {
    title: 'Customer support playbook',
    file: 'support-playbook.md',
    passages: [
      'Support agents can see an order, its payments and its refunds, but cannot change a payment. Anything that moves money is escalated to the payments operations queue.',
      'Tickets are answered within four business hours for merchants on the premium plan and within one business day for everyone else.',
      'When several customers report the same problem within an hour, the support lead opens an incident in the on-call tool instead of handling the tickets one by one.',
      'Support never asks a customer for a full card number or a one-time password, in any channel. Customers who send one are told to cancel the card and their message is redacted.',
      'Complaints about accessibility are routed to the design team as well as to the product owner, and get a reply within two business days.',
    ],
  },
];
