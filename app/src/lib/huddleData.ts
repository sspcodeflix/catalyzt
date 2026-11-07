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
}

interface State {
  items: HuddleItem[];
  loaded: boolean;
  error: string | null;
}

let state: State = { items: [], loaded: false, error: null };
const listeners = new Set<() => void>();
const set = (next: Partial<State>) => {
  state = { ...state, ...next };
  listeners.forEach((l) => l());
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export const useHuddle = () => useSyncExternalStore(subscribe, () => state.items);
export const useHuddleState = () => useSyncExternalStore(subscribe, () => state);

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const epoch = sessionEpoch();
  const res = await http(url, init?.body ? { ...init, headers: { 'Content-Type': 'application/json', ...((init.headers as Record<string, string> | undefined) ?? {}) } } : init);
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (epoch !== sessionEpoch()) throw new StaleScopeError();
  if (!res.ok) throw Object.assign(new Error(body.error ?? `Request failed (${res.status}).`), { status: res.status });
  return body;
}

let loading: Promise<void> | null = null;
export function loadHuddle(force = false): Promise<void> {
  if (loading && !force) return loading;
  loading = api<{ items: HuddleItem[] }>('/api/huddle')
    .then((b) => set({ items: b.items, loaded: true, error: null }))
    .catch((e: Error) => {
      if (e instanceof StaleScopeError) return;
      loading = null;
      set({ loaded: true, error: e.message });
    });
  return loading;
}

if (typeof window !== 'undefined') {
  window.addEventListener('hz:session', () => {
    loading = null;
    state = { items: [], loaded: false, error: null };
    listeners.forEach((l) => l());
    void loadHuddle();
  });
}

const replace = (item: HuddleItem) => set({ items: state.items.some((i) => i.id === item.id) ? state.items.map((i) => (i.id === item.id ? item : i)) : [item, ...state.items] });

/** One item, from memory or the server. Null when it does not exist in this application. */
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
  return item;
}
