/**
 * Huddle in the browser: the server's decisions for the selected application. Votes, comments and
 * decisions are server calls; the item shown is what the server recorded. Responses for an
 * earlier person or application are dropped (sessionEpoch).
 */
import { useSyncExternalStore } from 'react';

import type { IconName } from '../components/icons';
import { getSession, http, sessionEpoch, StaleScopeError } from './session';
import type { Citation } from './types';

export type HuddleKind = 'conflict' | 'mapping' | 'risk' | 'feedback' | 'concern' | 'decision' | 'change_review' | 'vulnerability' | 'incident_followup' | 'capacity_warning';
export type HuddleDomain = 'testing' | 'reliability' | 'security' | 'knowledge' | 'process';
export type HuddleStage = 'open' | 'needs_input' | 'decided' | 'follow_up' | 'closed';

export const kindInfo: Record<HuddleKind, { label: string; icon: IconName }> = {
  conflict: { label: 'Source conflict', icon: 'warn' },
  mapping: { label: 'Disputed mapping', icon: 'target' },
  risk: { label: 'Risk acceptance', icon: 'shield' },
  feedback: { label: 'Feedback pattern', icon: 'star' },
  concern: { label: 'Concern', icon: 'people' },
  decision: { label: 'Decision', icon: 'target' },
  change_review: { label: 'Change review', icon: 'layers' },
  vulnerability: { label: 'Vulnerability', icon: 'shield' },
  incident_followup: { label: 'Incident follow-up', icon: 'warn' },
  capacity_warning: { label: 'Capacity warning', icon: 'warn' },
};

export const domainInfo: Record<HuddleDomain, { label: string; decider: string }> = {
  testing: { label: 'Testing', decider: 'the manager of an affected component or an app owner' },
  reliability: { label: 'Reliability', decider: 'an SRE lead or an app owner' },
  security: { label: 'Security', decider: 'a security champion or an app owner' },
  knowledge: { label: 'Knowledge', decider: 'an app owner' },
  process: { label: 'Process', decider: 'an app owner' },
};
export const DOMAINS: HuddleDomain[] = ['testing', 'reliability', 'security', 'knowledge', 'process'];

export interface HuddleAction {
  id: string;
  title: string;
  owner: { id: string; name: string; initials: string };
  dueAt: string | null;
  status: 'open' | 'done';
  link: string | null;
  overdue: boolean;
  doneAt: string | null;
  doneBy: string | null;
}

export interface Person {
  initials: string;
  name: string;
}

/** The acting person, from the session. */
const sessionMe = (): Person & { role: 'owner' | 'member' } => {
  const m = getSession().me;
  return { initials: m?.user.initials ?? '?', name: m?.user.name ?? 'Unknown', role: m?.app?.roles.includes('app_owner') ? 'owner' : 'member' };
};
export const me = new Proxy({} as Person & { role: 'owner' | 'member' }, { get: (_t, k) => sessionMe()[k as keyof ReturnType<typeof sessionMe>] });

export interface HuddleOption {
  id: string;
  title: string;
  detail: string;
  /** Initials of the people who voted for this option. Votes are advisory. */
  votes: string[];
  keepsUpload: boolean;
  accepts: boolean;
}

export interface HuddleComment {
  id: string;
  who: Person;
  at: string;
  text: string;
}

export interface HuddleItem {
  id: string;
  kind: HuddleKind;
  domain: HuddleDomain;
  stage: HuddleStage;
  severity: 'critical' | 'high' | 'medium' | 'low' | null;
  dueAt: string | null;
  expiresAt: string | null;
  overdue: boolean;
  /** Why an accepted risk reopened at its expiry. */
  reopenNote: string | null;
  answer?: { text: string; by: string; at: string };
  actions: HuddleAction[];
  links: { type: string; ref: string; label: string; href?: string }[];
  /** The server says this person may decide (by domain). */
  canDecide: boolean;
  waitingOnMe: boolean;
  title: string;
  summary: string;
  raisedBy: string;
  raisedByType: 'user' | 'agent';
  raisedAt: string;
  scope: string;
  people: string[];
  openLabel: string;
  openTone: string;
  aiSummary: string;
  citations: Citation[];
  affects: { label: string; href?: string }[];
  options: HuddleOption[];
  comments: HuddleComment[];
  needsInput: boolean;
  sourceId: string | null;
  decision?: { optionId: string; reason: string; at: string; by: string };
  myVote: string | null;
  /** R17: open items of the same kind about the same source or with a near-identical title. */
  similar: { id: string; title: string }[];
  detail: true;
}

