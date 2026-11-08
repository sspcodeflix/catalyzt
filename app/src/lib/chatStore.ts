/**
 * Chats in the browser. The server is the record: every answer is stored there as a revision, and
 * ratings and approval decisions are server calls that the browser only reflects. This store keeps
 * the chats open in this session, renders answers as they stream (through the same reducer the
 * server stores with), and loads chats it does not have from GET /api/chats/:id.
 */
import { useSyncExternalStore } from 'react';

import { answerBlocks, applyEvent, finishAnswer, initialAnswer } from './answerReducer';
import { runWorkflow } from './llm';
import { http, sessionEpoch, StaleScopeError } from './session';
import { getTicket, recordUatAnalysis } from './ticketStore';
import type { Agent, Approval, Artifact, AssistantMessage, AttachmentRef, Chat, Message, Scope, TestType, UserMessage } from './types';

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

/* ---------- Recent chats, from the server, a page at a time ---------- */
let recent: { id: string; title: string; updatedAt: string }[] = [];
/** The cursor of the next older page of recents, or null when everything is loaded. */
let recentCursor: string | null = null;
/** True once older pages were loaded; a refresh of the first page then keeps them. */
let recentExtended = false;
let recentPage = { hasMore: false };
export const useRecentChats = () => useSyncExternalStore(subscribe, () => recent);
export const useRecentChatsPage = () => useSyncExternalStore(subscribe, () => recentPage);
const setRecentCursor = (c: string | null) => {
  recentCursor = c;
  if (recentPage.hasMore !== !!c) recentPage = { hasMore: !!c };
};
export async function refreshRecents() {
  const epoch = sessionEpoch();
  try {
    const r = await http('/api/chats');
    if (!r.ok) return;
    // F10: the body is read first; the scope is checked right before the list is replaced, so a slow
    // old-scope body can never land after the new list.
    const body = (await r.json()) as { chats: typeof recent; nextCursor?: string | null };
    if (epoch === sessionEpoch()) {
      if (recentExtended) {
        // Older pages stay; a chat that moved to the top is listed once.
        const top = new Set(body.chats.map((c) => c.id));
        recent = [...body.chats, ...recent.filter((c) => !top.has(c.id))];
      } else {
        recent = body.chats;
        setRecentCursor(body.nextCursor ?? null);
      }
      emit();
    }
  } catch {
    /* keep the last list */
  }
}
/** Appends the next older page of recent chats. */
export async function loadMoreRecents() {
  if (!recentCursor) return;
  const epoch = sessionEpoch();
  const r = await http(`/api/chats?cursor=${encodeURIComponent(recentCursor)}`);
  if (!r.ok) throw new Error(`Request failed (${r.status}).`);
  const body = (await r.json()) as { chats: typeof recent; nextCursor?: string | null };
  if (epoch !== sessionEpoch()) return;
  const have = new Set(recent.map((c) => c.id));
  recent = [...recent, ...body.chats.filter((c) => !have.has(c.id))];
  recentExtended = true;
  setRecentCursor(body.nextCursor ?? null);
  emit();
}
if (typeof window !== 'undefined') {
  // A new sign-in or application: this session's chats belong to someone else now.
  window.addEventListener('hz:session', () => {
    for (const c of running.values()) c.abort();
    chats.clear();
    loads.clear();
    requests.clear();
    recent = [];
    recentExtended = false;
    setRecentCursor(null);
    emit();
    void refreshRecents();
  });
}

export function useChat(chatId: string | undefined): Chat | undefined {
  return useSyncExternalStore(subscribe, () => (chatId ? chats.get(chatId) : undefined));
}

/* ---------- Loading a chat from the server ---------- */

/** How loading a chat went, for chats this session did not start. */
export type ChatLoad = { state: 'loading' } | { state: 'ready' } | { state: 'missing' } | { state: 'denied'; error: string } | { state: 'error'; error: string };
const loads = new Map<string, ChatLoad>();
export const useChatLoad = (chatId: string | undefined) => useSyncExternalStore(subscribe, () => (chatId ? loads.get(chatId) : undefined));

