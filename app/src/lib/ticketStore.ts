/**
 * Jira stories, from the server, for the application the session is looking at. The server's
 * SQLite database is the dummy Jira; in production the server syncs from Jira with a read-only
 * service account using the filter shown here. UAT state per story is kept for this session.
 */
import { useSyncExternalStore } from 'react';

import { http, sessionEpoch, StaleScopeError } from './session';
import type { CriterionStatus, JiraSync, Refined, StoryDraft, StoryStatus, Ticket, UatState } from './types';
import { summariseCoverage } from './uat';

type ServerStory = Omit<Ticket, 'uat'>;
interface ServerFilter {
  project: string;
  statuses: StoryStatus[];
  everyMinutes: number;
  lastSyncAt: string;
}

let stories: ServerStory[] = [];
/** UAT results by story key, for this session. */
const uat = new Map<string, Ticket['uat']>();
/** Stories opened directly that the filter hides, cached so their panel can show them. */
const extra = new Map<string, ServerStory>();

let tickets: Ticket[] = [];
const blank = (): JiraSync => ({ project: '', filter: '', statuses: [], everyMinutes: 15, lastSync: new Date().toISOString(), syncing: false, loaded: false, error: null });
let sync: JiraSync = blank();

const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

const withUat = (s: ServerStory): Ticket => ({
  ...s,
  uat: uat.get(s.key) ?? { state: 'not-analysed' as UatState, covered: 0, total: s.acceptanceCriteria.length },
});

const jql = (f: ServerFilter) => `project = ${f.project} AND status in (${f.statuses.map((s) => `"${s}"`).join(', ')})`;

function apply(b: { stories: ServerStory[]; filter: ServerFilter }) {
  stories = b.stories;
  tickets = stories.map(withUat);
  sync = { ...sync, project: b.filter.project, statuses: b.filter.statuses, everyMinutes: b.filter.everyMinutes, lastSync: b.filter.lastSyncAt, filter: jql(b.filter), syncing: false, loaded: true, error: null };
  emit();
}

const StaleScope = StaleScopeError;

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const epoch = sessionEpoch();
  const res = await http(url, { ...init, headers: { 'Content-Type': 'application/json', ...((init?.headers as Record<string, string> | undefined) ?? {}) } });
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  // A response that belongs to an earlier person or application is not applied.
  if (epoch !== sessionEpoch()) throw new StaleScope();
  if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status}).`);
  return body;
}

let loading: Promise<void> | null = null;
/** Loads stories once per session; later calls reuse the first load. */
export function loadStories(): Promise<void> {
  loading ??= call<{ stories: ServerStory[]; filter: ServerFilter }>('/api/stories')
    .then(apply)
    .catch((e: Error) => {
      if (e instanceof StaleScope) return;
      loading = null;
      sync = { ...sync, loaded: true, error: e.message };
      emit();
    });
  return loading;
}

/** A new sign-in or application: forget this session's stories and load again. */
function reset() {
  loading = null;
  stories = [];
  tickets = [];
  uat.clear();
  extra.clear();
  sync = blank();
  emit();
  void loadStories();
}

if (typeof window !== 'undefined') window.addEventListener('hz:session', reset);

export const useTickets = () => useSyncExternalStore(subscribe, () => tickets);
export const useJiraSync = () => useSyncExternalStore(subscribe, () => sync);
export const getTicket = (key: string): Ticket | undefined => {
  const s = stories.find((t) => t.key === key) ?? extra.get(key);
  return s ? withUat(s) : undefined;
};
export const getTickets = () => tickets;

/** Fetches one story even if the filter hides it. */
export async function fetchStory(key: string): Promise<Ticket | undefined> {
  try {
    const { story } = await call<{ story: ServerStory }>(`/api/stories/${encodeURIComponent(key)}`);
    extra.set(key, story);
    emit();
    return withUat(story);
  } catch {
    return undefined;
  }
}

export async function syncNow() {
  if (sync.syncing) return;
  sync = { ...sync, syncing: true };
  emit();
  try {
    apply(await call('/api/jira/sync', { method: 'POST' }));
  } catch (e) {
    if (e instanceof StaleScope) return;
    sync = { ...sync, syncing: false, error: (e as Error).message };
    emit();
  }
}

export async function setJiraFilter(statuses: StoryStatus[], everyMinutes: number) {
  apply(await call('/api/jira/filter', { method: 'PUT', body: JSON.stringify({ statuses, everyMinutes }) }));
}

export async function refineStory(draft: StoryDraft): Promise<Refined> {
  return call<Refined>('/api/stories/refine', { method: 'POST', body: JSON.stringify(draft) });
}

/** Creates a story in the dummy Jira. Returns it, and whether the current filter shows it. */
export async function createStory(
  draft: StoryDraft & { original: { summary: string; description: string; acceptanceCriteria: string } | null; refinementId: number | null },
): Promise<{ story: Ticket; visible: boolean }> {
  const r = await call<{ story: ServerStory; visible: boolean }>('/api/stories', { method: 'POST', body: JSON.stringify(draft) });
  extra.set(r.story.key, r.story);
  apply(await call('/api/stories'));
  return { story: withUat(r.story), visible: r.visible };
}

/** Records the result of a UAT analysis on the story, so the list shows it. */
export function recordUatAnalysis(key: string, chatId: string, statuses: CriterionStatus[]) {
  uat.set(key, { ...summariseCoverage(statuses), chatId });
  tickets = stories.map(withUat);
  emit();
}
