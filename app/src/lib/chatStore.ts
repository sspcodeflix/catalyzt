/**
 * In-memory chat store. It stands in for the API: each exported action maps to one endpoint,
 * and the rules that matter for safety (the rating gate on approvals) are enforced here, not
 * only in the UI, the way the server must enforce them.
 */
import { useSyncExternalStore } from 'react';

import { runWorkflow } from './llm';
import { http } from './session';
import { getTicket, recordUatAnalysis } from './ticketStore';
import type { Agent, AgentView, AssistantMessage, Block, Chat, RunStep, Scope, TestType, UserMessage } from './types';

const chats = new Map<string, Chat>();
const listeners = new Set<() => void>();

let chatList: Chat[] = [...chats.values()];
const emit = () => {
  chatList = [...chats.values()];
  listeners.forEach((l) => l());
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/** Replace the chat object so React sees a new reference. */
function update(chatId: string, fn: (c: Chat) => Chat) {
  const c = chats.get(chatId);
  if (!c) throw new Error(`Unknown chat ${chatId}`);
  chats.set(chatId, fn(c));
  emit();
}

function updateAnswer(chatId: string, messageId: string, fn: (m: AssistantMessage) => AssistantMessage) {
  update(chatId, (c) => ({
    ...c,
    messages: c.messages.map((m) => (m.id === messageId && m.role === 'assistant' ? fn(m) : m)),
  }));
}

/** All chats loaded in this session, for Search. */
export const useChatList = () => useSyncExternalStore(subscribe, () => chatList);

/* ---------- Recent chats, from the server ---------- */
let recent: { id: string; title: string; updatedAt: string }[] = [];
export const useRecentChats = () => useSyncExternalStore(subscribe, () => recent);
export async function refreshRecents() {
  try {
    const r = await http('/api/chats');
    if (r.ok) {
      recent = ((await r.json()) as { chats: typeof recent }).chats;
      emit();
    }
  } catch {
    /* keep the last list */
  }
}
if (typeof window !== 'undefined') {
  // A new sign-in or application: this session's chats belong to someone else now.
  window.addEventListener('hz:session', () => {
    for (const c of running.values()) c.abort();
    chats.clear();
    requests.clear();
    recent = [];
    emit();
    void refreshRecents();
  });
}

export function useChat(chatId: string | undefined): Chat | undefined {
  return useSyncExternalStore(subscribe, () => (chatId ? chats.get(chatId) : undefined));
}

export interface NewMessage {
  text: string;
  agent: Agent;
  scope: Scope;
  /** UAT or regression, as detected in the composer or chosen by the user. */
  testType: TestType | null;
  /** 'user' when the user picked the test type; the model may not change it. */
  testTypeSource?: 'user' | 'rules' | null;
  tickets: string[];
  components: string[];
}

export function createChat(chatId: string, first: NewMessage) {
  if (chats.has(chatId)) return;
  chats.set(chatId, {
    id: chatId,
    title: titleFor(first.text, first.testType === 'uat' ? first.tickets : []),
    agent: first.agent,
    scope: first.scope,
    testType: first.testType,
    messages: [],
    artifacts: {},
  });
  sendMessage(chatId, first);
}

function titleFor(text: string, uatTickets: string[]) {
  const ticket = uatTickets.map(getTicket).find(Boolean);
  const title = ticket ? `UAT · ${ticket.key} ${ticket.summary}` : text;
  return title.length > 48 ? `${title.slice(0, 47)}…` : title;
}

/** Starts a UAT analysis of one synced Jira ticket and returns the new chat's id. */
export function startUatChat(ticketKey: string, scope: Scope): string {
  const id = crypto.randomUUID();
  createChat(id, {
    text: `Is ${ticketKey} ready for UAT?`,
    agent: 'analysis',
    scope,
    testType: 'uat',
    testTypeSource: 'user',
    tickets: [ticketKey],
    components: [],
  });
  return id;
}

/* ---------- Answer pipeline ---------- */

/** The request behind each answer, so Retry can run it again. */
const requests = new Map<string, { msg: NewMessage; userId: string }>();
/** One running answer per chat. */
const running = new Map<string, AbortController>();

/** Seeded answers have no request behind them, so they can't be retried. */
export const canRetry = (answerId: string) => !!requests.get(answerId)?.msg.text;

export const isAnswering = (chat: Chat | undefined) =>
  !!chat?.messages.some((m) => m.role === 'assistant' && (m.status === 'working' || m.status === 'streaming'));

export function stopAnswer(chatId: string) {
  running.get(chatId)?.abort();
}

/** Adds the user's message and an answer that fills in as the pipeline runs. */
export function sendMessage(chatId: string, msg: NewMessage) {
  stopAnswer(chatId);
  const user: UserMessage = {
    id: crypto.randomUUID(),
    role: 'user',
    text: msg.text,
    testType: msg.testType,
    tickets: msg.tickets,
    components: msg.components,
  };
  const answerId = crypto.randomUUID();
  requests.set(answerId, { msg, userId: user.id });
  update(chatId, (c) => ({
    ...c,
    agent: msg.agent,
    scope: msg.scope,
    testType: msg.testType ?? c.testType,
    messages: [...c.messages, user, workingAnswer(answerId, 1)],
  }));
  void runAnswer(chatId, answerId);
}

/** Runs the same request again as a new revision, which needs its own rating. */
export function retryAnswer(chatId: string, answerId: string) {
  const answer = chats.get(chatId)?.messages.find((m) => m.id === answerId);
  if (!answer || answer.role !== 'assistant' || !requests.has(answerId)) return;
  stopAnswer(chatId);
  updateAnswer(chatId, answerId, () => workingAnswer(answerId, answer.revision + 1));
  void runAnswer(chatId, answerId);
}

function workingAnswer(id: string, revision: number): AssistantMessage {
  return {
    id,
    role: 'assistant',
    capability: null,
    revision,
    rating: null,
    citations: [],
    status: 'working',
    blocks: [{ kind: 'run', summary: 'Working', steps: [{ label: 'Understanding the request', seconds: 0, state: 'running' }] }],
  };
}

/** Text of earlier turns, for the model's context. */
function historyBefore(chat: Chat, userId: string) {
  const out: { role: 'user' | 'assistant'; text: string }[] = [];
  const msgs = chat.messages;
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (m.id === userId) break;
    // Leave out turns a guardrail rejected; the server drops them too.
    const next = msgs[i + 1];
    const rejected = next?.role === 'assistant' && next.blocks.some((b) => b.kind === 'rejected');
    if (m.role === 'user') {
      if (!rejected) out.push({ role: 'user', text: m.text });
    } else if (!m.blocks.some((b) => b.kind === 'rejected')) {
      const text = m.blocks.flatMap((b) => (b.kind === 'prose' ? [b.text] : [])).join('\n\n');
      if (text) out.push({ role: 'assistant', text });
    }
  }
  return out;
}