interface ServerChat {
  id: string;
  applicationId: string;
  title: string;
  agent: string;
  scope: Scope;
  testType: TestType | null;
  createdBy: string;
  flowId?: string | null;
  messages: Message[];
  artifacts: Record<string, Artifact>;
  olderCursor?: number | null;
}

/** Loads a chat that is not in memory: missing, denied and failed are distinct, and nothing foreign is shown. */
export async function loadChat(chatId: string, force = false): Promise<void> {
  if (!force && (chats.has(chatId) || loads.get(chatId)?.state === 'loading')) return;
  const epoch = sessionEpoch();
  loads.set(chatId, { state: 'loading' });
  emit();
  try {
    const res = await http(`/api/chats/${encodeURIComponent(chatId)}`);
    if (epoch !== sessionEpoch()) return;
    if (res.status === 404) {
      loads.set(chatId, { state: 'missing' });
    } else if (res.status === 403) {
      const b = (await res.json().catch(() => ({}))) as { error?: string };
      loads.set(chatId, { state: 'denied', error: b.error ?? 'You do not have access to this chat.' });
    } else if (!res.ok) {
      const b = (await res.json().catch(() => ({}))) as { error?: string };
      loads.set(chatId, { state: 'error', error: b.error ?? `Request failed (${res.status}).` });
    } else {
      const { chat } = (await res.json()) as { chat: ServerChat };
      if (epoch !== sessionEpoch()) return;
      // The server sends the latest page. Older messages already on screen (a reload after a lost
      // acknowledgement) stay in front of it.
      const had = chats.get(chatId);
      const at = had && chat.messages.length ? had.messages.findIndex((m) => m.id === chat.messages[0].id) : -1;
      const keep = had && at > 0 ? had.messages.slice(0, at) : [];
      chats.set(chatId, {
        id: chat.id,
        title: chat.title,
        agent: (chat.agent || 'auto') as Agent,
        scope: chat.scope,
        testType: chat.testType,
        messages: [...keep, ...chat.messages],
        artifacts: { ...(had && at > 0 ? had.artifacts : {}), ...chat.artifacts },
        createdBy: chat.createdBy,
        flowId: chat.flowId ?? null,
        olderCursor: keep.length ? had!.olderCursor ?? null : chat.olderCursor ?? null,
      });
      loads.set(chatId, { state: 'ready' });
      // A UAT report in a saved chat only fills a story the list has no analysis for (R14).
      for (const a of Object.values(chat.artifacts)) if (a.kind === 'uat') recordUatAnalysis(a.ticketKey, chatId, a.criteria.map((c) => c.status), { saved: true });
    }
  } catch (e) {
    if (epoch !== sessionEpoch()) return;
    loads.set(chatId, { state: 'error', error: (e as Error).message });
  }
  emit();
}

