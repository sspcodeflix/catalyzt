/**
 * Test flows (docs/FLOWS.md): a UAT or regression effort over a set of stories, shared by the
 * application's team. A flow stores only what has no other home (its stories, sign-offs, tester
 * results and a timeline). Every step's state is derived from the records the rest of Catalyzt
 * already keeps: UAT reports, approvals of drafted cases, linked tests and their results in the
 * target build. So the flow cannot drift from Hexa, Jira or the approvals, and everyone sees the same.
 *
 * Steps per story:
 *   UAT:        Analyse → Review cases → Run tests → Sign off
 *   Regression: Analyse → Review cases → Automate → Verify in CI
 *
 * The agent does the Analyse step as a durable background job, so a flow over many stories keeps
 * going while nobody is logged in. Every other step waits on a named person, and the flow says who.
 */
import { randomUUID } from 'node:crypto';

import { answerBlocks, applyEvent, finishAnswer, initialAnswer } from '../src/lib/answerReducer';
import type { RunRequest, WorkflowEvent } from '../src/lib/workflow';
import type { Block } from '../src/lib/types';
import type { AppRecord, CriterionCoverage, HorizonDb, StoredStory } from './db';
import type { DeepSeekConfig } from './deepseek';
import { claim, complete, enqueue, fail, getJob } from './jobs';
import { runWorkflow } from './workflow';
import { STEPS, type FlowKind, type FlowStory, type FlowSummary, type FlowView, type ManualCase, type StoryStep } from '../src/lib/flowTypes';

export type { FlowView } from '../src/lib/flowTypes';

export const MAX_FLOW_STORIES = 100;
const JOB_KIND = 'flow.analyse';

export class FlowError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

type Row = Record<string, unknown>;
const now = () => new Date().toISOString();
const json = <T>(v: unknown, d: T): T => {
  try {
    return v ? (JSON.parse(String(v)) as T) : d;
  } catch {
    return d;
  }
};
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/* ---------- People ---------- */

function peopleWithRole(db: HorizonDb, app: string, role: string): { id: string; name: string }[] {
  return db.raw.prepare('SELECT u.id, u.name FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.application_id = ? AND m.role = ? ORDER BY u.name').all(app, role) as { id: string; name: string }[];
}
function managersOf(app: AppRecord, components: string[], db: HorizonDb) {
  const out = new Map<string, { id: string; name: string }>();
  for (const name of components) {
    const c = app.components.find((x) => x.name === name);
    if (c?.managerId) out.set(c.managerId, { id: c.managerId, name: c.managerName ?? c.managerId });
  }
  return out.size ? [...out.values()] : peopleWithRole(db, app.id, 'app_owner');
}
/**
 * Who can approve drafted cases for these components: a manager approves only changes to components they
 * manage (F19), so one manager for all of them decides, and a mix of managers leaves it to the app owner.
 */
function approversOf(app: AppRecord, components: string[], db: HorizonDb) {
  const m = managersOf(app, components, db);
  const unmanaged = components.some((name) => !app.components.find((c) => c.name === name)?.managerId);
  return m.length === 1 && !unmanaged ? m : peopleWithRole(db, app.id, 'app_owner');
}
const orOwners = (db: HorizonDb, app: string, list: { id: string; name: string }[]) => (list.length ? list : peopleWithRole(db, app, 'app_owner'));

/* ---------- Evidence per story ---------- */

/** A criterion counts as verified for UAT when an automated test passed in the target build, or a tester passed its manual case. */
function manualCases(db: HorizonDb, key: string): ManualCase[] {
  const rows = db.raw
    .prepare(
      `SELECT t.id, t.title, l.entity_ref AS ref FROM test_case_links l JOIN test_cases t ON t.id = l.test_case_id
       WHERE l.entity_type = 'criterion' AND l.entity_ref LIKE ? AND t.kind = 'manual' AND t.status = 'active' ORDER BY l.entity_ref, t.title`,
    )
    .all(`${key}#%`) as Row[];
  const last = db.raw.prepare('SELECT e.status, e.note, e.executed_at AS at, u.name AS by FROM manual_executions e JOIN users u ON u.id = e.executed_by WHERE e.test_case_id = ? ORDER BY e.executed_at DESC, e.rowid DESC LIMIT 1');
  return rows.map((r) => {
    const l = last.get(r.id) as Row | undefined;
    return {
      id: String(r.id),
      title: String(r.title),
      criterion: String(r.ref).split('#')[1] ?? '',
      last: l ? { status: String(l.status), by: String(l.by), at: String(l.at), note: (l.note as string) ?? null } : null,
    };
  });
}

interface Approval {
  id: string;
  status: string;
  createdAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
  chatId: string;
  components: string[];
  cases: { id: string; title: string; criterion: string; steps: string[] }[];
  note: string | null;
}
function latestCaseApproval(db: HorizonDb, key: string): Approval | null {
  const r = db.raw
    .prepare(
      `SELECT a.id, a.status, a.created_at, a.decided_at, a.payload, a.note, u.name AS decided_by, m.chat_id FROM approvals a
       JOIN answer_revisions ar ON ar.id = a.revision_id JOIN messages m ON m.id = ar.message_id LEFT JOIN users u ON u.id = a.decided_by
       WHERE a.action = 'add_uat_cases' AND a.status != 'expired' AND json_extract(a.target, '$.storyKey') = ? ORDER BY a.created_at DESC, a.rowid DESC LIMIT 1`,
    )
    .get(key) as Row | undefined;
  if (!r) return null;
  return {
    id: String(r.id),
    status: String(r.status),
    createdAt: String(r.created_at),
    decidedAt: (r.decided_at as string) ?? null,
    decidedBy: (r.decided_by as string) ?? null,
    chatId: String(r.chat_id),
    components: json<{ components?: string[] }>(r.payload, {}).components ?? [],
    cases: json<{ cases?: Approval['cases'] }>(r.payload, {}).cases ?? [],
    note: (r.note as string) ?? null,
  };
}

const automatedPassed = (c: CriterionCoverage) => c.tests.some((t) => t.kind === 'automated' && t.result === 'passed') && c.status !== 'failing';
const hasAutomated = (c: CriterionCoverage) => c.tests.some((t) => t.kind === 'automated' && t.result !== 'other_repo');