/**
 * Sends the request through the server's agent workflow (guards, router, one sub-agent) and
 * fills in the answer from its events. See server/workflow.ts.
 */
async function runAnswer(chatId: string, answerId: string) {
  const req = requests.get(answerId)!;
  const { msg } = req;
  const ctrl = new AbortController();
  running.set(chatId, ctrl);
  const set = (fn: (m: AssistantMessage) => AssistantMessage) => {
    if (chats.has(chatId)) updateAnswer(chatId, answerId, fn);
  };

  let steps: RunStep[] = [];
  let agents: AgentView[] = [];
  let summary = 'Working';
  let text = '';
  let streamed = false;
  let pending = false;
  let finished = false;
  // Blocks that come after the prose (cards, approvals, follow-ups), from a structured answer.
  let rest: Block[] = [];

  const render = () =>
    set((m) => ({
      ...m,
      blocks: [{ kind: 'run', summary, steps, agents }, ...(streamed || text ? [{ kind: 'prose' as const, text }] : []), ...rest],
    }));
  // Stream updates are batched to one per animation frame; `finished` stops a late one overwriting the final state.
  const schedule = () => {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      if (!finished) render();
    });
  };

  try {
    for await (const ev of runWorkflow(
      {
        text: msg.text,
        agent: msg.agent,
        scope: msg.scope,
        testType: msg.testType,
        testTypeSource: msg.testTypeSource ?? null,
        tickets: msg.tickets,
        components: msg.components,
        history: historyBefore(chats.get(chatId)!, req.userId),
        // The server reads stories from its own database.
        syncedTickets: [],
        chatId,
        chatTitle: chats.get(chatId)?.title,
        messageId: req.userId,
        revision: chats.get(chatId)?.messages.find((m) => m.id === answerId)?.role === 'assistant'
          ? (chats.get(chatId)!.messages.find((m) => m.id === answerId) as AssistantMessage).revision
          : 1,
      },
      ctrl.signal,
    )) {
      switch (ev.type) {
        case 'agent': {
          const prev = agents.find((a) => a.id === ev.id);
          const a: AgentView = { id: ev.id, parentId: ev.parentId, agent: ev.agent, kind: ev.kind, task: ev.task, state: ev.state, model: ev.model, result: ev.result, tokens: ev.tokens, seconds: ev.seconds, steps: prev?.steps ?? [] };
          agents = prev ? agents.map((x) => (x.id === ev.id ? a : x)) : [...agents, a];
          // A flat list of steps, labelled with their agent, for the collapsed summary and older views.
          steps = agents.filter((x) => x.parentId).map((x) => ({ id: x.id, agent: x.agent, label: x.result ?? x.task, seconds: x.seconds, state: x.state === 'running' ? 'running' : x.state === 'done' ? 'done' : 'failed', noModel: !x.model }));
          render();
          break;
        }
        case 'step': {
          const st = { id: ev.id, kind: ev.kind, label: ev.label, detail: ev.detail, state: ev.state, seconds: ev.seconds };
          agents = agents.map((a) => (a.id !== ev.agentId ? a : { ...a, steps: a.steps.some((x) => x.id === ev.id) ? a.steps.map((x) => (x.id === ev.id ? st : x)) : [...a.steps, st] }));
          render();
          break;
        }
        case 'intent': {
          const intent = ev.intent;
          // Show how the request was read on the user's message too.
          update(chatId, (c) => ({
            ...c,
            testType: intent.testType ?? c.testType,
            messages: c.messages.map((m) =>
              m.id === req.userId && m.role === 'user'
                ? { ...m, testType: intent.testType, tickets: intent.tickets, components: intent.components }
                : m,
            ),
          }));
          set((m) => ({ ...m, intent, capability: intent.capability }));
          break;
        }
        case 'rejected':
          rest = [{ kind: 'rejected', title: ev.policy.title, text: ev.policy.message, by: ev.by }];
          // A message rejected for containing a secret is not kept, so the secret is not left on screen.
          if (ev.policy.id === 'secret-in-input') {
            update(chatId, (c) => ({
              ...c,
              title: c.messages.length <= 2 ? 'Message removed' : c.title,
              messages: c.messages.map((m) => (m.id === req.userId && m.role === 'user' ? { ...m, text: '[Message removed: it contained a secret]' } : m)),
            }));
            requests.set(answerId, { ...req, msg: { ...msg, text: '' } });
          }
          render();
          break;
        case 'answer': {
          const prose = ev.blocks.filter((b) => b.kind === 'prose').map((b) => (b.kind === 'prose' ? b.text : '')).join('\n\n');
          text = prose;
          rest = ev.blocks.filter((b) => b.kind !== 'prose');
          const { artifact, uatTicket } = ev;
          if (artifact) {
            update(chatId, (c) => ({
              ...c,
              title: uatTicket && c.messages.length <= 2 ? titleFor(msg.text, [uatTicket]) : c.title,
              artifacts: { ...c.artifacts, [artifact.id]: artifact },
            }));
          }
          if (uatTicket && artifact?.kind === 'uat') recordUatAnalysis(uatTicket, chatId, artifact.criteria.map((c) => c.status));
          set((m) => ({ ...m, citations: ev.citations }));
          render();
          break;
        }
        case 'text':
          if (!streamed) {
            streamed = true;
            set((m) => ({ ...m, status: 'streaming' }));
          }
          text += ev.text;
          schedule();
          break;
        case 'done':
          void refreshRecents();
          summary = ev.tokens > 0 ? `${ev.summary} · ${ev.tokens.toLocaleString()} tokens` : ev.summary;
          finished = true;
          render();
          set((m) => ({ ...m, status: 'done' }));
          return;
        case 'error':
          throw new Error(ev.message);
      }
    }
    throw new Error('The connection closed before the answer finished.');
  } catch (e) {
    finished = true;
    const stopped = ctrl.signal.aborted;
    steps = steps.map((s) => (s.state === 'running' ? { ...s, state: stopped ? 'done' : 'failed', label: stopped ? `${s.label} (stopped)` : s.label } : s));
    agents = agents.map((a) => (a.state === 'running' ? { ...a, state: stopped ? 'stopped' : 'failed', steps: a.steps.map((x) => (x.state === 'running' ? { ...x, state: 'failed' } : x)) } : a));
    summary = stopped ? 'Stopped' : 'Failed';
    render();
    set((m) => ({ ...m, status: stopped ? 'stopped' : 'error', error: stopped ? undefined : (e as Error).message }));
  } finally {
    if (running.get(chatId) === ctrl) running.delete(chatId);
  }
}

