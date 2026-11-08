/**
 * UAT analysis: pure functions with no React, shared by the browser and the server-side UAT
 * analyst agent. Coverage comes from Hexa (tests linked to each acceptance criterion and their
 * latest pipeline results); the server computes it and passes it in.
 */
import type { AssistantMessage, CriterionStatus, TestSuggestion, Ticket, UatArtifact } from './types';

export interface CriterionInput {
  status: CriterionStatus;
  evidence: string;
  /** The builds the evidence was read from, when the server supplied them. */
  builds?: { label: string; at: string }[];
  /** Automated tests that look like they cover the criterion, for a person to link. */
  suggestions?: TestSuggestion[];
}

/** "2 h ago", "3 d ago": how fresh the evidence is. */
export const ageOf = (iso: string) => {
  const m = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
};

export const summariseCoverage = (statuses: CriterionStatus[]): Ticket['uat'] => {
  const covered = statuses.filter((s) => s === 'passing').length;
  return { state: covered === statuses.length && statuses.length > 0 ? 'ready' : 'gaps', covered, total: statuses.length };
};

/** A proposed case's title: the criterion, cut at a word boundary when it is a whole sentence (R07). */
export const shortTitle = (text: string) => {
  const t = text.replace(/\s+/g, ' ').trim();
  if (t.length <= 90) return t;
  const cut = t.slice(0, 90);
  return `${cut.slice(0, Math.max(40, cut.lastIndexOf(' ')))}…`;
};

/** Lower-cases a leading capital only when it starts an ordinary word, never an acronym or a method name (PUT, API, HTTP). */
const lowerLead = (s: string) => (/^[A-Z][a-z]/.test(s) ? s.charAt(0).toLowerCase() + s.slice(1) : s);

const EXPECTS = /\b(returns?|answers?|responds?|shows?|displays?|lists?|contains?|rejects?|fails?|exits?|makes?|is shown|appears?|redirects?)\b/i;

/**
 * Steps derived from the criterion itself (R07): the situation it starts from, the call it names
 * when it names one, and the check it states. Never a sign-in step for a criterion about a container
 * or a batch job.
 */
export function stepsFor(criterion: string): string[] {
  const text = criterion.replace(/\s+/g, ' ').trim();
  const http = /\b(GET|POST|PUT|PATCH|DELETE|HEAD)\s+(\/[^\s,;]+)/.exec(text);
  const m = EXPECTS.exec(text);
  const given = (m ? text.slice(0, m.index) : '').replace(http?.[0] ?? '', '').replace(/\s+/g, ' ').replace(/[,:;]\s*$/, '').trim();
  const expected = m ? text.slice(m.index).trim() : text;
  const setup = given.length >= 12 ? `Set up: ${lowerLead(given)}` : 'Set up the situation the criterion describes (data, roles, configuration)';
  return http ? [setup, `Call ${http[1]} ${http[2]} as the criterion describes`, `Check: ${lowerLead(expected)}`] : [setup, `Check: ${lowerLead(expected)}`, 'Record the result and a screenshot'];
}

/** A story is a UAT candidate once Jira says it is ready for UAT (or further along); earlier states are flagged (R06). */
export const isUatCandidate = (status: string) => /\b(uat|done|release|accept)/i.test(status);

/** What the server knows about where evidence can come from. */
export interface UatContext {
  /** Components of the story whose repository is scanned through GitHub only, with no clone, no CI target and no recorded run (R24). */
  scanOnly?: { component: string; repo: string }[];
}

/** R24: one sentence saying that automated evidence cannot arrive for these components. */
export function scanOnlyCaveat(scanOnly: UatContext['scanOnly']): string {
  if (!scanOnly?.length) return '';
  const names = scanOnly.map((s) => `${s.component} (${s.repo})`);
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  const one = scanOnly.length === 1;
  return `${list} ${one ? 'is' : 'are'} scanned through GitHub only: no clone, no CI target and no recorded pipeline run, so no automated test result can arrive for ${one ? 'it' : 'them'} here and its criteria cannot count as covered by automation. Sign-off rests on manual UAT results unless that repository's CI pushes results to Catalyzt.`;
}