/** Where one story stands in a flow, derived from the records. */
function storyProgress(db: HorizonDb, app: AppRecord, flow: FlowRow, story: StoredStory, item: ItemRow, uat: ReturnType<HorizonDb['uatStates']>): FlowStory {
  const kind = flow.kind;
  const cov = db.suggestTests(story.key, db.coverageFor(story.key));
  const manual = manualCases(db, story.key);
  const manualPassed = (i: number) => manual.some((m) => m.criterion === `AC${i + 1}` && m.last?.status === 'passed');
  const manualFailed = (i: number) => manual.some((m) => m.criterion === `AC${i + 1}` && (m.last?.status === 'failed' || m.last?.status === 'blocked'));
  const verified = cov.map((c, i) => (kind === 'uat' ? automatedPassed(c) || (manualPassed(i) && c.status !== 'failing') : automatedPassed(c)));
  const managers = managersOf(app, story.components, db);
  const chatHref = (id: string | null | undefined) => (id ? `/chat/${id}` : `/tickets/${story.key}`);
  const report = uat.get(story.key);
  const job = getJob(db, jobKey(flow.id, story.key));
  const steps: StoryStep[] = [];

  // 1. Analyse: the UAT analyst's report for the story (in this flow's chat, or any newer one).
  const analysed = !!report && (report.analysedAt >= item.addedAt || report.chatId === item.chatId);
  if (job && (job.status === 'pending' || job.status === 'running') && !analysed) {
    steps.push({ key: 'analyse', state: 'working', detail: job.status === 'running' ? 'The UAT analyst is checking the story against its tests.' : 'Queued for the UAT analyst.', waitingOn: [] });
  } else if (!analysed && job?.status === 'failed') {
    steps.push({ key: 'analyse', state: 'blocked', detail: `The analysis failed: ${job.lastError ?? 'unknown error'}.`, waitingOn: [flow.owner], action: { kind: 'analyse', label: 'Analyse again' } });
  } else if (!analysed) {
    steps.push({ key: 'analyse', state: 'todo', detail: 'Not analysed in this flow yet.', waitingOn: [flow.owner], action: { kind: 'analyse', label: 'Analyse' } });
  } else {
    steps.push({ key: 'analyse', state: 'done', detail: `${report!.covered} of ${report!.total} criteria covered when analysed${report!.by ? ` (asked by ${report!.by})` : ''}.`, waitingOn: [], since: report!.analysedAt, action: { kind: 'open', label: 'Open report', href: chatHref(report!.chatId) } });
  }

  // 2. Review cases: the drafted manual cases need the component manager's approval; suggested CI tests need linking.
  const approval = latestCaseApproval(db, story.key);
  const toLink = cov.filter((c) => c.status !== 'passing' && c.suggestions?.some((s) => s.result === 'passed')).length;
  if (!analysed) steps.push({ key: 'review', state: 'todo', detail: 'Waits for the analysis.', waitingOn: [] });
  else if (approval?.status === 'pending') {
    const who = approversOf(app, approval.components.length ? approval.components : story.components, db);
    const n = new Set(approval.cases.map((c) => c.criterion)).size;
    steps.push({ key: 'review', state: 'waiting', detail: `${plural(approval.cases.length, 'drafted case', 'drafted cases')} for ${plural(n, 'requirement', 'requirements')} ${approval.cases.length === 1 ? 'waits' : 'wait'} for review.`, waitingOn: who, since: approval.createdAt, action: { kind: 'review', label: 'Review cases' } });
  } else if (approval?.status === 'declined') {
    steps.push({ key: 'review', state: 'blocked', detail: `${approval.decidedBy ?? 'A reviewer'} asked for changes${approval.note ? `: "${/[.!?]$/.test(approval.note) ? approval.note : `${approval.note}.`}"` : '.'} Analyse again to draft new cases.`, waitingOn: [flow.owner], since: approval.decidedAt ?? undefined, action: { kind: 'analyse', label: 'Analyse again' } });
  } else if (toLink) {
    steps.push({ key: 'review', state: 'waiting', detail: `${plural(toLink, 'criterion', 'criteria')} may already be covered by a passing CI test. Link the right test so it counts.`, waitingOn: approversOf(app, story.components, db), action: { kind: 'link', label: 'Review suggestions', href: chatHref(report?.chatId) } });
  } else if (approval?.status === 'approved') {
    steps.push({ key: 'review', state: 'done', detail: `Cases approved by ${approval.decidedBy ?? 'a manager'}.`, waitingOn: [], since: approval.decidedAt ?? undefined });
  } else {
    steps.push({ key: 'review', state: 'skipped', detail: 'No drafted cases to review.', waitingOn: [] });
  }
  const reviewed = steps[1].state === 'done' || steps[1].state === 'skipped';
  const failing = cov.map((c, i) => (c.status === 'failing' ? i : -1)).filter((i) => i >= 0);
  const fixPeople = managers;
  let signoff: FlowStory['signoff'] = null;

  if (kind === 'uat') {
    // 3. Run tests: every criterion verified by a passing automated test or a tester's pass.
    const open = verified.map((v, i) => (v ? -1 : i)).filter((i) => i >= 0);
    const needRun = open.filter((i) => !failing.includes(i) && manual.some((m) => m.criterion === `AC${i + 1}`) && !manualFailed(i));
    const noCase = open.filter((i) => !failing.includes(i) && !manual.some((m) => m.criterion === `AC${i + 1}`) && !hasAutomated(cov[i]));
    const manualFail = open.filter((i) => manualFailed(i));
    const testers = orOwners(db, app.id, peopleWithRole(db, app.id, 'uat_tester'));
    if (!reviewed) steps.push({ key: 'run', state: 'todo', detail: 'Waits for the case review.', waitingOn: [] });
    else if (open.length === 0) steps.push({ key: 'run', state: 'done', detail: `All ${plural(cov.length, 'criterion', 'criteria')} verified.`, waitingOn: [] });
    else if (failing.length || manualFail.length)
      steps.push({ key: 'run', state: 'blocked', detail: `${plural(failing.length + manualFail.length, 'criterion has', 'criteria have')} a failing test.`, waitingOn: fixPeople, action: { kind: 'fix', label: 'See failures', href: `/tickets/${story.key}` } });
    else if (needRun.length) steps.push({ key: 'run', state: 'waiting', detail: `${plural(needRun.length, 'criterion needs', 'criteria need')} a tester's result.`, waitingOn: testers, action: { kind: 'execute', label: 'Record results' } });
    else if (noCase.length) steps.push({ key: 'run', state: 'blocked', detail: `${plural(noCase.length, 'criterion has', 'criteria have')} no test. Analyse again to draft cases.`, waitingOn: [flow.owner], action: { kind: 'analyse', label: 'Analyse again' } });
    else steps.push({ key: 'run', state: 'waiting', detail: 'Automated tests have no result in the target build yet.', waitingOn: [], action: { kind: 'wait', label: 'Waiting for the pipeline' } });

    // 4. Sign off: the product owner (or app owner) signs with the evidence frozen; a later change marks it stale.
    const s = latestSignoff(db, flow.id, story.key);
    const ready = steps[2].state === 'done';
    const evidence = cov.map((c) => c.status);
    const stale = !!s && JSON.stringify(s.evidence) !== JSON.stringify(evidence) && !ready;
    const signers = orOwners(db, app.id, peopleWithRole(db, app.id, 'product_owner'));
    if (s && s.decision === 'signed_off' && !stale) steps.push({ key: 'signoff', state: 'done', detail: `Signed off by ${s.by}.`, waitingOn: [], since: s.at });
    else if (s && s.decision === 'rejected' && !ready) steps.push({ key: 'signoff', state: 'blocked', detail: `${s.by} did not sign off${s.note ? `: "${s.note}"` : ''}.`, waitingOn: fixPeople, since: s.at });
    else if (ready) steps.push({ key: 'signoff', state: 'waiting', detail: stale ? 'The evidence changed after sign-off. Sign off again.' : 'Every criterion is verified. Ready for UAT sign-off.', waitingOn: signers, action: { kind: 'signoff', label: 'Sign off' } });
    else steps.push({ key: 'signoff', state: 'todo', detail: 'Waits until every criterion is verified.', waitingOn: [] });
    signoff = s ? { decision: s.decision, by: s.by, at: s.at, note: s.note, stale } : null;
  } else {
    // 3. Automate: every criterion needs an automated test of the story's components.
    const missing = cov.map((c, i) => (hasAutomated(c) ? -1 : i)).filter((i) => i >= 0);
    const engineers = peopleWithRole(db, app.id, 'automation_engineer');
    const ask = `Write automated tests for ${story.key} covering ${missing.map((i) => `AC${i + 1}`).join(', ')}`;
    if (!reviewed) steps.push({ key: 'automate', state: 'todo', detail: 'Waits for the case review.', waitingOn: [] });
    else if (missing.length === 0) steps.push({ key: 'automate', state: 'done', detail: `Every criterion has an automated test.`, waitingOn: [] });
    else
      steps.push({
        key: 'automate',
        state: 'waiting',
        detail: `${plural(missing.length, 'criterion has', 'criteria have')} no automated test. Generate the test code, open a pull request, and link the merged test.`,
        waitingOn: engineers.length ? engineers : managers,
        action: { kind: 'automate', label: 'Draft automation', href: `/?ask=${encodeURIComponent(ask)}` },
      });
    // 4. Verify: each automated test passed in the target build.
    const notPassed = cov.map((_c, i) => (verified[i] ? -1 : i)).filter((i) => i >= 0);
    if (steps[2].state !== 'done') steps.push({ key: 'verify', state: 'todo', detail: 'Waits for automation.', waitingOn: [] });
    else if (notPassed.length === 0) steps.push({ key: 'verify', state: 'done', detail: 'Every criterion passed in CI.', waitingOn: [] });
    else if (failing.length) steps.push({ key: 'verify', state: 'blocked', detail: `${plural(failing.length, 'criterion has', 'criteria have')} a failing test in the target build.`, waitingOn: fixPeople, action: { kind: 'fix', label: 'See failures', href: `/tickets/${story.key}` } });
    else steps.push({ key: 'verify', state: 'waiting', detail: 'Waiting for a pipeline run with the new tests.', waitingOn: [], action: { kind: 'wait', label: 'Waiting for the pipeline' } });
  }

  const current = steps.find((s) => s.state !== 'done' && s.state !== 'skipped')?.key ?? null;
  return {
    key: story.key,
    summary: story.summary,
    status: story.status,
    components: story.components,
    criteria: story.acceptanceCriteria.map((text, i) => ({ id: `AC${i + 1}`, text, status: cov[i]?.status ?? 'no-test', verified: !!verified[i] })),
    steps,
    current,
    chatId: item.chatId ?? report?.chatId ?? null,
    manual,
    signoff,
    // The drafted cases for review, by requirement, from the approval waiting on (or last decided by) a reviewer.
    review: approval && (approval.status === 'pending' || approval.status === 'declined') ? { approvalId: approval.id, status: approval.status, cases: approval.cases, note: approval.note, decidedBy: approval.decidedBy, chatId: approval.chatId } : null,
  };
}

