/**
 * Hexa facts for a specialist's answer: what the inventory knows about the components and stories a
 * request names (or the application, when the question is about tests and names nothing). Each fact
 * becomes a numbered source the model may cite, with a place in Hexa to open, so an answer about
 * coverage rests on the inventory instead of saying it cannot see it.
 */
import type { ComponentRecord, HorizonDb } from './db';

export interface EvidenceSource {
  title: string;
  text: string;
  detail: string;
  href: string;
}

const TEST_TALK = /\b(tests?|coverage|covers?|covered|evidence|runs?|pipeline|fail(?:ed|ing|ures?)?|regression|uat|readiness|flaky|junit)\b/i;
const MAX_LISTED = 10;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Facts for up to three components and three stories, or one application-wide summary. */
export function hexaEvidence(db: HorizonDb, app: string, req: { components: string[]; tickets: string[]; text: string; known: ComponentRecord[] }): EvidenceSource[] {
  const out: EvidenceSource[] = [];
  for (const name of req.components.slice(0, 3)) {
    const comp = req.known.find((c) => c.name === name);
    const { rows, total } = db.listTests(app, { q: name, limit: 200 });
    const kinds = { automated: 0, manual: 0, proposed: 0 };
    const results = { passed: 0, failed: 0, skipped: 0, none: 0 };
    for (const r of rows) {
      kinds[r.kind]++;
      if (r.kind === 'automated') results[r.lastResult === 'passed' || r.lastResult === 'failed' || r.lastResult === 'skipped' ? r.lastResult : 'none']++;
    }
    const build = comp?.repo ? db.targetBuild(app, comp.repo) : null;
    const listed = rows.slice(0, MAX_LISTED).map((r) => `- ${r.title} (${r.kind}${r.kind === 'automated' ? `, latest result ${r.lastResult ?? 'none'}` : ''}${r.links.some((l) => l.type === 'criterion') ? `, linked to ${r.links.filter((l) => l.type === 'criterion').map((l) => l.ref).join(', ')}` : ''})`);
    const lines = [
      `Component ${name}${comp?.repo ? ` (repository ${comp.repo})` : ''}: ${plural(total, 'test')} in Hexa whose title, path or links mention it: ${kinds.automated} automated, ${kinds.manual} manual, ${kinds.proposed} proposed.`,
      kinds.automated ? `Latest result per automated test: ${results.passed} passed, ${results.failed} failed, ${results.skipped} skipped, ${results.none} never run.` : 'No automated tests are known for it.',
      build ? `Target build for ${comp?.repo}: ${build.label}, recorded ${build.at}.` : comp?.repo ? `No pipeline run has been recorded for ${comp.repo}.` : '',
      listed.length ? `Tests (first ${listed.length}):\n${listed.join('\n')}` : '',
    ].filter(Boolean);
    out.push({ title: `Hexa · ${name}`, text: lines.join('\n'), detail: `${name} · tests and latest results`, href: `/hexa?tab=automated&q=${encodeURIComponent(name)}` });
  }
  for (const key of req.tickets.slice(0, 3)) {
    const story = db.getStory(key);
    if (!story || story.applicationId !== app) continue;
    const cov = db.coverageFor(key);
    const lines = cov.map((c, i) => `AC${i + 1} (${story.acceptanceCriteria[i]}): ${c.status} — ${c.evidence}${c.tests.length ? ` [${c.tests.map((t) => `${t.title} · ${t.kind} · ${t.result}`).join('; ')}]` : ''}`);
    out.push({
      title: `Hexa · ${key}`,
      text: `${key} "${story.summary}" (${story.status}${story.fixVersion ? `, ${story.fixVersion}` : ''}), components ${story.components.join(', ') || 'none'}. Readiness per acceptance criterion, against the target build of each linked test's repository:\n${lines.join('\n')}`,
      detail: `${key} · readiness per criterion`,
      href: `/tickets/${key}`,
    });
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
