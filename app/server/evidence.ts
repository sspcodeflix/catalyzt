/**
 * Hexa facts for a specialist's answer: what the inventory knows about the components, stories and
 * test classes a request names (or the application, when the question is about tests and names
 * nothing). Each fact becomes a numbered source the model may cite, with a place in Hexa to open,
 * so an answer about coverage rests on the inventory instead of saying it cannot see it.
 *
 * A component's tests are the ones that belong to it (linked, under its path, or in a package or
 * directory named after it), not only the ones whose title mentions it: CI-imported tests have no
 * path and live in suites such as com.piggymetrics.account.AccountControllerTest (R01, R03). When a
 * test class is named ("why did AccountControllerTest fail?"), its latest results and failure
 * messages are a source too (R02).
 */
import { HEXA_COMPONENT_FACTS } from '../src/lib/staleAnswer';
import type { ComponentRecord, HorizonDb } from './db';

export interface EvidenceSource {
  title: string;
  text: string;
  detail: string;
  href: string;
}

const TEST_TALK = /\b(tests?|coverage|covers?|covered|evidence|runs?|pipeline|fail(?:ed|ing|ures?)?|regression|uat|readiness|flaky|junit)\b/i;
/** A test class or suite named in the question: AccountControllerTest, CartServiceSpec, PaymentIT, checkout_test. */
const TEST_CLASS = /\b([A-Z][A-Za-z0-9]*(?:Test|Tests|Spec|Specs|IT)|[a-z][a-z0-9_]*_test)\b/g;
const MAX_LISTED = 10;
const MAX_MESSAGES = 3;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const oneLine = (s: string, max = 200) => {
  const t = s.replace(/&#10;|&#13;/g, ' ').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

type Row = ReturnType<HorizonDb['listTests']>['rows'][number];

/** The latest recorded failure message per failed test, grouped, most common first. */
function failureSummary(db: HorizonDb, rows: Row[]): string[] {
  const groups = new Map<string, number>();
  for (const r of rows.filter((x) => x.kind === 'automated' && x.lastResult === 'failed').slice(0, 40)) {
    const msg = db.getTest(r.id)?.history.find((h) => h.status === 'failed')?.message;
    const key = msg ? oneLine(msg, 160) : 'no message recorded';
    groups.set(key, (groups.get(key) ?? 0) + 1);
  }
  return [...groups.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_MESSAGES)
    .map(([msg, n]) => `${plural(n, 'test')}: "${msg}"`);
}

const describeRow = (r: Row) =>
  `- ${r.title}${r.suite ? ` [${r.suite}]` : ''} (${r.kind}${r.kind === 'automated' ? `, latest result ${r.lastResult ?? 'none'}${r.lastRunAt ? ` at ${r.lastRunAt}` : ''}` : ''}${
    r.links.some((l) => l.type === 'criterion') ? `, linked to ${r.links.filter((l) => l.type === 'criterion').map((l) => l.ref).join(', ')}` : ''
  })`;

/** Facts for up to three components, three stories and three named test classes, or one application-wide summary. */
export function hexaEvidence(db: HorizonDb, app: string, req: { components: string[]; tickets: string[]; text: string; known: ComponentRecord[] }): EvidenceSource[] {
  const out: EvidenceSource[] = [];
  for (const name of req.components.slice(0, 3)) {
    const comp = req.known.find((c) => c.name === name);
    const { rows, total } = db.listTests(app, { component: name, limit: 200 });
    const kinds = { automated: 0, manual: 0, proposed: 0 };
    const results = { passed: 0, failed: 0, skipped: 0, none: 0 };
    for (const r of rows) {
      kinds[r.kind]++;
      if (r.kind === 'automated') results[r.lastResult === 'passed' || r.lastResult === 'failed' || r.lastResult === 'skipped' ? r.lastResult : 'none']++;
    }
    const build = comp?.repo ? db.targetBuild(app, comp.repo) : null;
    const failures = results.failed ? failureSummary(db, rows) : [];
    const listed = rows.slice(0, MAX_LISTED).map(describeRow);
    const lines = [
      `Component ${name}${comp?.repo ? ` (repository ${comp.repo}${comp.path ? `, path ${comp.path}` : ''})` : ''}: ${plural(total, 'test')} in Hexa belong to it (linked to it, under its path, in a package or directory named after it, or naming it): ${kinds.automated} automated, ${kinds.manual} manual, ${kinds.proposed} proposed.`,
      kinds.automated ? `Latest result per automated test: ${results.passed} passed, ${results.failed} failed, ${results.skipped} skipped, ${results.none} never run.` : 'No automated tests are known for it.',
      failures.length ? `Recorded failure messages, latest run of each failed test: ${failures.join('; ')}.` : '',
      build ? `Target build for ${comp?.repo}: ${build.label}, recorded ${build.at}.` : comp?.repo ? `No pipeline run has been recorded for ${comp.repo}.` : '',
      listed.length ? `Tests (first ${listed.length} of ${total}):\n${listed.join('\n')}` : '',
    ].filter(Boolean);
    out.push({ title: `Hexa · ${name}`, text: lines.join('\n'), detail: `${name} · ${HEXA_COMPONENT_FACTS} · latest results`, href: `/hexa?tab=automated&component=${encodeURIComponent(name)}` });
  }
  for (const key of req.tickets.slice(0, 3)) {
    const story = db.getStory(key);
    if (!story || story.applicationId !== app) continue;
    const cov = db.coverageFor(key);
    const lines = cov.map((c, i) => `AC${i + 1} (${story.acceptanceCriteria[i]}): ${c.status} — ${c.evidence}${c.tests.length ? ` [${c.tests.map((t) => `${t.id} ${t.title} · ${t.kind} · ${t.result}`).join('; ')}]` : ''}`);
    // The steps of the manual tests already linked, so a request to write cases refines them rather than duplicating them.
    const manual = [...new Map(cov.flatMap((c) => c.tests.filter((t) => t.kind !== 'automated')).map((t) => [t.id, t])).values()].slice(0, 6);
    const stepLines = manual.flatMap((t) => {
      const steps = db.getTest(t.id)?.steps ?? [];
      return steps.length ? [`${t.id} "${t.title}" steps: ${steps.slice(0, 8).map((s, i) => `${i + 1}. ${s.description.replace(/\s+/g, ' ').slice(0, 160)}`).join(' ')}`] : [];
    });
    out.push({
      title: `Hexa · ${key}`,
      text: `${key} "${story.summary}" (${story.status}${story.fixVersion ? `, ${story.fixVersion}` : ''}), components ${story.components.join(', ') || 'none'}. Readiness per acceptance criterion, against the target build of each linked test's repository:\n${lines.join('\n')}${stepLines.length ? `\nExisting manual tests linked to this story:\n${stepLines.join('\n')}` : ''}`,
      detail: `${key} · readiness per criterion`,
      href: `/tickets/${key}`,
    });
  }
  // Test classes named in the question: what Hexa recorded for them, including why they failed.
  const named = [...new Set([...req.text.matchAll(TEST_CLASS)].map((m) => m[1]))].filter((n) => !req.components.includes(n)).slice(0, 3);
  for (const name of named) {
    const { rows, total } = db.listTests(app, { q: name, limit: 20 });
    if (total === 0) continue;
    const lines = rows.slice(0, MAX_LISTED).map((r) => {
      const t = db.getTest(r.id);
      const last = t?.history[0];
      const run = last ? `${last.workflow ?? last.source}${last.sha ? ` ${last.sha.slice(0, 7)}` : ''}${last.prNumber ? ` PR #${last.prNumber}` : ''}, ${last.at}` : null;
      return `- ${r.title}${r.suite ? ` [${r.suite}]` : ''}: ${r.kind}${r.kind === 'automated' ? `, latest result ${r.lastResult ?? 'none'}${run ? ` (${run})` : ''}` : ''}${last?.status === 'failed' && last.message ? `; failure: "${oneLine(last.message, 300)}"` : ''}`;
    });
    out.push({ title: `Hexa · ${name}`, text: `${plural(total, 'test')} in Hexa match "${name}"${total > rows.length ? ` (first ${rows.length} listed)` : ''}:\n${lines.join('\n')}`, detail: `${name} · recorded results`, href: `/hexa?tab=automated&q=${encodeURIComponent(name)}` });
  }
  if (out.length === 0 && TEST_TALK.test(req.text)) {
    const stats = db.testStats(app);
    const runs = db.listRuns(app, 3);
    const kinds = Object.fromEntries(stats.byKind.map((k) => [k.key, k.n]));
    const lines = [
      `${plural(stats.total, 'test')} in Hexa for this application: ${kinds.automated ?? 0} automated, ${kinds.manual ?? 0} manual, ${kinds.proposed ?? 0} proposed. ${plural(stats.storiesWithoutTests, 'story', 'stories')} in Jira have no linked test.`,
      stats.runs ? `${plural(stats.runs, 'pipeline run')} recorded. Latest: ${runs.map((r) => `${r.repo ?? 'upload'} ${r.status} (${r.passed}/${r.total} passed${r.prNumber ? `, PR #${r.prNumber}` : ''}${r.sha ? `, ${r.sha.slice(0, 7)}` : ''})`).join('; ')}.` : 'No pipeline run has been recorded yet.',
    ];
    out.push({ title: 'Hexa · this application', text: lines.join('\n'), detail: 'inventory and latest runs', href: '/hexa' });
  }
  return out;
}