/* ---------- Storage ---------- */

interface FlowRow {
  id: string;
  app: string;
  kind: FlowKind;
  title: string;
  owner: { id: string; name: string };
  status: string;
  baseline: { covered?: number; criteria?: number };
  createdAt: string;
  finishedAt: string | null;
}
interface ItemRow {
  key: string;
  chatId: string | null;
  addedAt: string;
}
const toFlow = (r: Row): FlowRow => ({
  id: String(r.id),
  app: String(r.application_id),
  kind: r.kind as FlowKind,
  title: String(r.title),
  owner: { id: String(r.owner_id), name: String(r.owner_name ?? r.owner_id) },
  status: String(r.status),
  baseline: json(r.baseline, {}),
  createdAt: String(r.created_at),
  finishedAt: (r.finished_at as string) ?? null,
});
function getFlowRow(db: HorizonDb, id: string): FlowRow | null {
  const r = db.raw.prepare('SELECT f.*, u.name AS owner_name FROM flows f JOIN users u ON u.id = f.owner_id WHERE f.id = ?').get(id) as Row | undefined;
  return r ? toFlow(r) : null;
}
function itemsOf(db: HorizonDb, id: string): ItemRow[] {
  return (db.raw.prepare('SELECT story_key, chat_id, added_at FROM flow_items WHERE flow_id = ? AND removed_at IS NULL ORDER BY position').all(id) as Row[]).map((r) => ({ key: String(r.story_key), chatId: (r.chat_id as string) ?? null, addedAt: String(r.added_at) }));
}
function latestSignoff(db: HorizonDb, flowId: string, key: string) {
  const r = db.raw.prepare('SELECT s.decision, s.note, s.evidence, s.created_at, u.name AS by FROM flow_signoffs s JOIN users u ON u.id = s.decided_by WHERE s.flow_id = ? AND s.story_key = ? ORDER BY s.created_at DESC, s.rowid DESC LIMIT 1').get(flowId, key) as Row | undefined;
  return r ? { decision: String(r.decision), note: (r.note as string) ?? null, evidence: json<string[]>(r.evidence, []), at: String(r.created_at), by: String(r.by) } : null;
}
function event(db: HorizonDb, flowId: string, actor: string | null, kind: string, text: string, story: string | null = null) {
  db.raw.prepare('INSERT INTO flow_events (flow_id, at, actor_id, story_key, kind, text) VALUES (?, ?, ?, ?, ?, ?)').run(flowId, now(), actor, story, kind, text);
  db.raw.prepare('UPDATE flows SET updated_at = ? WHERE id = ?').run(now(), flowId);
}
const jobKey = (flowId: string, key: string) => `flow:${flowId}:${key}`;

/** Share of the criteria that count as covered for this kind of flow. */
function measure(db: HorizonDb, keys: string[], kind: FlowKind) {
  let criteria = 0;
  let covered = 0;
  for (const k of keys) {
    const cov = db.coverageFor(k);
    criteria += cov.length;
    covered += cov.filter((c) => (kind === 'uat' ? c.status === 'passing' : automatedPassed(c))).length;
  }
  return { criteria, covered };
}

/* ---------- Coverage across the application, for choosing regression gaps ---------- */

export function appCoverage(db: HorizonDb, app: AppRecord) {
  const stories = db.raw.prepare('SELECT key FROM stories WHERE application_id = ? ORDER BY key').all(app.id) as { key: string }[];
  const perComponent = new Map<string, { criteria: number; covered: number }>();
  const gaps: { key: string; summary: string; purpose: string | null; status: string; components: string[]; uncovered: string[]; criteria: number }[] = [];
  let criteria = 0;
  let covered = 0;
  for (const { key } of stories) {
    const s = db.getStory(key);
    if (!s) continue;
    const cov = db.coverageFor(key);
    const ok = cov.map(automatedPassed);
    criteria += cov.length;
    covered += ok.filter(Boolean).length;
    for (const c of s.components.length ? s.components : ['(no component)']) {
      const p = perComponent.get(c) ?? { criteria: 0, covered: 0 };
      p.criteria += cov.length;
      p.covered += ok.filter(Boolean).length;
      perComponent.set(c, p);
    }
    const uncovered = ok.map((v, i) => (v ? null : `AC${i + 1}`)).filter((x): x is string => !!x);
    if (uncovered.length) gaps.push({ key, summary: s.summary, purpose: s.purpose, status: s.status, components: s.components, uncovered, criteria: cov.length });
  }
  const components = app.components.map((c) => {
    const p = perComponent.get(c.name) ?? { criteria: 0, covered: 0 };
    const build = c.repo ? db.targetBuild(app.id, c.repo) : null;
    const tests = db.listTests(app.id, { component: c.name, kind: 'automated', limit: 1 }).total;
    return { name: c.name, repo: c.repo, manager: c.managerName, criteria: p.criteria, covered: p.covered, automatedTests: tests, lastBuild: build ? { label: build.label, at: build.at } : null };
  });
  const scans = db.listScans(app.id, 1);
  return { criteria, covered, stories: stories.length, components, gaps, lastScan: scans[0] ? { at: scans[0].startedAt ?? null, repo: scans[0].repo } : null };
}