/** Reads the next older page of a loaded chat and puts it in front. Revision and approval ids are the server's. */
const olderLoads = new Set<string>();
export async function loadOlderMessages(chatId: string): Promise<void> {
  const c = chats.get(chatId);
  if (!c || c.olderCursor == null || olderLoads.has(chatId)) return;
  const epoch = sessionEpoch();
  olderLoads.add(chatId);
  try {
    const res = await http(`/api/chats/${encodeURIComponent(chatId)}?before=${c.olderCursor}`);
    const body = (await res.json().catch(() => ({}))) as { chat?: ServerChat; error?: string };
    if (epoch !== sessionEpoch()) return;
    if (!res.ok || !body.chat) throw new Error(body.error ?? `Request failed (${res.status}).`);
    const older = body.chat;
    update(chatId, (now) => {
      const have = new Set(now.messages.map((m) => m.id));
      // The artifacts already shown are newer than the older page's, so they win.
      return { ...now, messages: [...older.messages.filter((m) => !have.has(m.id)), ...now.messages], artifacts: { ...older.artifacts, ...now.artifacts }, olderCursor: older.olderCursor ?? null };
    });
  } finally {
    olderLoads.delete(chatId);
  }
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
  attachments?: AttachmentRef[];
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
  loads.set(chatId, { state: 'ready' });
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
    // Auto, so follow-ups in the chat (write the cases, explain a criterion) reach the right agent.
    agent: 'auto',
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

/** Answers loaded from the server have no request in this session, so they can't be retried here. */
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
    attachments: msg.attachments,
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

/** Runs the same request again. The server numbers the new revision, which needs its own rating. */
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
 * Sends the request through the server's agent workflow and fills in the answer from its events,
 * with the reducer the server also stores with. The stream is read to its end: `done` closes the
 * answer on screen, and the `saved` event that follows carries the revision and approval ids that
 * ratings and decisions need.
 */
async function runAnswer(chatId: string, answerId: string) {
  const req = requests.get(answerId)!;
  const { msg } = req;
  const ctrl = new AbortController();
  running.set(chatId, ctrl);
  const epoch = sessionEpoch();
  const set = (fn: (m: AssistantMessage) => AssistantMessage) => {
    if (chats.has(chatId) && epoch === sessionEpoch()) updateAnswer(chatId, answerId, fn);
  };

  let answer = initialAnswer();
  let pending = false;
  let done = false;
  // `done` also closes a failed or stopped answer locally; only the server's own `done` event means it finished.
  let finished = false;
  let savedSeen = false;
  const render = () =>
    set((m) => ({
      ...m,
      blocks: answerBlocks(answer),
      citations: answer.citations,
      status: answer.status === 'streaming' && m.status === 'working' ? 'streaming' : m.status,
    }));
  // Stream updates are batched to one per animation frame; `done` stops a late one overwriting the final state.
  const schedule = () => {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      if (!done) render();
    });
  };
  const current = chats.get(chatId)?.messages.find((m) => m.id === answerId);

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
        answerId,
        attachmentIds: msg.attachments?.map((a) => a.id),
        revision: current?.role === 'assistant' ? current.revision : 1,
      },
      ctrl.signal,
    )) {
      answer = applyEvent(answer, ev);
      switch (ev.type) {
        case 'intent': {
          const intent = ev.intent;
          // Show how the request was read on the user's message too.
          if (chats.has(chatId) && epoch === sessionEpoch()) {
            update(chatId, (c) => ({
              ...c,
              testType: intent.testType ?? c.testType,
              messages: c.messages.map((m) => (m.id === req.userId && m.role === 'user' ? { ...m, testType: intent.testType, tickets: intent.tickets, components: intent.components } : m)),
            }));
          }
          set((m) => ({ ...m, intent, capability: intent.capability }));
          break;
        }
        case 'rejected':
          // A message rejected for containing a secret is not kept, so the secret is not left on screen.
          if (ev.policy.id === 'secret-in-input' && chats.has(chatId) && epoch === sessionEpoch()) {
            update(chatId, (c) => ({
              ...c,
              title: c.messages.length <= 2 ? 'Message removed' : c.title,
              messages: c.messages.map((m) => (m.id === req.userId && m.role === 'user' ? { ...m, text: '[Message removed: it contained a secret]' } : m)),
            }));
            requests.set(answerId, { ...req, msg: { ...msg, text: '' } });
          }
          break;
        case 'answer': {
          const { artifact, uatTicket } = ev;
          if (artifact && chats.has(chatId) && epoch === sessionEpoch()) {
            update(chatId, (c) => ({
              ...c,
              title: uatTicket && c.messages.length <= 2 ? titleFor(msg.text, [uatTicket]) : c.title,
              artifacts: { ...c.artifacts, [artifact.id]: artifact },
            }));
          }
          if (uatTicket && artifact?.kind === 'uat') recordUatAnalysis(uatTicket, chatId, artifact.criteria.map((c) => c.status));
          break;
        }
        case 'text':
          schedule();
          continue;
        case 'done':
          done = true;
          finished = true;
          render();
          set((m) => ({ ...m, status: 'done' }));
          void refreshRecents();
          continue;
        case 'saved':
          savedSeen = true;
          set((m) => ({ ...m, blocks: answerBlocks(answer), revisionId: ev.revisionId, revision: ev.revision ?? m.revision }));
          continue;
        case 'error':
          throw new Error(ev.message);
      }
      render();
    }
    if (!done) throw new Error('The connection closed before the answer finished.');
  } catch (e) {
    // After `done` the answer stands; a broken connection then only means `saved` may not have arrived.
    if (done) return;
    done = true;
    answer = finishAnswer(answer, ctrl.signal.aborted, (e as Error).message);
    set((m) => ({ ...m, blocks: answerBlocks(answer), citations: answer.citations, status: answer.status, error: answer.error }));
  } finally {
    if (running.get(chatId) === ctrl) running.delete(chatId);
    // F07: the answer finished but the `saved` acknowledgement was lost with the connection. The server
    // has the saved run; read it back so the revision and approval ids arrive without another model call.
    // Not after Stop or a failure before `done`: those keep their Stopped / Try again state.
    if (finished && !savedSeen && epoch === sessionEpoch()) void loadChat(chatId, true);
  }
}