export function rateAnswer(chatId: string, messageId: string, stars: number) {
  const m = chats.get(chatId)?.messages.find((x) => x.id === messageId);
  if (m?.role === 'assistant' && m.status && m.status !== 'done') throw new Error('Wait for the answer to finish');
  if (!Number.isInteger(stars) || stars < 1 || stars > 5) throw new Error('Rating must be 1 to 5');
  updateAnswer(chatId, messageId, (m) => ({ ...m, rating: stars }));
}

export function decideApproval(chatId: string, messageId: string, decision: 'approved' | 'declined') {
  const answer = chats.get(chatId)?.messages.find((m) => m.id === messageId);
  if (!answer || answer.role !== 'assistant') throw new Error('Unknown answer');
  // Server-side rule: an approval cannot be acted on until the answer it belongs to is rated.
  if (decision === 'approved' && answer.rating === null) throw new Error('Rate the answer before approving');
  updateAnswer(chatId, messageId, (m) => ({
    ...m,
    blocks: m.blocks.map((b) =>
      b.kind === 'approval' && b.approval.status === 'pending'
        ? { ...b, approval: { ...b.approval, status: decision, decidedAt: new Date().toISOString() } }
        : b,
    ),
  }));
  if (decision === 'approved') void carryOut(chatId, messageId);
}