/* ---------- The team thread ---------- */

/** The flow's team thread, created the first time it is needed: one chat, shared by the application's members. */
export function ensureThread(db: HorizonDb, flowId: string): string {
  const id = `thread-${flowId}`;
  const flow = getFlowRow(db, flowId);
  if (!flow) throw new FlowError(404, 'This flow does not exist.');
  const t = now();
  db.raw
    .prepare(
      `INSERT INTO chats (id, application_id, workspace_id, title, agent, test_type, created_by, created_at, updated_at, flow_id)
       VALUES (?, ?, (SELECT id FROM workspaces WHERE application_id = ? ORDER BY rowid LIMIT 1), ?, 'auto', ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`,
    )
    .run(id, flow.app, flow.app, `Team thread · ${flow.title}`.slice(0, 200), flow.kind, flow.owner.id, t, t, flowId);
  return id;
}

/* ---------- Views ---------- */

function summarise(flow: FlowRow, stories: FlowStory[], userId: string): FlowSummary {
  const steps = STEPS[flow.kind].map((s, i) => ({ key: s.key, label: s.label, done: stories.filter((x) => x.steps[i] && (x.steps[i].state === 'done' || x.steps[i].state === 'skipped')).length }));
  const firstOpen = steps.find((s) => s.done < stories.length);
  // Who is holding which stories, grouped by person and action, people waiting longest first.
  const groups = new Map<string, FlowSummary['waiting'][number]>();
  for (const st of stories) {
    const step = st.steps.find((s) => s.key === st.current);
    if (!step || step.state === 'todo') continue;
    const label = step.action?.label ?? STEPS[flow.kind].find((s) => s.key === step.key)!.label;
    const people = step.waitingOn.length ? step.waitingOn : [null];
    const pipelineOrAgent = step.state === 'working' ? 'The UAT analyst is working' : step.action?.kind === 'wait' ? 'Waiting for the pipeline' : label;
    for (const p of people) {
      const k = `${p?.id ?? '-'}|${pipelineOrAgent}`;
      const g = groups.get(k) ?? { person: p, action: pipelineOrAgent, stories: [], since: null, you: p?.id === userId };
      g.stories.push(st.key);
      if (step.since && (!g.since || step.since < g.since)) g.since = step.since;
      groups.set(k, g);
    }
  }
  const waiting = [...groups.values()].sort((a, b) => Number(b.you) - Number(a.you) || (a.since ?? '9').localeCompare(b.since ?? '9'));
  const criteria = stories.reduce((n, s) => n + s.criteria.length, 0);
  const nowCovered = stories.reduce((n, s) => n + s.criteria.filter((c) => c.verified).length, 0);
  const pct = (n: number) => (criteria ? Math.round((n / criteria) * 100) : 0);
  return {
    id: flow.id,
    kind: flow.kind,
    title: flow.title,
    status: flow.status,
    owner: flow.owner,
    createdAt: flow.createdAt,
    stories: stories.length,
    steps,
    current: flow.status === 'active' && firstOpen ? { key: firstOpen.key, label: firstOpen.label } : null,
    waiting: flow.status === 'active' ? waiting : [],
    coverage: { baseline: pct(flow.baseline.covered ?? 0), now: pct(nowCovered), target: criteria ? 100 : 0, criteria },
  };
}

function storiesOf(db: HorizonDb, app: AppRecord, flow: FlowRow) {
  const uat = db.uatStates(app.id);
  return itemsOf(db, flow.id).flatMap((item) => {
    const story = db.getStory(item.key);
    return story && story.applicationId === app.id ? [storyProgress(db, app, flow, story, item, uat)] : [];
  });
}

/** A finished flow is marked done once, the first time every story is through it. */
function settle(db: HorizonDb, flow: FlowRow, stories: FlowStory[]) {
  if (flow.status === 'active' && stories.length > 0 && stories.every((s) => s.current === null)) {
    db.raw.prepare("UPDATE flows SET status = 'done', finished_at = ?, updated_at = ? WHERE id = ? AND status = 'active'").run(now(), now(), flow.id);
    event(db, flow.id, null, 'done', `Every story is through the flow.`);
    flow.status = 'done';
  }
}

export function listFlows(db: HorizonDb, app: AppRecord, userId: string, opts: { all?: boolean } = {}): FlowSummary[] {
  const rows = db.raw
    .prepare(`SELECT f.*, u.name AS owner_name FROM flows f JOIN users u ON u.id = f.owner_id WHERE f.application_id = ? ${opts.all ? '' : "AND f.status IN ('active', 'paused')"} ORDER BY f.created_at DESC LIMIT 30`)
    .all(app.id) as Row[];
  return rows.map((r) => {
    const flow = toFlow(r);
    const stories = storiesOf(db, app, flow);
    settle(db, flow, stories);
    return summarise(flow, stories, userId);
  });
}

export function flowView(db: HorizonDb, app: AppRecord, id: string, userId: string, roles: string[]): FlowView {
  const flow = getFlowRow(db, id);
  if (!flow || flow.app !== app.id) throw new FlowError(404, 'This flow does not exist in this application.');
  const stories = storiesOf(db, app, flow);
  settle(db, flow, stories);
  const events = (db.raw.prepare('SELECT e.at, e.story_key, e.text, u.name AS who FROM flow_events e LEFT JOIN users u ON u.id = e.actor_id WHERE e.flow_id = ? ORDER BY e.at DESC, e.id DESC LIMIT 60').all(id) as Row[]).map((r) => ({
    at: String(r.at),
    who: (r.who as string) ?? null,
    story: (r.story_key as string) ?? null,
    text: String(r.text),
  }));
  return {
    ...summarise(flow, stories, userId),
    items: stories,
    events,
    canManage: flow.owner.id === userId || roles.includes('app_owner'),
    canSignOff: roles.includes('product_owner') || roles.includes('app_owner'),
    canExecute: roles.some((r) => ['uat_tester', 'app_owner', 'component_manager', 'product_owner'].includes(r)),
    threadId: ensureThread(db, id),
  };
}

/* ---------- Changes ---------- */

