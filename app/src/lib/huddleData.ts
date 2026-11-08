/**
 * Huddle in the browser: the server's decisions for the selected application. Votes, comments and
 * decisions are server calls; the item shown is what the server recorded. Responses for an
 * earlier person or application are dropped (sessionEpoch).
 */
import { useSyncExternalStore } from 'react';

import type { IconName } from '../components/icons';
import { getSession, http, sessionEpoch, StaleScopeError } from './session';
import type { Citation } from './types';

export type HuddleKind = 'conflict' | 'mapping' | 'risk' | 'feedback';

export const kindInfo: Record<HuddleKind, { label: string; icon: IconName }> = {
  conflict: { label: 'Source conflict', icon: 'warn' },
  mapping: { label: 'Disputed mapping', icon: 'target' },
  risk: { label: 'Risk acceptance', icon: 'shield' },
  feedback: { label: 'Feedback pattern', icon: 'star' },
};

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

export type HuddleFilter = 'open' | 'decided' | 'mine';
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
  query: { filter: HuddleFilter; q: string };
  /** Full items, read on demand when one is opened. */
  details: Record<string, HuddleItem>;
}

const EMPTY: State = { items: [], loaded: false, error: null, nextCursor: null, loadingMore: false, counts: { open: 0, decided: 0, mine: 0 }, query: { filter: 'open', q: '' }, details: {} };
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
}
const pageUrl = (query: State['query'], cursor?: string | null) => {
  const p = new URLSearchParams();
  if (query.filter === 'mine') p.set('mine', '1');
  else p.set('status', query.filter);
  if (query.q.trim()) p.set('q', query.q.trim());
  if (cursor) p.set('cursor', cursor);
  return `/api/huddle?${p}`;
};

let loading: Promise<void> | null = null;
let generation = 0;
/** Loads the first page for the current filter and search (or a new one). */
export function loadHuddle(force = false, query?: Partial<State['query']>): Promise<void> {
  const q = { ...state.query, ...(query ?? {}) };
  const changed = q.filter !== state.query.filter || q.q !== state.query.q;
  if (loading && !force && !changed) return loading;
  const gen = ++generation;
  if (changed) set({ query: q, loaded: false });
  loading = api<Page>(pageUrl(q))
    .then((b) => {
      if (gen !== generation) return;
      set({ items: b.items, nextCursor: b.nextCursor, counts: b.counts, loaded: true, error: null });
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
    set({ counts: b.counts });
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
/** Only an app owner decides (the server checks). The decision and its reason are kept with the item. */
export const decide = (itemId: string, optionId: string, reason: string) => action(itemId, 'decide', { optionId, reason });

/** Raises a decision for the team (mapping, risk or feedback; source conflicts come from App Context). */
export async function raiseItem(input: { kind: Exclude<HuddleKind, 'conflict'>; title: string; summary: string; options: string[]; affects?: { label: string; href?: string }[] }): Promise<HuddleItem> {
  const { item } = await api<{ item: HuddleItem }>('/api/huddle', { method: 'POST', body: JSON.stringify(input) });
  replace(item);
  void loadHuddle(true);
  return item;
}
