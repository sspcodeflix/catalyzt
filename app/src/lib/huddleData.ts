/**
 * Huddle store: decisions Horizon won't make on its own. In-memory stand-in for the API, being
 * replaced by a server-backed store (phase 3). No placeholder data.
 */
import { useSyncExternalStore } from 'react';

import type { IconName } from '../components/icons';
import type { Citation } from './types';
import { resolveConflict } from './contextData';
import { getSession } from './session';

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

/** The acting person, from the session (interim, until this store moves to the server). */
const sessionMe = (): Person & { role: 'owner' | 'member' } => {
  const m = getSession().me;
  return { initials: m?.user.initials ?? '?', name: m?.user.name ?? 'Unknown', role: m?.app?.roles.includes('app_owner') ? 'owner' : 'member' };
};
export const me = new Proxy({} as Person & { role: 'owner' | 'member' }, { get: (_t, k) => sessionMe()[k as keyof ReturnType<typeof sessionMe>] });

export interface HuddleOption {
  id: string;
  title: string;
  detail: string;
  /** Initials of the people who voted for this option. Votes are advisory (open question 6). */
  votes: string[];
  /** For conflicts: true when choosing this option means using the team upload. */
  keepsUpload?: boolean;
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
  raisedAt: string;
  scope: string;
  people: string[];
  /** Label shown while open, e.g. "Needs a decision" or "Security sign-off". */
  openLabel: string;
  openTone: string;
  /** Horizon's summary of both sides; [n] markers refer to citations. */
  aiSummary: string;
  citations: Citation[];
  affects: { label: string; href?: string }[];
  options: HuddleOption[];
  comments: HuddleComment[];
  needsInput?: boolean;
  /** Links a source conflict back to App Context. */
  sourceId?: string;
  decision?: { optionId: string; reason: string; at: string; by: string };
}

/** No seeded items: Huddle fills only with what people and agents raise. Server-backed store follows in phase 3. */
const seed: HuddleItem[] = [];

let items: HuddleItem[] = seed;
const listeners = new Set<() => void>();
const set = (next: HuddleItem[]) => {
  items = next;
  listeners.forEach((l) => l());
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export const useHuddle = () => useSyncExternalStore(subscribe, () => items);

const updateItem = (id: string, fn: (i: HuddleItem) => HuddleItem) => set(items.map((i) => (i.id === id ? fn(i) : i)));

const now = () => new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });

/** One vote per person: voting for an option moves your vote there. */
export function vote(itemId: string, optionId: string) {
  updateItem(itemId, (i) => ({
    ...i,
    options: i.options.map((o) => {
      const without = o.votes.filter((v) => v !== me.initials);
      return o.id === optionId ? { ...o, votes: [...without, me.initials] } : { ...o, votes: without };
    }),
  }));
}

export function addComment(itemId: string, text: string) {
  const t = text.trim();
  if (!t) return;
  updateItem(itemId, (i) => ({
    ...i,
    people: i.people.includes(me.initials) ? i.people : [...i.people, me.initials],
    comments: [...i.comments, { id: crypto.randomUUID(), who: { initials: me.initials, name: me.name }, at: now(), text: t }],
  }));
}

export function markNeedsInput(itemId: string) {
  updateItem(itemId, (i) => ({ ...i, needsInput: true }));
}

/** Only an app owner decides. The decision and its reason are kept with the item, and Horizon applies it. */
export function decide(itemId: string, optionId: string, reason: string) {
  if (me.role !== 'owner') throw new Error('Only an app owner can decide');
  if (!reason.trim()) throw new Error('A reason is required');
  const item = items.find((i) => i.id === itemId);
  const option = item?.options.find((o) => o.id === optionId);
  if (!item || !option || item.decision) return;
  updateItem(itemId, (i) => ({
    ...i,
    needsInput: false,
    decision: { optionId, reason: reason.trim(), at: `today ${now()}`, by: me.name },
  }));
  if (item.kind === 'conflict' && item.sourceId) resolveConflict(item.sourceId, !!option.keepsUpload);
}