/** Stories already in an active or paused flow of this kind (other than `except`), with that flow: a story is in one flow of a kind at a time. */
export function storiesInFlows(db: HorizonDb, app: string, kind: FlowKind, except: string | null = null) {
  const rows = db.raw
    .prepare("SELECT i.story_key, f.id, f.title FROM flows f JOIN flow_items i ON i.flow_id = f.id WHERE f.application_id = ? AND f.kind = ? AND f.status IN ('active', 'paused') AND i.removed_at IS NULL AND f.id != ? ORDER BY f.created_at")
    .all(app, kind, except ?? '') as Row[];
  const taken = new Map<string, { flowId: string; title: string }>();
  for (const r of rows) if (!taken.has(String(r.story_key))) taken.set(String(r.story_key), { flowId: String(r.id), title: String(r.title) });
  return taken;
}

function refuseTaken(db: HorizonDb, app: string, kind: FlowKind, keys: string[], except: string | null = null) {
  const taken = storiesInFlows(db, app, kind, except);
  const clash = keys.filter((k) => taken.has(k));
  if (!clash.length) return;
  const where = [...new Set(clash.map((k) => taken.get(k)!.title))].map((t) => `"${t}"`).join(', ');
  throw new FlowError(409, `${clash.join(', ')} ${clash.length === 1 ? 'is' : 'are'} already in the ${kind === 'uat' ? 'UAT' : 'regression'} flow ${where}. A story is in one ${kind === 'uat' ? 'UAT' : 'regression'} flow at a time: continue it there, or remove it from that flow first.`);
}