/** A list entry: the item without its discussion and cited summary (those load with the item). */
export type HuddleSummary = Omit<HuddleItem, 'comments' | 'citations' | 'aiSummary' | 'detail'> & { commentCount: number; detail: false };

export type HuddleFilter = 'open' | 'waiting' | 'decided' | 'mine';
export interface HuddleCounts {
  open: number;
  decided: number;
  mine: number;
}

interface State {
  /** The pages loaded for the current filter and search, newest first. */
  items: HuddleSummary[];
  loaded: boolean;
  error: string | null;
  /** The next page's cursor, or null when the list is complete. */
  nextCursor: string | null;
  loadingMore: boolean;
  counts: HuddleCounts;
  waiting: number;
  domains: Record<HuddleDomain, number> | null;
  query: { filter: HuddleFilter; q: string; domain: HuddleDomain | null };
  /** Full items, read on demand when one is opened. */
  details: Record<string, HuddleItem>;
}

const EMPTY: State = { items: [], loaded: false, error: null, nextCursor: null, loadingMore: false, counts: { open: 0, decided: 0, mine: 0 }, waiting: 0, domains: null, query: { filter: 'open', q: '', domain: null }, details: {} };
let state: State = EMPTY;
const listeners = new Set<() => void>();
const set = (next: Partial<State>) => {
  state = { ...state, ...next };
  listeners.forEach((l) => l());
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export const useHuddleState = () => useSyncExternalStore(subscribe, () => state);
/** One full item, once it was read with fetchItem. */
export const useHuddleItem = (id: string | undefined) => useSyncExternalStore(subscribe, () => (id ? state.details[id] : undefined));

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const epoch = sessionEpoch();
  const res = await http(url, init?.body ? { ...init, headers: { 'Content-Type': 'application/json', ...((init.headers as Record<string, string> | undefined) ?? {}) } } : init);
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (epoch !== sessionEpoch()) throw new StaleScopeError();
  if (!res.ok) throw Object.assign(new Error(body.error ?? `Request failed (${res.status}).`), { status: res.status });
  return body;
}

interface Page {
  items: HuddleSummary[];
  nextCursor: string | null;
  counts: HuddleCounts;
  waiting: number;
  domains: Record<HuddleDomain, number>;
}
const pageUrl = (query: State['query'], cursor?: string | null) => {
  const p = new URLSearchParams();
  if (query.filter === 'mine') p.set('mine', '1');
  else if (query.filter === 'waiting') p.set('waiting', 'me');
  else p.set('status', query.filter);
  if (query.domain) p.set('domain', query.domain);
  if (query.q.trim()) p.set('q', query.q.trim());
  if (cursor) p.set('cursor', cursor);
  return `/api/huddle?${p}`;
};

let loading: Promise<void> | null = null;
let generation = 0;
/** Loads the first page for the current filter and search (or a new one). */
export function loadHuddle(force = false, query?: Partial<State['query']>): Promise<void> {
  const q = { ...state.query, ...(query ?? {}) };
  const changed = q.filter !== state.query.filter || q.q !== state.query.q || q.domain !== state.query.domain;
  if (loading && !force && !changed) return loading;
  const gen = ++generation;
  if (changed) set({ query: q, loaded: false });
  loading = api<Page>(pageUrl(q))
    .then((b) => {
      if (gen !== generation) return;
      set({ items: b.items, nextCursor: b.nextCursor, counts: b.counts, waiting: b.waiting, domains: b.domains, loaded: true, error: null });
    })
    .catch((e: Error) => {
      if (e instanceof StaleScopeError || gen !== generation) return;
      loading = null;
      set({ loaded: true, error: e.message });
    });
  return loading;
}

/** Appends the next page. */
export async function loadMoreHuddle(): Promise<void> {
  if (!state.nextCursor || state.loadingMore) return;
  const gen = generation;
  set({ loadingMore: true });
  try {
    const b = await api<Page>(pageUrl(state.query, state.nextCursor));
    if (gen !== generation) return;
    const have = new Set(state.items.map((i) => i.id));
    set({ items: [...state.items, ...b.items.filter((i) => !have.has(i.id))], nextCursor: b.nextCursor, counts: b.counts, loadingMore: false });
  } catch (e) {
    set({ loadingMore: false });
    if (!(e instanceof StaleScopeError)) throw e;
  }
}