/** What a UAT analysis of a ticket produces, given what Hexa knows about each criterion. */
export function buildUatAnalysis(t: Ticket, coverage: CriterionInput[], ctx: UatContext = {}): { artifact: UatArtifact; covered: number; gaps: number; notRun: number; failing: number; suggested: number } {
  const caveat = scanOnlyCaveat(ctx.scanOnly);
  const criteria = t.acceptanceCriteria.map((text, i) => ({
    id: `AC${i + 1}`,
    text,
    status: coverage[i]?.status ?? 'no-test',
    evidence: coverage[i]?.evidence ?? 'No test linked to this criterion',
    ...(coverage[i]?.suggestions?.length ? { suggestions: coverage[i].suggestions } : {}),
  }));
  // A criterion with a passing CI test suggested for it needs a person to link that test, not a new manual case.
  const hasPassingSuggestion = (c: (typeof criteria)[number]) => !!c.suggestions?.some((s) => s.result === 'passed');
  const missing = criteria.filter((c) => c.status === 'no-test' && !hasPassingSuggestion(c));
  return {
    covered: criteria.filter((c) => c.status === 'passing').length,
    gaps: missing.length,
    suggested: criteria.filter((c) => c.status !== 'passing' && hasPassingSuggestion(c)).length,
    notRun: criteria.filter((c) => c.status === 'not-run').length,
    failing: criteria.filter((c) => c.status === 'failing').length,
    artifact: {
      id: `uat-${t.key.toLowerCase()}`,
      kind: 'uat',
      title: `UAT readiness · ${t.key}`,
      subtitle: `${t.summary}${t.fixVersion ? ` · ${t.fixVersion}` : ''} · ${criteria.length} acceptance criteria${isUatCandidate(t.status) ? '' : ` · ${t.status} in Jira, not a UAT candidate yet`}${caveat ? ' · scan-only repository, no automated evidence' : ''}`,
      cardLabel: 'UAT report',
      ticketKey: t.key,
      criteria,
      // The id carries the full story key and the criterion, so ABCD-1001 and IBGM-1001 never share
      // one, and the same gap gets the same id in every analysis.
      proposedCases: missing.map((c) => ({
        id: `UAT-${t.key}-${c.id}`,
        title: shortTitle(c.text),
        criterion: c.id,
        steps: stepsFor(c.text),
      })),
      note: `Acceptance criteria are read from ${t.key} in Jira. Coverage comes from the tests linked to each criterion in Hexa, read against the latest merge-commit run of each test's repository (named in the evidence)${t.requirements.length ? `; requirements: ${t.requirements.join(', ')}` : ''}. A criterion counts as covered only when a linked automated test passed in that run; an earlier pass, a skipped test or a test missing from the run does not count.${caveat ? ` ${caveat}` : ''}`,
    },
  };
}

const plural = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`;

const joinParts = (xs: string[]) => {
  const s = xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;
  return s.charAt(0).toUpperCase() + s.slice(1);
};

/** The UAT analyst's answer for a ticket: run summary, prose, report, approval for the gaps, follow-ups. */
export function uatAnswer(t: Ticket, coverage: CriterionInput[], ctx: UatContext = {}): { answer: AssistantMessage; artifact: UatArtifact } {
  const { artifact, covered, gaps, notRun, failing, suggested } = buildUatAnalysis(t, coverage, ctx);
  const caveat = scanOnlyCaveat(ctx.scanOnly);
  const n = artifact.criteria.length;
  const parts: string[] = [];
  if (covered) parts.push(`${plural(covered, 'is', 'are')} covered by tests that passed in the latest pipeline run [2]`);
  if (failing) parts.push(`${plural(failing, 'has a test that is', 'have tests that are')} failing`);
  if (notRun) parts.push(`${plural(notRun, 'has a test with', 'have tests with')} no result yet`);
  const untested = artifact.criteria.filter((c) => c.status === 'no-test').length;
  if (untested) parts.push(`${plural(untested, 'has', 'have')} no test`);
  const ready = n > 0 && covered === n;
  const candidate = isUatCandidate(t.status);
  const core = ready
    ? `All ${n} acceptance criteria of \`${t.key}\` [1] are covered by tests that passed in the latest pipeline run [2]. ${candidate ? 'It is ready for UAT sign-off.' : 'The evidence is in place for when it reaches UAT.'}`
    : `\`${t.key}\` has ${plural(n, 'acceptance criterion', 'acceptance criteria')} [1]. ${joinParts(parts)}. ${
        gaps ? `I drafted ${plural(gaps, 'UAT test case', 'UAT test cases')} for the gaps.` : failing ? 'Fix the failing tests before sign-off.' : suggested ? '' : 'Run the remaining tests before sign-off.'
      }${suggested ? `${gaps || failing ? ' ' : ''}For ${plural(suggested, 'criterion', 'criteria')} a CI test that passed looks like it covers ${suggested === 1 ? 'it' : 'them'}: review the suggestions in the report and link the right test to count it.` : ''}`.replace(/\. +$/, '.');
  // R06: a story that Jira still has in progress is not a UAT candidate, whatever the coverage says.
  const flagged = candidate ? core : `\`${t.key}\` is still ${t.status} in Jira [1], so it is not a UAT candidate yet. ${core}`;
  const summary = caveat ? `${flagged}\n\n${caveat}` : flagged;

  const builds = [...new Map(coverage.flatMap((c) => (c.builds ?? []).map((b) => [b.label, b] as const))).values()];
  const linked = artifact.criteria.filter((c) => c.status !== 'no-test').length;
  const answer: AssistantMessage = {
    id: crypto.randomUUID(),
    role: 'assistant',
    capability: 'analysis',
    revision: 1,
    rating: null,
    citations: [
      { n: 1, title: `${t.key} · ${t.summary}`, detail: `Jira · ${t.status} · synced from project ${t.key.split('-')[0]}` },
      {
        n: 2,
        title: 'Hexa: linked tests and their results in the target build',
        // R05: without a build there is nothing automated to read; say what the linked tests are instead of hinting at a missing pipeline.
        detail: builds.length
          ? `${builds.map((b) => `${b.label}, ${ageOf(b.at)}`).join('; ')} · ${linked} of ${n} criteria have linked tests`
          : `${linked} of ${n} criteria have linked tests · ${linked ? 'the linked tests are manual or have no recorded run, so there is no automated result to read' : 'no automated result to read'}`,
      },
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
                  { label: 'Application', value: t.applicationId ?? t.key.split('-')[0], mono: true },
                  { label: 'Ticket', value: t.key, mono: true },
                  { label: 'Test cases', value: artifact.proposedCases.map((c) => `${c.id} · ${c.title}`).join('\n'), mono: true },
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
