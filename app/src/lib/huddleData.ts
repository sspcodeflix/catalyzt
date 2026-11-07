/**
 * Huddle store: decisions Horizon won't make on its own. In-memory stand-in for the API.
 * All names are placeholders.
 */
import { useSyncExternalStore } from 'react';

import type { IconName } from '../components/icons';
import type { Citation } from './types';
import { resolveConflict } from './contextData';

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

export const me: Person & { role: 'owner' | 'member' } = { initials: 'PN', name: 'Priya N.', role: 'owner' };

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

const seed: HuddleItem[] = [
  {
    id: 'refund-window',
    kind: 'conflict',
    title: 'Partial refund window: 30 or 45 days?',
    summary: 'Refund limits 2026.pdf disagrees with the Enterprise Knowledge Fabric. 2 chunks are excluded until decided.',
    raisedBy: 'Horizon',
    raisedAt: 'today 10:14',
    scope: 'Payments Hub · whole app',
    people: ['PN', 'OK', 'SR'],
    openLabel: 'Needs a decision',
    openTone: 'warn',
    aiSummary:
      'Refund limits 2026.pdf, page 4: 30 days from the transaction date [1]. Fabric, Refunds §3.2 v14: 45 days from settlement [2]. Affects FR-0231, 3 tests and 2 answers this week. Horizon uses the Fabric until this is decided.',
    citations: [
      { n: 1, title: 'Refund limits 2026.pdf', detail: 'page 4 · team upload by Priya N.' },
      { n: 2, title: 'Enterprise Knowledge Fabric', detail: 'Refunds §3.2 · v14' },
    ],
    affects: [
      { label: 'Refund limits 2026.pdf', href: '/context/source/refund-limits' },
      { label: 'FR-0231' },
      { label: '3 tests' },
      { label: '2 answers this week' },
    ],
    options: [
      { id: 'fabric', title: 'Keep the Fabric: 45 days from settlement', detail: 'Mark the PDF section as outdated.', votes: ['OK', 'SR'] },
      { id: 'doc', title: 'Use the document: 30 days, and ask the Fabric owners to update', detail: 'Tests for FR-0231 would change.', votes: ['JT'], keepsUpload: true },
      { id: 'both', title: 'Both are right for different products', detail: 'Record which product each rule applies to.', votes: [], keepsUpload: true },
    ],
    comments: [
      { id: 'c1', who: { initials: 'OK', name: 'Omar K.' }, at: '10:31', text: "The PDF is the 2026 draft from Risk. I don't think it's approved yet." },
      { id: 'c2', who: { initials: 'SR', name: 'Sara R.' }, at: '10:40', text: 'Agree. Keep 45 until Risk publishes it to the Fabric.' },
    ],
    sourceId: 'refund-limits',
  },
  {
    id: 'fr-0244-mapping',
    kind: 'mapping',
    title: 'FR-0244 is mapped to the wrong test',
    summary: 'Omar flagged that PayoutIbanTest checks the format, not the checksum the requirement asks for.',
    raisedBy: 'Omar K.',
    raisedAt: 'yesterday',
    scope: 'Payments Hub · App-abcd-api',
    people: ['OK', 'PN'],
    openLabel: 'Open',
    openTone: '',
    aiSummary:
      'FR-0244 requires the IBAN checksum to be validated before a payout [1]. PayoutIbanTest only asserts the IBAN format [2]. The mapping was made by name similarity. If it is removed, FR-0244 has no test.',
    citations: [
      { n: 1, title: 'FR-0244', detail: 'Fabric · Payouts §2.1 · v14' },
      { n: 2, title: 'PayoutIbanTest.java', detail: 'pay-hub-automation · line 31 · @9f3e1c2' },
    ],
    affects: [{ label: 'FR-0244' }, { label: 'PayoutIbanTest' }, { label: 'Coverage report S-023' }],
    options: [
      { id: 'remove', title: 'Remove the mapping', detail: 'FR-0244 shows as no test until one is written.', votes: ['OK'] },
      { id: 'keep', title: 'Keep the mapping', detail: 'The format check is enough for now.', votes: [] },
    ],
    comments: [{ id: 'c1', who: { initials: 'OK', name: 'Omar K.' }, at: 'yesterday 16:02', text: 'Line 31 only checks the length and country code.' }],
  },
  {
    id: 'cve-2026-07702',
    kind: 'risk',
    title: 'Accept CVE-2026-07702 until a fix exists',
    summary: 'No patched commons-text yet. Proposal: block untrusted interpolation input and review in 30 days.',
    raisedBy: 'Sara R.',
    raisedAt: '2 days ago',
    scope: 'Payments Hub · App-abcd-api',
    people: ['SR', 'JT'],
    openLabel: 'Security sign-off',
    openTone: 'high',
    aiSummary:
      'The dependency scan found CVE-2026-07702 in commons-text 1.10 [1]. No fixed version is published yet [2]. The vulnerable interpolation is reachable from one endpoint that takes merchant input.',
    citations: [
      { n: 1, title: 'Dependency scan', detail: 'pay-hub-api · today 06:10' },
      { n: 2, title: 'Advisory GHSA-xxxx', detail: 'no patched version listed' },
    ],
    affects: [{ label: 'pay-hub-api' }, { label: 'CVE-2026-07702' }],
    options: [
      { id: 'accept', title: 'Accept for 30 days with the mitigation', detail: 'Block untrusted interpolation input; review on expiry.', votes: ['SR'] },
      { id: 'reject', title: 'Do not accept', detail: 'Replace the library before the next release.', votes: [] },
    ],
    comments: [],
  },
  {
    id: 'naming-convention',
    kind: 'feedback',
    title: 'Generated tests ignore our naming convention',
    summary: '6 ratings below 4 this week chose "Ignores our conventions" for test authoring. Proposal: update the conventions skill.',
    raisedBy: 'Horizon',
    raisedAt: 'this week',
    scope: 'Payments Hub · whole app',
    people: ['JT'],
    openLabel: 'Open',
    openTone: '',
    aiSummary:
      '6 of 9 low ratings for test authoring this week chose "Ignores our conventions" [1]. Comments point at method names: the team uses given_when_then, Horizon writes camelCase sentences [2].',
    citations: [
      { n: 1, title: 'Feedback, test authoring', detail: 'this week · 9 ratings below 4' },
      { n: 2, title: 'CONTRIBUTING.md', detail: 'pay-hub-automation · Naming' },
    ],
    affects: [{ label: 'Skill selenium-java-pageobject' }, { label: '6 answers' }],
    options: [
      { id: 'update', title: 'Update the conventions skill', detail: 'New tests use given_when_then names.', votes: ['JT'] },
      { id: 'ignore', title: 'No change', detail: 'Names are fixed in review.', votes: [] },
    ],
    comments: [],
  },
  {
    id: 'settlement-cutoff',
    kind: 'conflict',
    title: 'Settlement cut-off: 17:00 or 18:00?',
    summary: 'Settlement calendar 2026.pdf said 17:00; the Fabric says 18:00.',
    raisedBy: 'Horizon',
    raisedAt: 'last week',
    scope: 'Payments Hub · App-abcd-api',
    people: ['SR', 'PN'],
    openLabel: 'Open',
    openTone: '',
    aiSummary: 'Settlement calendar 2026.pdf, page 2: 17:00 [1]. Fabric, Payouts §2.1 v14: 18:00 [2].',
    citations: [
      { n: 1, title: 'Settlement calendar 2026.pdf', detail: 'page 2' },
      { n: 2, title: 'Enterprise Knowledge Fabric', detail: 'Payouts §2.1 · v14' },
    ],
    affects: [{ label: 'Settlement calendar 2026.pdf', href: '/context/source/settlement-calendar' }],
    options: [
      { id: 'fabric', title: 'Keep the Fabric: 18:00', detail: 'Drop the conflicting chunk.', votes: ['SR', 'PN'] },
      { id: 'doc', title: 'Use the document: 17:00', detail: 'Ask the Fabric owners to update.', votes: [] },
    ],
    comments: [],
    decision: { optionId: 'fabric', reason: 'The PDF predates the v14 Fabric update.', at: 'last week', by: 'Priya N.' },
  },
  {
    id: 'cve-2026-05110',
    kind: 'risk',
    title: 'Accept CVE-2026-05110 in a test-only dependency',
    summary: 'Affects a test runner plugin that never ships to production.',
    raisedBy: 'Sara R.',
    raisedAt: '2 weeks ago',
    scope: 'Payments Hub · App-abcd-web-ui',
    people: ['SR'],
    openLabel: 'Open',
    openTone: '',
    aiSummary: 'The finding is in a plugin used only in CI [1]; it is not in the production image [2].',
    citations: [
      { n: 1, title: 'Dependency scan', detail: 'pay-hub-web · test scope' },
      { n: 2, title: 'Container scan', detail: 'pay-hub-web:24.11' },
    ],
    affects: [{ label: 'pay-hub-web' }],
    options: [
      { id: 'accept', title: 'Accept until the plugin is upgraded', detail: 'Review in 90 days.', votes: ['SR'] },
      { id: 'reject', title: 'Do not accept', detail: 'Upgrade now.', votes: [] },
    ],
    comments: [],
    decision: { optionId: 'accept', reason: 'Test scope only; not shipped.', at: '2 weeks ago', by: 'Priya N.' },
  },
];

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