/** Carries out approvals Horizon can act on itself, and records the outcome on the card. */
async function carryOut(chatId: string, messageId: string) {
  const chat = chats.get(chatId);
  const answer = chat?.messages.find((m) => m.id === messageId);
  if (!chat || answer?.role !== 'assistant') return;
  const block = answer.blocks.find((b) => b.kind === 'approval');
  if (block?.kind !== 'approval' || block.approval.action !== 'add_uat_cases' || !block.approval.artifactId) return;
  const artifact = chat.artifacts[block.approval.artifactId];
  if (artifact?.kind !== 'uat') return;
  const setOutcome = (outcome: { ok: boolean; text: string }) =>
    updateAnswer(chatId, messageId, (m) => ({ ...m, blocks: m.blocks.map((b) => (b.kind === 'approval' ? { ...b, approval: { ...b.approval, outcome } } : b)) }));
  try {
    const res = await http('/api/hexa/manual/from-uat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ storyKey: artifact.ticketKey, cases: artifact.proposedCases }),
    });
    const body = (await res.json()) as { created?: number; updated?: number; error?: string };
    if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
    const n = (body.created ?? 0) + (body.updated ?? 0);
    setOutcome({ ok: true, text: `Added ${n} manual test${n === 1 ? '' : 's'} to Hexa, linked to ${artifact.ticketKey}` });
  } catch (e) {
    setOutcome({ ok: false, text: `Could not add the cases to Hexa: ${(e as Error).message}` });
  }
}
