/**
 * Orchestrator: runs one request through the agent workflow. Every agent it spawns, and every
 * step an agent takes, is streamed to the browser as it happens and recorded in the database
 * (workflow_runs, agent_runs, agent_steps), so anyone can see which agent is working on what.
 *
 *   Orchestrator
 *   ├─ Input guard   rules only; rejects policy breaks before any model is called
 *   ├─ Router        the model classifies intent and is a second guard; rules if no model
 *   ├─ one of        Clarifier | UAT analyst (tools) | a capability specialist (model, streamed)
 *   └─ Output guard  masks secrets in the answer
 *
 * Nothing here changes anything outside Catalyzt; changes are proposed as approval cards.
 */
import { randomUUID } from 'node:crypto';

import { checkInput, containsSecret, policyFromModel, redactSecrets, streamSafeLength, type Policy } from '../src/lib/guardrails';
import { validateIntent, type Intent, type IntentRequest } from '../src/lib/intent';
import { rulesIntent } from '../src/lib/routing';
import { testTypeLabel } from '../src/lib/testType';
import type { Capability, Citation } from '../src/lib/types';
import { uatAnswer } from '../src/lib/uat';
import type { AgentKind, AgentName, AgentState, RunRequest, WorkflowEvent } from '../src/lib/workflow';
import { describeRetrieval, retrieveContext, scanOnlyComponents, type ContextPassage } from './context';
import type { RetrievalModels } from './retrieval';
import type { HorizonDb } from './db';
import { hexaEvidence } from './evidence';
import { flowChatAnswer, flowFacts, noteStory } from './flows';
import { completeJson, DeepSeekError, streamChat, type DeepSeekConfig, type Usage } from './deepseek';
import { chatMessages, intentMessages } from './prompts';

type Emit = (e: WorkflowEvent) => void;

export const SPECIALIST: Record<Capability, AgentName> = {
  analysis: 'Analysis agent',
  authoring: 'Authoring agent',
  execution: 'Execution agent',
  cloudops: 'CloudOps agent',
  security: 'Security agent',
};

const CAP_LABEL: Record<Capability, string> = {
  analysis: 'Test analysis',
  authoring: 'Test authoring',
  execution: 'Execution',
  cloudops: 'CloudOps',
  security: 'Security',
};

/** "Write the proposed UAT cases", "draft test steps for AC2", "generate automation": authoring, whatever the chat started as. */
export const AUTHORING_REQUEST = /\b(write|draft|generate|create|author|prepare|propose|produce|add)\b[^.?!]{0,40}?\b(test ?cases?|tests?|uat cases?|cases|scenarios?|test steps|steps|scripts?|automation|gherkin|feature files?)\b/i;
const READINESS_WORDS = /\b(ready|readiness|sign[- ]?off|uat (status|check|analysis|report)|analy[sz]e|re-?analy[sz]e|check (again|it)|coverage|covered|status)\b/i;
const KEY = /\b[A-Z][A-Z0-9]+-\d+\b/g;

/**
 * Whether a request asks for the readiness report itself: it uses readiness words, or it is little more
 * than the story key ("ABCD-1004", "check ABCD-1004"). Anything else about the story is a question for
 * the Analysis agent.
 */