/* ---------- Ratings and decisions: the server decides, the browser reflects ---------- */

async function post<T>(url: string, body: unknown): Promise<T> {
  const res = await http(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const out = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(out.error ?? `Request failed (${res.status}).`);
  return out;
}

export interface FeedbackPattern {
  capability: string;
  reason: string;
  count: number;
}

/** Rates a saved revision. Below 4 stars the server requires a reason and what was expected. */
export async function rateAnswer(chatId: string, messageId: string, stars: number, feedback: { reasons: string[]; comment: string } = { reasons: [], comment: '' }): Promise<{ patterns: FeedbackPattern[] }> {
  const m = chats.get(chatId)?.messages.find((x) => x.id === messageId);
  if (!m || m.role !== 'assistant') throw new Error('Unknown answer');
  if (m.status && m.status !== 'done') throw new Error('Wait for the answer to finish');
  if (!m.revisionId) throw new Error('This answer was not saved, so it cannot be rated.');
  // F09: the response applies to the revision that was rated, in the scope that rated it. A retry
  // meanwhile means a newer revision is on screen; its rating stays empty.
  const revisionId = m.revisionId;
  const epoch = sessionEpoch();
  const r = await post<{ ok: true; patterns?: FeedbackPattern[] }>(`/api/answers/${encodeURIComponent(revisionId)}/rating`, { stars, ...feedback });
  if (epoch !== sessionEpoch()) throw new StaleScopeError();
  updateAnswer(chatId, messageId, (x) => (x.revisionId === revisionId ? { ...x, rating: stars } : x));
  return { patterns: r.patterns ?? [] };
}

/** Decides an approval on the server (rating gate and roles are checked there) and reflects the recorded state. */
export async function decideApproval(chatId: string, messageId: string, approvalId: string, decision: 'approved' | 'declined'): Promise<Approval['status']> {
  const epoch = sessionEpoch();
  const r = await post<{ approval: { status: Approval['status']; decidedAt?: string; decidedBy?: string; outcome?: Approval['outcome'] } }>(`/api/approvals/${encodeURIComponent(approvalId)}/decision`, { decision });
  if (epoch !== sessionEpoch()) throw new StaleScopeError();
  updateAnswer(chatId, messageId, (m) => ({
    ...m,
    blocks: m.blocks.map((b) => (b.kind === 'approval' && b.approval.id === approvalId ? { ...b, approval: { ...b.approval, status: r.approval.status, decidedAt: r.approval.decidedAt, decidedBy: r.approval.decidedBy, outcome: r.approval.outcome } } : b)),
  }));
  return r.approval.status;
}
