/**
 * Labelled questions for the retrieval evaluation. `relevant` lists the passages that answer the
 * question (ids as in corpus.ts: `team:<file> ¶<n>` for the team documents, `<repo>:<path> ¶<n>`
 * for the open-source excerpts). Kinds:
 *
 *   paraphrase  worded with no keyword in common with any relevant passage (checked by the test),
 *               so only meaning can find the answer
 *   exact       names a code, product or identifier that appears in the answer
 *   mixed       ordinary wording that shares some words with the answer
 *   none        nothing in the corpus answers it; any passage returned is a false positive
 */
export type QuestionKind = 'paraphrase' | 'exact' | 'mixed' | 'none';

export interface LabelledQuestion {
  id: string;
  q: string;
  kind: QuestionKind;
  relevant: string[];
}

const t = (file: string, n: number) => `team:${file} ¶${n}`;

export const QUESTIONS: LabelledQuestion[] = [
  /* ---------- Paraphrase: no shared keywords ---------- */
  { id: 'p01', kind: 'paraphrase', q: 'How long after the money was taken can a customer get some of it back?', relevant: [t('refund-policy.md', 1)] },
  { id: 'p02', kind: 'paraphrase', q: 'Can we return to a buyer more than they spent?', relevant: [t('refund-policy.md', 3)] },
  { id: 'p03', kind: 'paraphrase', q: 'Ahead of going live, when do we stop taking changes?', relevant: [t('release-process.md', 2)] },
  { id: 'p04', kind: 'paraphrase', q: 'What do I do with an unreliable check that sometimes goes red?', relevant: [t('flaky-tests.md', 1), t('flaky-tests.md', 2)] },
  { id: 'p05', kind: 'paraphrase', q: 'Who confirms a feature works for the client before it ships?', relevant: [t('uat-handbook.md', 1), t('uat-handbook.md', 3)] },
  { id: 'p06', kind: 'paraphrase', q: 'My pager went off, how quickly am I expected to respond?', relevant: [t('on-call-runbook.md', 1)] },
  { id: 'p07', kind: 'paraphrase', q: 'The storefront is down and nobody can buy anything: what is the communication cadence?', relevant: [t('on-call-runbook.md', 2)] },
  { id: 'p08', kind: 'paraphrase', q: 'How are customer identities scrubbed before real records reach non-live systems?', relevant: [t('test-data.md', 1)] },
  { id: 'p09', kind: 'paraphrase', q: 'What latency targets does the purchase endpoint have?', relevant: [t('performance-testing.md', 1)] },
  { id: 'p10', kind: 'paraphrase', q: 'Is there an extended, all-day stability exercise before big launches?', relevant: [t('performance-testing.md', 3)] },
  { id: 'p11', kind: 'paraphrase', q: 'What colour difference is required between letters and what is behind them?', relevant: [t('accessibility.md', 2)] },
  { id: 'p12', kind: 'paraphrase', q: 'Can someone who cannot use a mouse still operate every control?', relevant: [t('accessibility.md', 3)] },
  { id: 'p13', kind: 'paraphrase', q: 'Which handsets and OS generations do we check on?', relevant: [t('mobile-qa.md', 1)] },
  { id: 'p14', kind: 'paraphrase', q: 'When must stolen credentials be invalidated?', relevant: [t('security-testing.md', 4)] },
  { id: 'p15', kind: 'paraphrase', q: 'How often do outside specialists attack our checkout to find weaknesses?', relevant: [t('security-testing.md', 1)] },
  { id: 'p16', kind: 'paraphrase', q: "How long does a reservation on a shopper's funds last before it lapses?", relevant: [t('payments-ops.md', 1)] },
  { id: 'p17', kind: 'paraphrase', q: 'A buyer contested a transaction with their issuer; how long do we have to respond?', relevant: [t('payments-ops.md', 3)] },
  { id: 'p18', kind: 'paraphrase', q: 'How fast must a showstopper bug be repaired?', relevant: [t('defect-triage.md', 3)] },
  { id: 'p19', kind: 'paraphrase', q: 'How many colleagues must OK an edit to the sign-in logic?', relevant: [t('code-review.md', 1)] },
  { id: 'p20', kind: 'paraphrase', q: 'Can helpdesk staff alter a transaction themselves?', relevant: [t('support-playbook.md', 1)] },

  /* ---------- Exact terms ---------- */
  { id: 'e01', kind: 'exact', q: 'What does return code R01 mean?', relevant: ['ach:docs/returns.md ¶4', 'ach:docs/returns.md ¶2'] },
  { id: 'e02', kind: 'exact', q: 'What is an NOC and how soon must the originator make the change?', relevant: ['ach:docs/changes.md ¶1', 'ach:docs/changes.md ¶3'] },
  { id: 'e03', kind: 'exact', q: 'What is the IAT addenda 718 record used for?', relevant: ['ach:docs/file-structure.md ¶98'] },
  { id: 'e04', kind: 'exact', q: 'Which port must be reachable for the istiod injection webhook?', relevant: ['microservices-demo:kustomize/components/service-mesh-istio/README.md ¶7'] },
  { id: 'e05', kind: 'exact', q: 'What is the dollar limit for an entry to qualify for same-day ACH?', relevant: ['ach:docs/calculating-effective-entry-date.md ¶2'] },
  { id: 'e06', kind: 'exact', q: 'How does Eureka service discovery work in Piggy Metrics?', relevant: ['piggymetrics:README.md ¶14', 'piggymetrics:README.md ¶15'] },
  { id: 'e07', kind: 'exact', q: 'What does the Zuul edge service do?', relevant: ['piggymetrics:README.md ¶12', 'piggymetrics:README.md ¶13'] },
  { id: 'e08', kind: 'exact', q: 'Where does the Moov ACH server report Prometheus metrics?', relevant: ['ach:docs/metrics.md ¶1'] },
  { id: 'e09', kind: 'exact', q: 'When is REFUND_EXCEEDS_CAPTURE returned?', relevant: [t('refund-policy.md', 3)] },
  { id: 'e10', kind: 'exact', q: 'What is the payments.failover flag for?', relevant: [t('on-call-runbook.md', 4)] },
  { id: 'e11', kind: 'exact', q: 'How long can a test stay quarantined?', relevant: [t('flaky-tests.md', 2)] },
  { id: 'e12', kind: 'exact', q: 'What WCAG level must customer-facing screens meet?', relevant: [t('accessibility.md', 1)] },
  { id: 'e13', kind: 'exact', q: 'Does Moov ACH persist files, batches or entry details?', relevant: ['ach:docs/server-config.md ¶3', 'ach:README.md ¶14'] },
  { id: 'e14', kind: 'exact', q: 'How do I turn on Chaos Monkey attacks and watchers for a service?', relevant: ['petclinic:scripts/chaos/README.md ¶1', 'petclinic:scripts/chaos/README.md ¶3'] },
  { id: 'e15', kind: 'exact', q: 'What is a DNE entry?', relevant: ['ach:docs/file-structure.md ¶43'] },
  { id: 'e16', kind: 'exact', q: 'What are traceId and spanId in Spring Cloud Sleuth?', relevant: ['piggymetrics:README.md ¶21'] },
  { id: 'e17', kind: 'exact', q: 'How do I run Online Boutique locally with skaffold?', relevant: ['microservices-demo:docs/development-guide.md ¶1'] },
  { id: 'e18', kind: 'exact', q: 'Where do k6 scripts for a new endpoint live?', relevant: [t('performance-testing.md', 4)] },

  /* ---------- Ordinary wording ---------- */
  { id: 'm01', kind: 'mixed', q: 'What is the refund window for partial refunds?', relevant: [t('refund-policy.md', 1)] },
  { id: 'm02', kind: 'mixed', q: 'On which days are production deployments allowed?', relevant: [t('release-process.md', 6)] },
  { id: 'm03', kind: 'mixed', q: 'How do I roll back a bad deployment?', relevant: [t('release-process.md', 4), t('on-call-runbook.md', 3)] },
  { id: 'm04', kind: 'mixed', q: 'Who executes the UAT cases for a story?', relevant: [t('uat-handbook.md', 1)] },
  { id: 'm05', kind: 'mixed', q: 'The checkout service crashloops after a deploy, what should I do?', relevant: [t('on-call-runbook.md', 3)] },
  { id: 'm06', kind: 'mixed', q: 'How do I add a new microservice to Online Boutique?', relevant: ['microservices-demo:docs/adding-new-microservice.md ¶1', 'microservices-demo:docs/development-guide.md ¶6'] },
  { id: 'm07', kind: 'mixed', q: 'When does the QA environment get reset?', relevant: [t('environments.md', 3)] },
  { id: 'm08', kind: 'mixed', q: 'What evidence is needed before a story can be signed off in UAT?', relevant: [t('uat-handbook.md', 2), t('uat-handbook.md', 3)] },
  { id: 'm09', kind: 'mixed', q: 'How do I undo an ACH file that was sent in error?', relevant: ['ach:docs/reversals.md ¶1'] },
  { id: 'm10', kind: 'mixed', q: 'What is the target fix time for an S2 defect?', relevant: [t('defect-triage.md', 3)] },

  /* ---------- No answer in the corpus ---------- */
  { id: 'n01', kind: 'none', q: 'What is the parental leave policy?', relevant: [] },
  { id: 'n02', kind: 'none', q: 'How do I configure Kafka consumer lag alerts?', relevant: [] },
  { id: 'n03', kind: 'none', q: 'Which GraphQL schema version does the mobile app use?', relevant: [] },
  { id: 'n04', kind: 'none', q: 'How many vacation days do new employees get?', relevant: [] },
  { id: 'n05', kind: 'none', q: 'What is the office Wi-Fi password?', relevant: [] },
  { id: 'n06', kind: 'none', q: 'Who won the football world cup in 2022?', relevant: [] },
  { id: 'n07', kind: 'none', q: 'How do I tune the JVM garbage collector for Kafka brokers?', relevant: [] },
  { id: 'n08', kind: 'none', q: 'What is the SLA for the data warehouse ETL load?', relevant: [] },
  { id: 'n09', kind: 'none', q: 'How do I request a new laptop?', relevant: [] },
  { id: 'n10', kind: 'none', q: 'What is a good recipe for sourdough bread?', relevant: [] },
  { id: 'n11', kind: 'none', q: 'Which Terraform module provisions the Snowflake account?', relevant: [] },
];
