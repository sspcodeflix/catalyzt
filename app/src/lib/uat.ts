/**
 * UAT analysis: pure functions with no React, shared by the browser and the server-side UAT
 * analyst agent. Coverage here is placeholder data; in production it comes from the test
 * results Horizon indexes (scan and run evidence), looked up through the ticket's requirements.
 */
import type { AssistantMessage, CriterionStatus, Ticket, UatArtifact } from './types';

/** Test evidence per acceptance criterion, by ticket. Placeholder data. */
export const COVERAGE: Record<string, CriterionStatus[]> = {
  'PAY-1482': ['passing', 'passing', 'not-run', 'no-test'],
  'PAY-1490': ['passing', 'passing', 'passing'],
  'PAY-1495': ['passing', 'not-run', 'no-test', 'no-test'],
  'PAY-1501': ['no-test', 'no-test'],
  'PAY-1503': ['not-run'],
  'PAY-1507': ['passing', 'no-test', 'no-test'],
  'PAY-1511': ['no-test', 'passing'],
};

export const summariseCoverage = (statuses: CriterionStatus[]): Ticket['uat'] => {
  const covered = statuses.filter((s) => s === 'passing').length;
  return { state: covered === statuses.length ? 'ready' : 'gaps', covered, total: statuses.length };
};

const statusEvidence: Record<CriterionStatus, string> = {
  passing: 'Automated test passed in the last regression run',
  'not-run': 'Test exists but has not run on this build',
  'no-test': 'No test found',
};

/** What a UAT analysis of a ticket produces. Deterministic for the placeholder data. */
export function buildUatAnalysis(t: Ticket): { artifact: UatArtifact; covered: number; gaps: number; notRun: number } {
  const statuses = COVERAGE[t.key] ?? t.acceptanceCriteria.map(() => 'no-test' as CriterionStatus);
  const criteria = t.acceptanceCriteria.map((text, i) => ({
    id: `AC${i + 1}`,
    text,
    status: statuses[i],
    evidence: statusEvidence[statuses[i]],
  }));
  const missing = criteria.filter((c) => c.status === 'no-test');
  return {
    covered: criteria.filter((c) => c.status === 'passing').length,
    gaps: missing.length,
    notRun: criteria.filter((c) => c.status === 'not-run').length,
    artifact: {
      id: `uat-${t.key.toLowerCase()}`,
      kind: 'uat',
      title: `UAT readiness · ${t.key}`,
      subtitle: `${t.summary} · ${t.fixVersion} · ${criteria.length} acceptance criteria`,
      cardLabel: 'UAT report',
      ticketKey: t.key,
      criteria,
      proposedCases: missing.map((c, i) => ({
        id: `UAT-${t.key.split('-')[1]}-${i + 1}`,
        title: c.text,
        criterion: c.id,
        steps: ['Sign in to the merchant portal on SIT-2 as a test merchant', `Check: ${c.text.toLowerCase()}`, 'Record the result and a screenshot'],
      })),
      note: `Acceptance criteria are read from ${t.key} in Jira. Tests are matched through the requirements it links to (${t.requirements.join(', ')}). Coverage counts only tests that passed on the current build.`,
    },
  };
}

export function uatAnswer(t: Ticket): { answer: AssistantMessage; artifact: UatArtifact } {
  const { artifact, covered, gaps, notRun } = buildUatAnalysis(t);
  const n = artifact.criteria.length;
  const plural = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`;
  const parts = [`${plural(covered, 'is', 'are')} covered by tests that passed on this build [2]`];
  if (notRun) parts.push(`${plural(notRun, 'has a test that has', 'have tests that have')} not run yet`);
  if (gaps) parts.push(`${plural(gaps, 'has', 'have')} no test`);
  const summary =
    gaps || notRun
      ? `\`${t.key}\` has ${n} acceptance criteria [1]. ${joinParts(parts)}. ${
          gaps ? `I drafted ${plural(gaps, 'UAT test case', 'UAT test cases')} for the gaps.` : 'Run the remaining tests before sign-off.'
        }`
      : `All ${n} acceptance criteria of \`${t.key}\` [1] are covered by tests that passed on this build [2]. It is ready for UAT sign-off.`;

  const answer: AssistantMessage = {
    id: crypto.randomUUID(),
    role: 'assistant',
    capability: 'analysis',
    revision: 1,
    rating: null,
    citations: [
      { n: 1, title: `${t.key} · ${t.summary}`, detail: `Jira · ${t.status} · synced from project ${t.key.split('-')[0]}` },
      { n: 2, title: 'Regression run #4821', detail: 'CI pipeline · last night · build 24.11-rc3' },
    ],
    blocks: [
      {
        kind: 'run',
        summary: `Analysed ${t.key} for UAT · 4 steps · 18 s`,
        steps: [
          { label: `Read ${t.key} from Jira`, detail: `${n} acceptance criteria`, noModel: true, seconds: 1 },
          { label: 'Matched criteria to requirements', detail: t.requirements.join(', '), seconds: 6 },
          { label: 'Found tests and their last results', detail: 'Regression run #4821', noModel: true, seconds: 3 },
          { label: 'Drafted UAT cases for the gaps', detail: gaps ? plural(gaps, 'case', 'cases') : 'none needed', seconds: 8 },
        ],
      },
      { kind: 'prose', text: summary },
      { kind: 'artifact', artifactId: artifact.id },
      ...(gaps
        ? [
            {
              kind: 'approval' as const,
              approval: {
                title: `Add ${plural(gaps, 'UAT test case', 'UAT test cases')} to ${t.key}?`,
                facts: [
                  { label: 'Ticket', value: t.key, mono: true },
                  { label: 'Test cases', value: artifact.proposedCases.map((c) => c.id).join(', '), mono: true },
                  { label: 'Where', value: 'Linked to the ticket in Jira, for the UAT tester' },
                  { label: 'Then', value: 'Nothing else changes. The tester runs them and records results.' },
                ],
                credentialNote: 'Uses your Jira access via the credential broker',
                actionLabel: 'Add test cases',
                action: 'add_uat_cases' as const,
                artifactId: artifact.id,
                status: 'pending' as const,
              },
            },
          ]
        : []),
      {
        kind: 'followups',
        items: gaps
          ? ['Write automation for the gaps', 'Run the tests that have not run on SIT-2']
          : ['Draft the UAT sign-off note', `What changed since ${t.key} was last analysed?`],
      },
    ],
  };
  return { answer, artifact };
}

const joinParts = (xs: string[]) => {
  const s = xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;
  return s.charAt(0).toUpperCase() + s.slice(1);
};