export function createFlow(db: HorizonDb, app: AppRecord, user: { id: string; name: string }, roles: string[], input: { kind: FlowKind; title?: string; stories: string[]; origin?: string | null }) {
  if (!roles.includes('app_owner') && !roles.includes('component_manager')) throw new FlowError(403, 'Only an app owner or a component manager can start a test flow.');
  const keys = [...new Set(input.stories)].slice(0, MAX_FLOW_STORIES + 1);
  if (keys.length === 0) throw new FlowError(400, 'Choose at least one story.');
  if (keys.length > MAX_FLOW_STORIES) throw new FlowError(400, `A flow holds at most ${MAX_FLOW_STORIES} stories.`);
  const stories = keys.map((k) => db.getStory(k));
  const unknown = keys.filter((_k, i) => !stories[i] || stories[i]!.applicationId !== app.id);
  if (unknown.length) throw new FlowError(400, `Not stories of this application: ${unknown.join(', ')}.`);
  // A component manager starts flows over the stories of their own components; an owner over any.
  if (!roles.includes('app_owner')) {
    const mine = new Set(app.components.filter((c) => c.managerId === user.id).map((c) => c.name));
    const foreign = stories.filter((s) => !s!.components.some((c) => mine.has(c))).map((s) => s!.key);
    if (foreign.length) throw new FlowError(403, `${foreign.join(', ')} touch no component you manage; ask the app owner to include them.`);
  }
  // A Start card pressed twice (two tabs, a double click) gives the flow it already started.
  if (input.origin) {
    const made = db.raw.prepare('SELECT id FROM flows WHERE application_id = ? AND origin = ?').get(app.id, input.origin) as { id: string } | undefined;
    if (made) return made.id;
  }
  if (input.kind === 'regression') {
    const active = db.raw.prepare("SELECT title FROM flows WHERE application_id = ? AND kind = 'regression' AND status IN ('active', 'paused')").get(app.id) as { title: string } | undefined;
    if (active) throw new FlowError(409, `A regression flow is already running: "${active.title}". Add stories to it, or finish it first.`);
  }
  // Two flows over one story would split its review, results and sign-off between them.
  refuseTaken(db, app.id, input.kind, keys);
  const id = `flow-${randomUUID().slice(0, 8)}`;
  const t = now();
  const base = measure(db, keys, input.kind);
  const title = (input.title?.trim() || (input.kind === 'uat' ? `UAT · ${keys.length === 1 ? keys[0] : `${keys.length} stories`}` : `Regression · ${app.name}`)).slice(0, 120);
  db.raw.transaction(() => {
    db.raw.prepare('INSERT INTO flows (id, application_id, kind, title, owner_id, status, baseline, created_at, updated_at, origin) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, app.id, input.kind, title, user.id, 'active', JSON.stringify(base), t, t, input.origin ?? null);
    const ins = db.raw.prepare('INSERT INTO flow_items (flow_id, story_key, position, added_by, added_at) VALUES (?, ?, ?, ?, ?)');
    keys.forEach((k, i) => ins.run(id, k, i, user.id, t));
    event(db, id, user.id, 'start', `Started with ${plural(keys.length, 'story', 'stories')}: ${base.covered} of ${base.criteria} criteria covered.`);
    db.audit('user', user.id, 'flow.start', 'flow', id, { kind: input.kind, stories: keys });
  })();
  for (const k of keys) enqueueAnalysis(db, app.id, id, k, user.id);
  return id;
}

function enqueueAnalysis(db: HorizonDb, app: string, flowId: string, key: string, userId: string) {
  enqueue(db, { key: jobKey(flowId, key), kind: JOB_KIND, app, payload: { flowId, storyKey: key, userId }, maxAttempts: 3, rearm: true });
}

function requireFlow(db: HorizonDb, app: AppRecord, id: string) {
  const flow = getFlowRow(db, id);
  if (!flow || flow.app !== app.id) throw new FlowError(404, 'This flow does not exist in this application.');
  return flow;
}
const canManage = (flow: FlowRow, userId: string, roles: string[]) => flow.owner.id === userId || roles.includes('app_owner');

export function analyseAgain(db: HorizonDb, app: AppRecord, id: string, user: { id: string }, roles: string[], key: string) {
  const flow = requireFlow(db, app, id);
  if (flow.status !== 'active') throw new FlowError(409, `This flow is ${flow.status}.`);
  if (!roles.includes('app_owner') && !roles.includes('component_manager')) throw new FlowError(403, 'Only an app owner or a component manager can ask for an analysis.');
  if (!itemsOf(db, id).some((i) => i.key === key)) throw new FlowError(404, `${key} is not in this flow.`);
  enqueueAnalysis(db, app.id, id, key, flow.owner.id);
  event(db, id, user.id, 'analyse', `Asked for a new analysis of ${key}.`, key);
}

export function setStatus(db: HorizonDb, app: AppRecord, id: string, user: { id: string }, roles: string[], status: 'active' | 'paused' | 'cancelled') {
  const flow = requireFlow(db, app, id);
  if (!canManage(flow, user.id, roles)) throw new FlowError(403, 'Only the person who started this flow or an app owner can change it.');
  if (flow.status === 'done' || flow.status === 'cancelled') throw new FlowError(409, `This flow is already ${flow.status}.`);
  db.raw.prepare('UPDATE flows SET status = ?, finished_at = ?, updated_at = ? WHERE id = ?').run(status, status === 'cancelled' ? now() : null, now(), id);
  event(db, id, user.id, status, status === 'active' ? 'Resumed the flow.' : status === 'paused' ? 'Paused the flow.' : 'Cancelled the flow.');
}

export function changeStories(db: HorizonDb, app: AppRecord, id: string, user: { id: string }, roles: string[], add: string[], remove: string[]) {
  const flow = requireFlow(db, app, id);
  if (!canManage(flow, user.id, roles)) throw new FlowError(403, 'Only the person who started this flow or an app owner can change its stories.');
  if (flow.status === 'done' || flow.status === 'cancelled') throw new FlowError(409, `This flow is ${flow.status}.`);
  const current = itemsOf(db, id);
  const bad = add.filter((k) => db.getStory(k)?.applicationId !== app.id);
  if (bad.length) throw new FlowError(400, `Not stories of this application: ${bad.join(', ')}.`);
  const adding = add.filter((k) => !current.some((i) => i.key === k));
  refuseTaken(db, app.id, flow.kind, adding, id);
  if (current.length + adding.length - remove.length > MAX_FLOW_STORIES) throw new FlowError(400, `A flow holds at most ${MAX_FLOW_STORIES} stories.`);
  const t = now();
  db.raw.transaction(() => {
    for (const k of remove) db.raw.prepare('UPDATE flow_items SET removed_at = ? WHERE flow_id = ? AND story_key = ? AND removed_at IS NULL').run(t, id, k);
    const pos = (db.raw.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM flow_items WHERE flow_id = ?').get(id) as { p: number }).p;
    adding.forEach((k, i) =>
      db.raw.prepare('INSERT INTO flow_items (flow_id, story_key, position, added_by, added_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(flow_id, story_key) DO UPDATE SET removed_at = NULL, added_at = excluded.added_at').run(id, k, pos + i, user.id, t),
    );
    if (adding.length) event(db, id, user.id, 'add', `Added ${adding.join(', ')}.`);
    if (remove.length) event(db, id, user.id, 'remove', `Removed ${remove.join(', ')}.`);
  })();
  for (const k of adding) enqueueAnalysis(db, app.id, id, k, flow.owner.id);
}

export function signOff(db: HorizonDb, app: AppRecord, id: string, user: { id: string; name: string }, roles: string[], key: string, decision: 'signed_off' | 'rejected', note: string | null) {
  const flow = requireFlow(db, app, id);
  if (flow.kind !== 'uat') throw new FlowError(400, 'Only a UAT flow has a sign-off.');
  if (flow.status !== 'active') throw new FlowError(409, `This flow is ${flow.status}.`);
  if (!roles.includes('product_owner') && !roles.includes('app_owner')) throw new FlowError(403, 'Only a product owner or an app owner can sign off UAT.');
  const story = db.getStory(key);
  if (!story || !itemsOf(db, id).some((i) => i.key === key)) throw new FlowError(404, `${key} is not in this flow.`);
  const progress = storyProgress(db, app, flow, story, itemsOf(db, id).find((i) => i.key === key)!, db.uatStates(app.id));
  if (decision === 'signed_off' && progress.steps[2].state !== 'done') throw new FlowError(409, `${key} still has criteria that are not verified. Sign-off with a gap needs a risk acceptance in Huddle.`);
  if (decision === 'rejected' && !note?.trim()) throw new FlowError(400, 'Say why you are not signing off.');
  const evidence = db.coverageFor(key).map((c) => c.status);
  db.raw.prepare('INSERT INTO flow_signoffs (id, flow_id, story_key, decision, note, evidence, decided_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(randomUUID(), id, key, decision, note?.slice(0, 1000) ?? null, JSON.stringify(evidence), user.id, now());
  event(db, id, user.id, decision, decision === 'signed_off' ? `Signed off ${key} for UAT.` : `Did not sign off ${key}: ${note}`, key);
  db.audit('user', user.id, `flow.${decision}`, 'story', key, { flowId: id, evidence });
}

/** A tester's result for a manual case. Recorded against the case, so every flow and report sees it. */
export function recordExecution(db: HorizonDb, app: AppRecord, testId: string, user: { id: string; name: string }, roles: string[], status: 'passed' | 'failed' | 'blocked', note: string | null) {
  if (!roles.some((r) => ['uat_tester', 'app_owner', 'component_manager', 'product_owner'].includes(r))) throw new FlowError(403, 'Only a UAT tester, a product owner, a component manager or an app owner can record a result.');
  const t = db.raw.prepare("SELECT id, application_id, kind, title, created_by FROM test_cases WHERE id = ? AND status = 'active'").get(testId) as Row | undefined;
  if (!t || t.application_id !== app.id) throw new FlowError(404, 'This test does not exist in this application.');
  if (t.kind !== 'manual') throw new FlowError(400, 'Results are recorded for manual cases; automated tests get theirs from CI.');
  if ((status === 'failed' || status === 'blocked') && !note?.trim()) throw new FlowError(400, 'Say what went wrong, so the fix can start from it.');
  const id = randomUUID();
  db.raw.prepare('INSERT INTO manual_executions (id, test_case_id, status, note, executed_by, executed_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, testId, status, note?.slice(0, 2000) ?? null, user.id, now());
  db.audit('user', user.id, 'test.execute', 'test_case', testId, { status });
  // The flows holding a story this case covers get a line in their timeline.
  const refs = db.raw.prepare("SELECT entity_ref FROM test_case_links WHERE test_case_id = ? AND entity_type = 'criterion'").all(testId) as { entity_ref: string }[];
  const keys = [...new Set(refs.map((r) => r.entity_ref.split('#')[0]))];
  for (const k of keys) {
    const flows = db.raw.prepare("SELECT f.id FROM flows f JOIN flow_items i ON i.flow_id = f.id WHERE i.story_key = ? AND i.removed_at IS NULL AND f.status = 'active' AND f.application_id = ?").all(k, app.id) as { id: string }[];
    for (const f of flows) event(db, f.id, user.id, 'execute', `${status === 'passed' ? 'Passed' : status === 'failed' ? 'Failed' : 'Blocked'}: "${String(t.title)}"${note ? ` (${note.slice(0, 120)})` : ''}.`, k);
  }
  return { id };
}

/* ---------- The background analysis ---------- */

/**
 * Runs the UAT analyst for one story of a flow, headless: a new chat owned by the flow's owner holds
 * the report and its approval card, exactly as if they had asked "Is KEY ready for UAT?" in chat.
 */
export async function analyseStory(db: HorizonDb, cfg: DeepSeekConfig | null, flowId: string, key: string) {
  const flow = getFlowRow(db, flowId);
  if (!flow || flow.status !== 'active') return { skipped: true };
  const story = db.getStory(key);
  if (!story) return { skipped: true };
  const app = db.appsFor(flow.owner.id).find((a) => a.id === flow.app);
  if (!app) throw new Error(`${flow.owner.name} is no longer a member of ${flow.app}.`);
  // One chat per story of a flow, linked to the flow before anything runs: a retry asks again in the same
  // chat, and the chat is the flow's (never in anyone's Recents), even when the analysis fails.
  const chatId = `fa-${flowId}-${key}`.slice(0, 64);
  db.raw.prepare('UPDATE flow_items SET chat_id = ? WHERE flow_id = ? AND story_key = ?').run(chatId, flowId, key);
  const messageId = randomUUID();
  const answerId = randomUUID();
  const text = `Is ${key} ready for UAT?`;
  const req: RunRequest = {
    chatId,
    chatTitle: `${flow.kind === 'uat' ? 'UAT' : 'Regression'} · ${key} ${story.summary}`.slice(0, 80),
    messageId,
    answerId,
    attachmentIds: [],
    revision: 1,
    text,
    agent: 'analysis',
    scope: { appName: app.name, appId: app.id, workspace: app.workspaces[0] ?? '' },
    testType: 'uat',
    testTypeSource: 'user',
    tickets: [key],
    components: [],
    history: [],
    syncedTickets: [{ ...story, uat: { state: 'not-analysed', covered: 0, total: story.acceptanceCriteria.length } }],
    knownComponents: app.components.map((c) => c.name),
    attachments: [],
  };
  let answer = initialAnswer();
  const emit = (e: WorkflowEvent) => {
    answer = applyEvent(answer, e);
  };
  // The readiness check needs no model: routing by rules keeps a batch of stories cheap and predictable.
  void cfg;
  let workflowRunId: string | null = null;
  try {
    workflowRunId = (await runWorkflow(req, null, emit, new AbortController().signal, { db, userId: flow.owner.id, app: app.id })).workflowRunId;
    if (answer.status !== 'done') throw new Error('The UAT analyst did not finish.');
  } catch (e) {
    // The question is already in the chat: save the failure as its answer, so the chat is never left blank.
    const message = `The analysis failed: ${(e as Error).message}. The flow shows "Analyse again" for ${key}.`;
    if (db.getChat(chatId)) {
      const failed = { ...finishAnswer(answer, false, message), status: 'error' as const, text: message };
      db.saveAnswer({ app: app.id, chatId, answerId, userMessageId: messageId, workflowRunId, userId: flow.owner.id, status: failed.status, intent: failed.intent, blocks: answerBlocks(failed), citations: [], artifact: null });
    }
    throw e;
  }
  db.saveAnswer({ app: app.id, chatId, answerId, userMessageId: messageId, workflowRunId, userId: flow.owner.id, status: answer.status, intent: answer.intent, blocks: answerBlocks(answer), citations: answer.citations, artifact: answer.artifact ?? null });
  const report = db.uatStates(app.id).get(key);
  event(db, flowId, null, 'analysed', `UAT analyst checked ${key}: ${report ? `${report.covered} of ${report.total} criteria covered` : 'report saved'}.`, key);
  return { chatId };
}

/** Drains flow analysis jobs one at a time; `kick` after enqueueing, and once at start-up. */
export function flowWorker(getDb: () => HorizonDb, getConfig: () => DeepSeekConfig | null) {
  const owner = `flows-${process.pid}-${randomUUID().slice(0, 6)}`;
  let running = false;
  const drain = async () => {
    if (running) return;
    running = true;
    try {
      for (;;) {
        const db = getDb();
        const job = claim<{ flowId: string; storyKey: string }>(db, { kinds: [JOB_KIND], owner, leaseMs: 5 * 60_000 });
        if (!job) break;
        try {
          const r = await analyseStory(db, getConfig(), job.payload.flowId, job.payload.storyKey);
          complete(db, job.id, owner, r);
        } catch (e) {
          fail(db, job.id, owner, (e as Error).message.slice(0, 300), { baseMs: 5_000, capMs: 60_000 });
        }
      }
    } finally {
      running = false;
    }
  };
  const kick = () => void drain().catch((e) => console.error('[flows] worker:', (e as Error).message));
  // Retries after a failure come due later; a slow tick picks them up without anyone asking.
  const timer = setInterval(kick, 15_000);
  timer.unref?.();
  return { kick, stop: () => clearInterval(timer) };
}

/** The flow started from a chat answer's Start card, if any. */
export function flowByOrigin(db: HorizonDb, app: string, origin: string): string | null {
  return (db.raw.prepare('SELECT id FROM flows WHERE application_id = ? AND origin = ?').get(app, origin) as { id: string } | undefined)?.id ?? null;
}

/* ---------- Flows in chat ---------- */

const WAITING_Q = /\b(what(?:'s| is)?\s+(?:waiting|pending)\s+(?:on|for)\s+me|waiting on me|my (?:pending|open) (?:items|reviews|tasks|work)|what do i (?:need|have) to do)\b/i;
const STATUS_Q = /\b(where|status|progress|how far|stand(?:s|ing)?|blocked|stuck)\b[^?.!]{0,60}\b(uat|regression|test flows?|flows?)\b|\b(uat|regression|test flows?|flows?)\b[^?.!]{0,40}\b(status|progress|stand)\b/i;
const START_Q = /^\s*(?:please\s+|can you\s+|could you\s+)?(?:start|begin|kick ?off|launch|set up|create|open)\b[^.?!]{0,40}\b(uat|regression)\b/i;
const THREAD_Q = /\b(where|status|progress|how far|stand(?:s|ing)?|blocked|stuck|waiting|next|left|remaining|holding)\b/i;
const KEY_RE = /\b[A-Z][A-Z0-9]+-\d+\b/g;

export interface FlowAnswer {
  prose: string;
  blocks: Block[];
}

/**
 * A request about test flows, answered from the records by rules, without a model: start a flow (a
 * card listing the stories found, with Start), where a flow stands (its live card), or what waits on me.
 */
export function flowChatAnswer(db: HorizonDb, app: AppRecord, userId: string, roles: string[], text: string, tickets: string[], threadFlowId: string | null = null): FlowAnswer | null {
  const keys = [...new Set([...tickets, ...(text.match(KEY_RE) ?? [])])];
  const start = START_Q.exec(text);
  if (start) {
    const kind: FlowKind = /regression/i.test(start[1]) ? 'regression' : 'uat';
    const version = /\b(?:release|version|fix version)?\s*(\d+\.\d+(?:\.\d+)?)\b/i.exec(text)?.[1] ?? null;
    let stories: { key: string; summary: string; note?: string }[];
    let how: string;
    if (keys.length) {
      stories = keys.flatMap((k) => {
        const s = db.getStory(k);
        return s && s.applicationId === app.id ? [{ key: s.key, summary: s.summary }] : [];
      });
      how = 'the stories you named';
    } else if (kind === 'regression') {
      stories = appCoverage(db, app).gaps.map((g) => ({ key: g.key, summary: g.summary, note: `${g.uncovered.length} of ${g.criteria} uncovered` }));
      how = 'every story with a criterion that no passing automated test covers';
    } else {
      const all = db.listStories(app.id);
      const picked = all.filter((s) => (version ? s.fixVersion === version : /ready for uat/i.test(s.status)));
      stories = picked.map((s) => ({ key: s.key, summary: s.summary, note: s.status }));
      how = version ? `the stories with fix version ${version}` : 'the stories in Ready for UAT';
    }
    // Stories already in a flow of this kind are left out and named, with that flow's card.
    const taken = storiesInFlows(db, app.id, kind);
    const already = stories.filter((x) => taken.has(x.key));
    stories = stories.filter((x) => !taken.has(x.key)).slice(0, MAX_FLOW_STORIES);
    const inFlows = [...new Set(already.map((x) => taken.get(x.key)!.flowId))];
    const alreadyText = already.length
      ? ` ${already.map((x) => x.key).join(', ')} ${already.length === 1 ? 'is' : 'are'} already in ${[...new Set(already.map((x) => `"${taken.get(x.key)!.title}"`))].join(', ')}, so ${already.length === 1 ? 'it is' : 'they are'} left out.`
      : '';
    if (!stories.length && already.length)
      return { prose: `${already.map((x) => x.key).join(', ')} ${already.length === 1 ? 'is' : 'are'} already in a ${kind === 'uat' ? 'UAT' : 'regression'} flow. Here it is; nothing new was started.`, blocks: inFlows.slice(0, 3).map((flowId) => ({ kind: 'flow' as const, flowId })) };
    const title = kind === 'uat' ? (version ? `UAT · release ${version}` : `UAT · ${stories.length === 1 ? stories[0].key : `${stories.length} stories`}`) : `Regression · ${app.name}`;
    const allowed = roles.includes('app_owner') || roles.includes('component_manager');
    const prose = !stories.length
      ? `I found no stories for a ${kind === 'uat' ? 'UAT' : 'regression'} flow from ${how}. Name the stories, or check the Jira filter.`
      : `I found ${plural(stories.length, 'story', 'stories')} for a ${kind === 'uat' ? 'UAT' : 'regression'} flow: ${how}. Untick any you want to leave out, then press Start. Nothing starts until you do.${alreadyText}${allowed ? '' : ' Only an app owner or a component manager can start a flow.'}`;
    return { prose, blocks: stories.length ? [{ kind: 'flow_start', flowKind: kind, title, stories }] : [] };
  }
  const flows = listFlows(db, app, userId);
  if (WAITING_Q.test(text)) {
    const mine = flows.flatMap((f) => f.waiting.filter((w) => w.you).map((w) => ({ f, w })));
    const prose = !flows.length
      ? 'No test flow is running in this application, so nothing in a flow waits on you.'
      : mine.length
        ? `In the test flows, ${plural(mine.reduce((n, x) => n + x.w.stories.length, 0), 'story waits', 'stories wait')} on you: ${mine.map((x) => `${x.w.action.toLowerCase()} for ${x.w.stories.join(', ')} in "${x.f.title}"`).join('; ')}.`
        : `Nothing in the ${plural(flows.length, 'active test flow')} waits on you right now.`;
    return { prose, blocks: flows.length ? [{ kind: 'flows_waiting' }] : [] };
  }
  // In a flow's team thread, "where are we", "what is blocked", "what is left" are about that flow.
  const inThread = threadFlowId ? getFlowRow(db, threadFlowId) : null;
  if (inThread && inThread.app === app.id && THREAD_Q.test(text)) {
    const view = flowView(db, app, inThread.id, userId, roles);
    return { prose: describeFlow(view, keys, userId), blocks: [{ kind: 'flow', flowId: inThread.id }] };
  }
  if (STATUS_Q.test(text) && flows.length) {
    const byKey = keys.length ? flows.filter((f) => itemsOf(db, f.id).some((i) => keys.includes(i.key))) : [];
    const words = text.toLowerCase();
    const byTitle = flows.filter((f) => f.title.toLowerCase().split(/[^a-z0-9.]+/).some((w) => w.length > 2 && /\d/.test(w) && words.includes(w)));
    const byKind = flows.filter((f) => new RegExp(`\\b${f.kind}\\b`, 'i').test(text));
    // A story that is in no flow gets the usual readiness answer, not some other flow.
    if (keys.length && !byKey.length) return null;
    const chosen = byKey.length ? byKey : byTitle.length ? byTitle : byKind.length ? byKind : flows;
    const f = chosen[0];
    const view = flowView(db, app, f.id, userId, roles);
    const prose = [describeFlow(view, keys, userId), chosen.length > 1 ? `${plural(chosen.length - 1, 'other flow')} also matched; ask by name to see ${chosen.length > 2 ? 'them' : 'it'}.` : ''].filter(Boolean).join(' ');
    return { prose, blocks: [{ kind: 'flow', flowId: f.id }] };
  }
  if (STATUS_Q.test(text) && /\b(test flows?|flows?)\b/i.test(text)) return { prose: 'No test flow is running in this application. Ask me to start one, for example "start UAT for the Ready for UAT stories".', blocks: [] };
  return null;
}

/** Where a flow stands in one or two sentences, plus a line per named story, and what is blocked. */
function describeFlow(view: FlowView, keys: string[], userId: string): string {
  const label = (k: string) => STEPS[view.kind].find((s) => s.key === k)?.label ?? k;
  const who = (list: { id: string; name: string }[]) => list.map((p) => (p.id === userId ? 'you' : p.name)).join(' or ');
  const line = (s: FlowStory) => {
    const st = s.steps.find((x) => x.key === s.current);
    return st ? `${s.key} is at ${label(st.key)}: ${st.detail}${st.waitingOn.length ? ` It waits on ${who(st.waitingOn)}.` : ''}` : `${s.key} is through the flow.`;
  };
  const named = keys.map((k) => view.items.find((s) => s.key === k)).filter((s): s is FlowStory => !!s);
  const blocked = named.length ? [] : view.items.filter((s) => s.steps.some((x) => x.key === s.current && x.state === 'blocked'));
  const where = view.current ? `at ${view.current.label}: ${view.steps.map((s) => `${s.label} ${s.done} of ${view.stories}`).join(', ')}` : view.status === 'done' ? 'finished' : view.status;
  return [`"${view.title}" is ${where}.`, ...named.map(line), blocked.length ? `Blocked: ${blocked.map(line).join(' ')}` : ''].filter(Boolean).join(' ');
}

/** The flow as a source for an answer in its team thread: every story's step, who it waits on, and recent events. */
export function flowFacts(db: HorizonDb, app: AppRecord, flowId: string, userId: string, roles: string[]) {
  const view = flowView(db, app, flowId, userId, roles);
  const label = (k: string) => STEPS[view.kind].find((s) => s.key === k)?.label ?? k;
  const lines = view.items.map((s) => {
    const st = s.steps.find((x) => x.key === s.current);
    const crit = s.criteria.map((c) => `${c.id} ${c.verified ? 'verified' : c.status}`).join(', ');
    return `- ${s.key} "${s.summary}": ${st ? `${label(st.key)} (${st.state}): ${st.detail}${st.waitingOn.length ? ` Waits on ${st.waitingOn.map((p) => p.name).join(' or ')}.` : ''}` : 'through the flow.'} Criteria: ${crit}.`;
  });
  const events = view.events.slice(0, 12).map((e) => `- ${e.at.slice(0, 16).replace('T', ' ')} ${e.who ?? 'Catalyzt'}: ${e.text}`);
  return {
    title: `Test flow · ${view.title}`,
    text: `${describeFlow(view, [], userId)}\nStories:\n${lines.join('\n')}\nRecent events, newest first:\n${events.join('\n')}`,
    detail: `${view.kind === 'uat' ? 'UAT' : 'Regression'} flow · steps and timeline`,
    href: `/flows/${view.id}`,
  };
}

/* ---------- A story's flows ---------- */

/** The active flows that hold a story. */
export function flowsForStory(db: HorizonDb, app: string, key: string): string[] {
  return (
    db.raw.prepare("SELECT f.id FROM flows f JOIN flow_items i ON i.flow_id = f.id WHERE f.application_id = ? AND i.story_key = ? AND i.removed_at IS NULL AND f.status IN ('active', 'paused') ORDER BY f.created_at DESC").all(app, key) as { id: string }[]
  ).map((r) => r.id);
}

/** Something that happened to a story outside the flow (an analysis or an approval in chat), into each flow's timeline. */
export function noteStory(db: HorizonDb, app: string, key: string, actorId: string | null, kind: string, text: string) {
  for (const id of flowsForStory(db, app, key)) event(db, id, actorId, kind, text, key);
}