export function isReadinessRequest(text: string, tickets: string[]): boolean {
  if (READINESS_WORDS.test(text)) return true;
  const rest = text.replace(KEY, ' ').replace(/[^A-Za-z]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  return (tickets.length > 0 || KEY.test(text)) && rest.length <= 3;
}

function describe(i: Intent) {
  return [CAP_LABEL[i.capability], i.testType && testTypeLabel(i.testType), ...i.tickets, ...i.components].filter(Boolean).join(' · ');
}

const secs = (t0: number) => Math.round((performance.now() - t0) / 100) / 10;

export interface WorkflowOptions {
  db?: HorizonDb;
  userId: string;
  /** The application the request is scoped to. */
  app: string;
  /** Embedding and reranking models for App Context retrieval; none means keyword-only. */
  models?: RetrievalModels;
}

class Recorder {
  readonly workflowRunId = randomUUID();
  /** Tokens used by every model call in this run. */
  tokens = 0;
  constructor(
    readonly emit: Emit,
    readonly db: HorizonDb | undefined,
    readonly userId: string,
  ) {}

  /** Writes one model call to the token ledger and adds it to the run's total. */
  modelCall(agent: AgentHandle, c: { model: string; purpose: 'intent' | 'answer'; status: 'ok' | 'error' | 'stopped'; usage: Usage | null; t0: number }) {
    if (c.usage) this.tokens += c.usage.promptTokens + c.usage.completionTokens;
    this.db?.recordModelCall({
      workflowRunId: this.workflowRunId,
      agentRunId: agent.id,
      agent: agent.agent,
      userId: this.userId,
      model: c.model,
      purpose: c.purpose,
      status: c.status,
      promptTokens: c.usage?.promptTokens ?? null,
      completionTokens: c.usage?.completionTokens ?? null,
      latencyMs: performance.now() - c.t0,
    });
  }
}

/** An agent in a run: emits its lifecycle and steps, and records them when a database is given. */
class AgentHandle {
  private readonly t0 = performance.now();
  private finished = false;

  constructor(
    private readonly run: Recorder,
    readonly id: string,
    readonly parentId: string | null,
    readonly agent: AgentName | 'Orchestrator',
    readonly kind: AgentKind,
    readonly task: string,
    private model: string | undefined,
  ) {
    run.emit({ type: 'agent', id, parentId, agent, kind, task, state: 'running', model, seconds: 0 });
    run.db?.startAgent({ id, workflowRunId: run.workflowRunId, parentId, agent, kind, task, model: model ?? null });
  }

  /** Spawns a child agent with a task. */
  spawn(agent: AgentName, kind: AgentKind, task: string, model?: string) {
    return new AgentHandle(this.run, randomUUID(), this.id, agent, kind, task, model);
  }

  /** Starts a step; call the returned function to finish it. */
  step(kind: 'rule' | 'model' | 'tool', label: string, tool?: string) {
    const id = randomUUID();
    const t0 = performance.now();
    this.run.emit({ type: 'step', id, agentId: this.id, kind, label, state: 'running', seconds: 0 });
    this.run.db?.addStep({ id, agentRunId: this.id, kind, tool, label });
    return (f: { label?: string; detail?: string; failed?: boolean } = {}) => {
      const state = f.failed ? 'failed' : 'done';
      this.run.emit({ type: 'step', id, agentId: this.id, kind, label: f.label ?? label, detail: f.detail, state, seconds: secs(t0) });
      this.run.db?.finishStep(id, { status: state, label: f.label, detail: f.detail });
    };
  }

  finish(state: Exclude<AgentState, 'running'>, f: { result?: string; error?: string; model?: string; promptTokens?: number; completionTokens?: number } = {}) {
    if (this.finished) return;
    this.finished = true;
    if (f.model) this.model = f.model;
    this.run.emit({
      type: 'agent',
      id: this.id,
      parentId: this.parentId,
      agent: this.agent,
      kind: this.kind,
      task: this.task,
      state,
      model: this.model,
      result: f.result ?? f.error,
      tokens: f.promptTokens !== undefined || f.completionTokens !== undefined ? (f.promptTokens ?? 0) + (f.completionTokens ?? 0) : undefined,
      seconds: secs(this.t0),
    });
    this.run.db?.finishAgent(this.id, { status: state, ...f });
  }
}

/** Rejections are logged without the message text, which may contain the secret that tripped the guard. */
function audit(by: string, policy: Policy, match?: string) {
  const shown = policy.id === 'secret-in-input' ? '[redacted]' : match;
  console.warn(`[horizon guard] rejected by ${by}: ${policy.id}${shown ? ` (matched "${shown}")` : ''}`);
}

export async function runWorkflow(
  req: RunRequest,
  cfg: DeepSeekConfig | null,
  emit: Emit,
  signal: AbortSignal,
  opts: WorkflowOptions,
): Promise<{ workflowRunId: string }> {
  const { db, userId, app } = opts;
  const knownComponents = req.knownComponents ?? [];
  const started = performance.now();
  const total = () => `${secs(started)} s`;

  // The input guard runs before anything is kept. A message that carries a secret is stored without
  // its text and never gives the chat its title, so no secret reaches the database or a model.
  const g = checkInput(req.text);
  const secret = containsSecret(req.text) || (!g.allowed && g.policy.id === 'secret-in-input');
  if (db && req.chatId && req.messageId) {
    const wanted = (req.chatTitle ?? req.text).slice(0, 80);
    const title = secret || containsSecret(wanted) ? 'Removed: it contained a secret' : redactSecrets(wanted);
    db.upsertChat({ id: req.chatId, title, agent: req.agent, workspace: req.scope.workspace, userId }, app);
    db.addUserMessage({
      id: req.messageId,
      chatId: req.chatId,
      text: req.text,
      testType: req.testType,
      testTypeSource: req.testTypeSource,
      userId,
      items: [...req.tickets.map((t) => ({ type: 'story', ref: t })), ...req.components.map((c) => ({ type: 'component', ref: c })), ...(req.attachments ?? []).map((a) => ({ type: 'file', ref: a.id }))],
      removedReason: secret ? 'secret-in-input' : null,
    });
    // Files used here belong to this chat from now on.
    for (const a of req.attachments ?? []) db.bindAttachment(a.id, req.chatId);
  }
  const attachments = req.attachments ?? [];

  const rec = new Recorder(emit, db, userId);
  db?.startWorkflow({ id: rec.workflowRunId, app, chatId: req.chatId ?? null, messageId: req.messageId ?? null, revision: req.revision ?? 1, userId });
  const short = req.text.length > 80 ? `${req.text.slice(0, 77)}…` : req.text;
  // A message with a secret is never written into a task.
  const root = new AgentHandle(rec, randomUUID(), null, 'Orchestrator', 'orchestrator', 'Handle the request', undefined);

  const result = { workflowRunId: rec.workflowRunId };
  const end = (state: 'done' | 'rejected', summary: string) => {
    root.finish(state, { result: summary });
    db?.finishWorkflow(rec.workflowRunId, state, summary);
    emit({ type: 'done', summary, tokens: rec.tokens });
    return result;
  };

  try {
    // 1. Input guard: rules, no model, before anything else.
    const guard = root.spawn('Input guard', 'guard', 'Check the request against the policies');
    const check = guard.step('rule', 'Checking the request against the policies');
    if (!g.allowed) {
      check({ label: `Rejected: ${g.policy.title}`, failed: true });
      guard.finish('rejected', { result: `Rejected: ${g.policy.title}` });
      audit('input guard', g.policy, g.match);
      if (g.policy.id === 'secret-in-input' && req.messageId) db?.removeMessageText(req.messageId, 'secret-in-input');
      db?.guardEvent({ workflowRunId: rec.workflowRunId, agentRunId: guard.id, layer: 'input', policy: g.policy.id, userId });
      emit({ type: 'rejected', policy: g.policy, by: 'Input guard' });
      return end('rejected', `Rejected by the input guard · ${total()}`);
    }
    check({ label: 'Request passed the policy checks' });
    guard.finish('done', { result: 'Passed' });

    // History comes from the browser, so it is untrusted: drop earlier user turns that break a policy and
    // any turn, whoever wrote it, that holds what looks like a secret (F05).
    req = { ...req, history: req.history.filter((h) => (h.role === 'user' ? checkInput(h.text).allowed : !containsSecret(h.text))) };

    // Test flows (docs/FLOWS.md): start one, where one stands, what waits on me. Answered from the
    // records by rules; the cards in the answer load the flow live, so an old chat never shows stale progress.
    const member = db ? db.appsFor(userId).find((a) => a.id === app) : undefined;
    const threadFlowId = db && req.chatId ? db.getChat(req.chatId)?.flowId ?? null : null;
    const flowAnswer = db && member ? flowChatAnswer(db, member, userId, member.roles, req.text, req.tickets, threadFlowId) : null;
    if (flowAnswer) {
      const coord = root.spawn('Test flows', 'tool_agent', 'Answer from the test flows');
      const s = coord.step('tool', 'Reading the test flows', 'flows.read');
      s({ detail: flowAnswer.blocks.some((b) => b.kind === 'flow_start') ? 'Found the stories for a new flow' : 'Read the flows from the records' });
      coord.finish('done', { result: 'Answered from the test flows' });
      emit({ type: 'answer', blocks: [{ kind: 'prose', text: flowAnswer.prose }, ...flowAnswer.blocks], citations: [] });
      return end('done', `Test flows · ${total()}`);
    }

    // A request to write test cases is authoring, even in a chat that started as a UAT analysis (whose
    // capability stays "Test analysis"): the words of this message decide, not the chat's first request.
    const wantsAuthoring = AUTHORING_REQUEST.test(req.text);

    // 2. Router: intent, plus the model's own policy check.
    const intentReq: IntentRequest = {
      text: req.text,
      tickets: req.tickets,
      components: req.components,
      fixedCapability: req.agent === 'auto' || (req.agent === 'analysis' && wantsAuthoring) ? null : req.agent,
      fixedTestType: req.testTypeSource === 'user' ? req.testType : null,
      rulesTestType: req.testTypeSource === 'user' ? null : req.testType,
      history: req.history,
    };
    const router = root.spawn('Router', 'router', `Work out what "${short}" needs and assign it`, cfg?.intentModel);
    let intent: Intent;
    let routerUsage: Usage | undefined;
    if (cfg) {
      const call = router.step('model', 'Classifying the request');
      const t0 = performance.now();
      let usage: Usage | null = null;
      try {
        const raw = await completeJson(cfg, intentMessages(intentReq, knownComponents), signal, (u) => (usage = u));
        rec.modelCall(router, { model: cfg.intentModel, purpose: 'intent', status: 'ok', usage, t0 });
        // Set in the onUsage callback, which TypeScript cannot see.
        const routerTokens = (usage as Usage | null) ?? undefined;
        const r = (raw ?? {}) as Record<string, unknown>;
        const policy = policyFromModel(r.in_scope, r.policy);
        if (policy) {
          call({ label: `Rejected: ${policy.title}`, detail: cfg.intentModel, failed: true });
          router.finish('rejected', { result: `Rejected: ${policy.title}`, ...routerTokens });
          audit('router', policy);
          db?.guardEvent({ workflowRunId: rec.workflowRunId, agentRunId: router.id, layer: 'router', policy: policy.id, userId });
          emit({ type: 'rejected', policy, by: 'Router' });
          return end('rejected', `Rejected by the router · ${total()}`);
        }
        const valid = validateIntent(raw, intentReq, knownComponents);
        intent = valid ?? rulesIntent(req);
        call(valid ? { label: 'Understood the request', detail: describe(intent) } : { label: 'Read the request with rules', detail: "The model's answer was unusable" });
        routerUsage = routerTokens;
      } catch (e) {
        rec.modelCall(router, { model: cfg.intentModel, purpose: 'intent', status: signal.aborted ? 'stopped' : 'error', usage, t0 });
        if (signal.aborted) throw e;
        intent = rulesIntent(req);
        call({ label: 'Read the request with rules', detail: `DeepSeek failed: ${(e as Error).message}` });
      }
    } else {
      const rules = router.step('rule', 'Reading the request with rules');
      intent = rulesIntent(req);
      rules({ label: 'Read the request with rules', detail: `${describe(intent)} · DeepSeek not configured` });
    }
    if (wantsAuthoring && intent.capability === 'analysis') intent = { ...intent, capability: 'authoring' };
    emit({ type: 'intent', intent });

    // 3a. Clarifier: the router was unsure, so ask rather than guess.
    if (intent.question) {
      router.finish('done', { result: 'Unsure; handed to the Clarifier', ...routerUsage });
      const ask = root.spawn('Clarifier', 'specialist', 'Ask the user what they need');
      const s = ask.step('rule', 'Asking a question');
      emit({
        type: 'answer',
        citations: [],
        blocks: [{ kind: 'prose', text: intent.question }, ...(intent.options.length ? [{ kind: 'followups' as const, items: intent.options }] : [])],
      });
      s({ label: 'Asked a question', detail: `Confidence ${Math.round(intent.confidence * 100)}%` });
      ask.finish('done', { result: 'Asked a question' });
      return end('done', `Needs your input · ${total()}`);
    }

    // 3b. UAT analyst: tools over Jira and test evidence, no model needed for the facts. When the
    //     person chose another capability themselves (say, authoring tests for the story), or Auto
    //     resolved the request to one (F21), that stands and the specialist gets the ticket as evidence.
    //     The UAT analyst's report answers a readiness question; any other analysis request about the
    //     story (explain this criterion, why is it not a candidate) goes to the Analysis agent with the
    //     report's evidence, so a follow-up is answered instead of repeating the report.
    const analysisWanted = intent.capability === 'analysis' && (req.agent === 'analysis' || req.agent === 'auto') && !wantsAuthoring && isReadinessRequest(req.text, req.tickets);
    const ticket = intent.testType === 'uat' && analysisWanted ? intent.tickets.map((k) => req.syncedTickets.find((t) => t.key === k)).find(Boolean) : undefined;
    if (ticket) {
      router.finish('done', { result: `Assigned to the UAT analyst: ${ticket.key}`, ...routerUsage });
      const uat = root.spawn('UAT analyst', 'tool_agent', `Check whether ${ticket.key} is ready for UAT`);
      // Coverage comes from Hexa: tests linked to each criterion and their latest pipeline results.
      const coverage = db ? db.suggestTests(ticket.key, db.coverageFor(ticket.key)) : ticket.acceptanceCriteria.map(() => ({ status: 'no-test' as const, evidence: 'No test linked to this criterion' }));
      // R24: a component whose repository is scan-only can never deliver an automated result; the report says so.
      const scanOnly = db ? scanOnlyComponents(db, app, ticket.components) : [];
      // The story's previous saved analysis, so the follow-ups offer "what changed since" only when it exists.
      const prev = db?.uatStates(app).get(ticket.key);
      const { answer, artifact } = uatAnswer(ticket, coverage, { scanOnly, previous: prev ? { at: prev.analysedAt, by: prev.by } : null });
      const run = answer.blocks[0];
      const tools = ['jira.get_story', 'hexa.linked_tests', 'hexa.latest_results', 'uat.draft_cases'];
      (run.kind === 'run' ? run.steps : []).forEach((s, i) => {
        const done = uat.step(s.noModel ? 'tool' : 'model', s.label, tools[i]);
        done({ detail: s.detail });
      });
      if (attachments.length) {
        const skip = uat.step('tool', `Attached files not used`, 'attachments.skip');
        skip({ detail: `The UAT analyst reads Jira and Hexa only; ${attachments.length} attached file${attachments.length > 1 ? 's were' : ' was'} not used.` });
      }
      // Proposed UAT cases go into Hexa, so the inventory shows what is planned as well as what exists.
      if (artifact.proposedCases.length) {
        const hexa = uat.step('tool', 'Adding proposed UAT cases to Hexa', 'hexa.add_proposed');
        db?.upsertProposedCases(ticket.key, artifact.proposedCases, userId);
        hexa({ detail: `${artifact.proposedCases.length} proposed` });
      }
      uat.finish('done', { result: `${artifact.criteria.filter((c) => c.status === 'passing').length} of ${artifact.criteria.length} criteria covered` });
      // A story in a flow: the analysis shows in the flow's timeline (a flow's own background analysis notes itself).
      if (db && !req.chatId?.startsWith('fa-')) {
        const who = db.getUser(userId)?.name ?? 'Someone';
        noteStory(db, app, ticket.key, userId, 'analysed', `${who} analysed ${ticket.key} in chat: ${artifact.criteria.filter((c) => c.status === 'passing').length} of ${artifact.criteria.length} criteria covered${artifact.proposedCases.length ? `, ${artifact.proposedCases.length} case${artifact.proposedCases.length === 1 ? '' : 's'} drafted for review` : ''}.`);
      }
      emit({ type: 'answer', blocks: answer.blocks.slice(1), citations: answer.citations, artifact, uatTicket: ticket.key });
      return end('done', `UAT analyst checked ${ticket.key} · ${total()}`);
    }

    // 3c. Capability specialist.
    const name = SPECIALIST[intent.capability];
    router.finish('done', { result: `Assigned to the ${name}`, ...routerUsage });
    const specialist = root.spawn(name, 'specialist', intent.action, cfg?.chatModel);

    // Sources the specialist may cite, numbered: attached files it can read first, then the best
    // passages from App Context. Unreadable files are named, never pretended.
    const readable = attachments.filter((a) => a.text);
    const sources = readable.map((a, i) => ({ n: i + 1, title: a.filename, text: a.text! }));
    const citations: Citation[] = sources.map((s) => ({ n: s.n, title: s.title, detail: 'Attached file' }));
    if (attachments.length) {
      const read = specialist.step('tool', `Reading ${attachments.length} attached file${attachments.length > 1 ? 's' : ''}`, 'attachments.read');
      const unreadable = attachments.filter((a) => !a.text);
      read({ detail: [`${readable.length} readable`, ...unreadable.map((a) => `${a.filename}: ${a.note ?? 'not readable'}`)].join(' · ') });
    }
    let passages: ContextPassage[] = [];
    if (db) {
      const look = specialist.step('tool', 'Reading App Context', 'context.retrieve');
      const found = await retrieveContext(db, app, req.text, { limit: 4, workspace: req.scope.workspace || null, models: opts.models });
      passages = found.passages;
      for (const p of passages) {
        const n = sources.length + 1;
        sources.push({ n, title: `${p.sourceTitle} · ${p.locator}`, text: p.text });
        citations.push({ n, title: p.sourceTitle, detail: `App Context · ${p.locator} · v${p.version}`, href: p.href });
      }
      const from = new Set(passages.map((p) => p.sourceTitle)).size;
      look({ detail: passages.length ? `${passages.length} passage${passages.length > 1 ? 's' : ''} from ${from} source${from > 1 ? 's' : ''} (${describeRetrieval(found)})` : `Nothing relevant in App Context (${describeRetrieval(found)})` });
      // Hexa facts for the components and stories the request names: the inventory is a source too.
      const facts = hexaEvidence(db, app, { components: intent.components, tickets: intent.tickets, text: req.text, known: db.getApp(app)?.components ?? [] });
      // In a flow's team thread, the flow itself is the first source.
      if (threadFlowId && member) facts.unshift(flowFacts(db, member, threadFlowId, userId, member.roles));
      if (facts.length) {
        const hexa = specialist.step('tool', 'Reading Hexa', 'hexa.evidence');
        for (const f of facts) {
          const n = sources.length + 1;
          sources.push({ n, title: f.title, text: f.text });
          citations.push({ n, title: f.title, detail: f.detail, href: f.href });
        }
        hexa({ detail: facts.map((f) => f.title.replace('Hexa · ', '')).join(', ') });
      }
    }
    if (citations.length) emit({ type: 'citations', citations });

    if (!cfg) {
      const s = specialist.step('rule', 'Routing only');
      const kind = intent.testType ? ` as ${testTypeLabel(intent.testType).toLowerCase()}` : '';
      const comps = intent.components.length ? ` covering ${intent.components.join(', ')}` : '';
      const what = [readable.length ? `${readable.length} attached file${readable.length > 1 ? 's' : ''}` : '', passages.length ? `${passages.length} App Context passage${passages.length > 1 ? 's' : ''}` : ''].filter(Boolean);
      const files = what.length ? ` It would read ${what.join(' and ')} (${sources.map((x) => `[${x.n}]`).join(', ')}).` : '';
      emit({
        type: 'answer',
        citations,
        blocks: [
          {
            kind: 'prose',
            text: `DeepSeek is not configured, so Catalyzt can only route this request: the ${name} would handle it${kind} for ${req.scope.appName}${comps}.${files} Add \`DEEPSEEK_API_KEY\` to \`app/.env\` and restart to get answers.`,
          },
        ],
      });
      s({ detail: 'DeepSeek not configured' });
      specialist.finish('done', { result: 'Routed only; no model configured' });
      return end('done', `Routed with rules · ${total()}`);
    }

    // F05: the last boundary before the model. Whatever a source is (attachment, passage, Hexa fact),
    // one that holds what looks like a secret is withheld, and the run says so.
    const safeSources = sources.filter((s) => !containsSecret(s.text));
    const withheld = sources.length - safeSources.length;
    if (withheld) specialist.step('rule', `Withheld ${withheld} source${withheld === 1 ? '' : 's'} that contain${withheld === 1 ? 's' : ''} what looks like a secret`)({ detail: 'Not sent to the model; remove the secret from the source and rotate it if it is real' });

    const write = specialist.step('model', 'Writing the answer');
    const tickets = intent.tickets.map((k) => req.syncedTickets.find((t) => t.key === k)).filter((t) => t !== undefined);
    let raw = '';
    let sent = 0;
    let usage: Usage | null = null;
    let thinking = false;
    const t0 = performance.now();
    try {
      for await (const ev of streamChat(cfg, chatMessages({ text: req.text, intent, scope: req.scope, history: req.history, tickets, sources: safeSources }), signal)) {
        if (ev.type === 'reasoning') thinking = true;
        else if (ev.type === 'usage') usage = { promptTokens: ev.promptTokens, completionTokens: ev.completionTokens };
        else if (ev.type === 'text') {
          raw += ev.text;
          // Output guard while streaming: redact, and hold back the unfinished word, which could be part of a secret.
          const safe = redactSecrets(raw);
          const upTo = Math.max(sent, streamSafeLength(safe));
          if (upTo > sent) {
            emit({ type: 'text', text: safe.slice(sent, upTo) });
            sent = upTo;
          }
        }
      }
    } catch (e) {
      const msg = e instanceof DeepSeekError ? e.userMessage : (e as Error).message;
      rec.modelCall(specialist, { model: cfg.chatModel, purpose: 'answer', status: signal.aborted ? 'stopped' : 'error', usage, t0 });
      write({ failed: true, detail: msg });
      specialist.finish(signal.aborted ? 'stopped' : 'failed', { error: msg, ...(usage ?? {}) });
      throw e;
    }
    rec.modelCall(specialist, { model: cfg.chatModel, purpose: 'answer', status: 'ok', usage, t0 });
    const safe = redactSecrets(raw);
    if (safe.length > sent) emit({ type: 'text', text: safe.slice(sent) });
    if (!safe.trim()) {
      write({ failed: true, detail: 'Empty answer' });
      specialist.finish('failed', { error: 'Empty answer' });
      throw new DeepSeekError('empty answer', 502, 'DeepSeek returned an empty answer.');
    }
    const u = usage as Usage | null;
    write({ label: 'Wrote the answer', detail: [cfg.chatModel, u && `${u.completionTokens} tokens`, thinking && 'thinking'].filter(Boolean).join(' · ') });
    specialist.finish('done', { result: 'Answered', model: cfg.chatModel, ...(u ?? {}) });

    // 4. Output guard.
    const out = root.spawn('Output guard', 'guard', 'Check the answer for secrets before it is shown');
    const scan = out.step('rule', 'Scanning the answer');
    const removed = (safe.match(/\[secret removed\]/g)?.length ?? 0) - (raw.match(/\[secret removed\]/g)?.length ?? 0);
    const label = removed > 0 ? `Removed ${removed} secret${removed > 1 ? 's' : ''}` : 'No secrets found';
    scan({ label });
    if (removed > 0) db?.guardEvent({ workflowRunId: rec.workflowRunId, agentRunId: out.id, layer: 'output', policy: 'secret-in-output', userId });
    out.finish('done', { result: label });
    return end('done', `${name} answered · ${total()}`);
  } catch (e) {
    const stopped = signal.aborted;
    root.finish(stopped ? 'stopped' : 'failed', { error: (e as Error).message });
    db?.finishWorkflow(rec.workflowRunId, stopped ? 'stopped' : 'failed', stopped ? 'Stopped' : 'Failed');
    // Close any agent still marked running in this run.
    db?.raw
      .prepare("UPDATE agent_runs SET status = ?, ended_at = ? WHERE workflow_run_id = ? AND status = 'running'")
      .run(stopped ? 'stopped' : 'failed', new Date().toISOString(), rec.workflowRunId);
    throw e;
  }
}
