/**
 * UAT analysis: pure functions with no React, shared by the browser and the server-side UAT
 * analyst agent. Coverage comes from Hexa (tests linked to each acceptance criterion and their
 * latest pipeline results); the server computes it and passes it in.
 */
import type { AssistantMessage, CriterionStatus, Ticket, UatArtifact } from './types';

export interface CriterionInput {
  status: CriterionStatus;
  evidence: string;
}

export const summariseCoverage = (statuses: CriterionStatus[]): Ticket['uat'] => {
  const covered = statuses.filter((s) => s === 'passing').length;
  return { state: covered === statuses.length && statuses.length > 0 ? 'ready' : 'gaps', covered, total: statuses.length };
};

/** What a UAT analysis of a ticket produces, given what Hexa knows about each criterion. */
export function buildUatAnalysis(t: Ticket, coverage: CriterionInput[]): { artifact: UatArtifact; covered: number; gaps: number; notRun: number; failing: number } {
  const criteria = t.acceptanceCriteria.map((text, i) => ({
    id: `AC${i + 1}`,
    text,
    status: coverage[i]?.status ?? 'no-test',
    evidence: coverage[i]?.evidence ?? 'No test linked to this criterion',
  }));
  const missing = criteria.filter((c) => c.status === 'no-test');
  return {
    covered: criteria.filter((c) => c.status === 'passing').length,
    gaps: missing.length,
    notRun: criteria.filter((c) => c.status === 'not-run').length,
    failing: criteria.filter((c) => c.status === 'failing').length,
    artifact: {
      id: `uat-${t.key.toLowerCase()}`,
      kind: 'uat',
      title: `UAT readiness · ${t.key}`,
      subtitle: `${t.summary}${t.fixVersion ? ` · ${t.fixVersion}` : ''} · ${criteria.length} acceptance criteria`,
      cardLabel: 'UAT report',
      ticketKey: t.key,
      criteria,
      proposedCases: missing.map((c, i) => ({
        id: `UAT-${t.key.split('-')[1]}-${i + 1}`,
        title: c.text,
        criterion: c.id,
        steps: ['Sign in to the test environment as a test user', `Check: ${c.text.charAt(0).toLowerCase()}${c.text.slice(1)}`, 'Record the result and a screenshot'],
      })),
      note: `Acceptance criteria are read from ${t.key} in Jira. Coverage comes from the tests linked to each criterion in Hexa and their latest pipeline results${t.requirements.length ? `; requirements: ${t.requirements.join(', ')}` : ''}. A criterion counts as covered only when a linked automated test passed in the latest run.`,
    },
  };
}

const plural = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`;

const joinParts = (xs: string[]) => {
  const s = xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;
  return s.charAt(0).toUpperCase() + s.slice(1);
};

/** The UAT analyst's answer for a ticket: run summary, prose, report, approval for the gaps, follow-ups. */
export function uatAnswer(t: Ticket, coverage: CriterionInput[]): { answer: AssistantMessage; artifact: UatArtifact } {
  const { artifact, covered, gaps, notRun, failing } = buildUatAnalysis(t, coverage);
  const n = artifact.criteria.length;
  const parts: string[] = [];
  if (covered) parts.push(`${plural(covered, 'is', 'are')} covered by tests that passed in the latest pipeline run [2]`);
  if (failing) parts.push(`${plural(failing, 'has a test that is', 'have tests that are')} failing`);
  if (notRun) parts.push(`${plural(notRun, 'has a test with', 'have tests with')} no result yet`);
  if (gaps) parts.push(`${plural(gaps, 'has', 'have')} no test`);
  const ready = n > 0 && covered === n;
  const summary = ready
    ? `All ${n} acceptance criteria of \`${t.key}\` [1] are covered by tests that passed in the latest pipeline run [2]. It is ready for UAT sign-off.`
    : `\`${t.key}\` has ${plural(n, 'acceptance criterion', 'acceptance criteria')} [1]. ${joinParts(parts)}. ${
        gaps ? `I drafted ${plural(gaps, 'UAT test case', 'UAT test cases')} for the gaps.` : failing ? 'Fix the failing tests before sign-off.' : 'Run the remaining tests before sign-off.'
      }`;

  const answer: AssistantMessage = {
    id: crypto.randomUUID(),
    role: 'assistant',
    capability: 'analysis',
    revision: 1,
    rating: null,
    citations: [
      { n: 1, title: `${t.key} · ${t.summary}`, detail: `Jira · ${t.status} · synced from project ${t.key.split('-')[0]}` },
      { n: 2, title: 'Hexa: linked tests and latest pipeline results', detail: `${artifact.criteria.filter((c) => c.status !== 'no-test').length} of ${n} criteria have linked tests` },
    ],
    blocks: [
      {
        kind: 'run',
        summary: `Analysed ${t.key} for UAT · 4 steps`,
        steps: [
          { label: `Read ${t.key} from Jira`, detail: `${n} acceptance criteria`, noModel: true, seconds: 0.1 },
          { label: 'Found the tests linked to each criterion in Hexa', detail: t.requirements.length ? `Requirements ${t.requirements.join(', ')}` : 'By criterion links', noModel: true, seconds: 0.1 },
          { label: 'Read their latest pipeline results', detail: `${covered} passing · ${failing} failing · ${notRun} no result · ${gaps} no test`, noModel: true, seconds: 0.1 },
          { label: 'Drafted UAT cases for the gaps', detail: gaps ? plural(gaps, 'case', 'cases') : 'none needed', noModel: true, seconds: 0.1 },
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
                  { label: 'Where', value: 'Hexa, as manual tests linked to the story and criteria, for the UAT tester' },
                  { label: 'Then', value: 'Nothing else changes. The tester runs them and records results.' },
                ],
                credentialNote: 'Writes to Hexa only; Jira is not changed',
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
          ? ['Write automation for the gaps', 'Which tests cover this story?']
          : failing
            ? ['Why are the linked tests failing?', 'Show the latest pipeline run']
            : ['Draft the UAT sign-off note', `What changed since ${t.key} was last analysed?`],
      },
    ],
  };
  return { answer, artifact };
}