/** Counts for the whole application (the sidebar badge, the filter buttons), after a change. */
async function refreshCounts() {
  try {
    const b = await api<Page>(`/api/huddle?limit=1`);
    set({ counts: b.counts, waiting: b.waiting, domains: b.domains });
  } catch {
    /* keep the last counts */
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('hz:session', () => {
    loading = null;
    generation++;
    state = { ...EMPTY, query: state.query };
    listeners.forEach((l) => l());
    void loadHuddle(true);
  });
}

const toSummary = ({ comments, citations: _c, aiSummary: _a, detail: _d, ...rest }: HuddleItem): HuddleSummary => ({ ...rest, commentCount: comments.length, detail: false });
/** A full item from the server: kept as the item's detail, and its list entry (if loaded) follows it. */
const replace = (item: HuddleItem) =>
  set({ details: { ...state.details, [item.id]: item }, items: state.items.map((i) => (i.id === item.id ? toSummary(item) : i)) });

/** One full item from the server. Null when it does not exist in this application. */
export async function fetchItem(id: string): Promise<HuddleItem | null> {
  try {
    const { item } = await api<{ item: HuddleItem }>(`/api/huddle/${encodeURIComponent(id)}`);
    replace(item);
    return item;
  } catch (e) {
    if ((e as { status?: number }).status === 404) return null;
    throw e;
  }
}

const action = async (id: string, what: string, body: unknown) => {
  const { item } = await api<{ item: HuddleItem }>(`/api/huddle/${encodeURIComponent(id)}/${what}`, { method: 'POST', body: JSON.stringify(body) });
  replace(item);
  void refreshCounts();
  return item;
};

/** One vote per person: voting for an option moves your vote there. */
export const vote = (itemId: string, optionId: string) => action(itemId, 'vote', { optionId });
export const addComment = (itemId: string, text: string) => action(itemId, 'comments', { text });
export const markNeedsInput = (itemId: string) => action(itemId, 'needs-input', {});
/** The domain's decider decides (the server checks). The decision and its reason are kept with the item. */
export const decide = (itemId: string, optionId: string, reason: string, expiresAt?: string) => action(itemId, 'decide', { optionId, reason, expiresAt: expiresAt || undefined });
/** Answers a concern; it closes (or stays in follow-up while actions are open). */
export const answerConcern = (itemId: string, text: string) => action(itemId, 'answer', { text });
export const addAction = (itemId: string, input: { title: string; ownerId: string; dueAt?: string; link?: string }) => action(itemId, 'actions', input);
export const completeAction = (itemId: string, actionId: string) => action(itemId, `actions/${encodeURIComponent(actionId)}/done`, {});

export interface HuddlePerson {
  id: string;
  name: string;
  initials: string;
  roles: string[];
}
/** The application's people, for an action's owner. */
export async function fetchPeople(): Promise<HuddlePerson[]> {
  return (await api<{ people: HuddlePerson[] }>('/api/huddle/people')).people;
}

/** "Raise with the team" from a finished answer: a Concern with the question, the answer's opening and its sources. */
export async function raiseFromChat(input: { chatId: string; messageId: string; title: string; note?: string }): Promise<{ item: HuddleItem; already: boolean }> {
  const r = await api<{ item: HuddleItem; already: boolean }>('/api/huddle/from-chat', { method: 'POST', body: JSON.stringify(input) });
  replace(r.item);
  void refreshCounts();
  return r;
}

/** Raises an item for the team (any kind but a source conflict, which comes from App Context). */
export async function raiseItem(input: {
  kind: Exclude<HuddleKind, 'conflict'>;
  domain?: HuddleDomain;
  title: string;
  summary: string;
  options: string[];
  severity?: 'critical' | 'high' | 'medium' | 'low';
  dueAt?: string;
  expiresAt?: string;
  links?: { type: string; ref: string; label?: string }[];
  affects?: { label: string; href?: string }[];
}): Promise<HuddleItem> {
  const { item } = await api<{ item: HuddleItem }>('/api/huddle', { method: 'POST', body: JSON.stringify(input) });
  replace(item);
  void loadHuddle(true);
  return item;
}
