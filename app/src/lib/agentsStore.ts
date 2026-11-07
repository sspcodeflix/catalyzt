/**
 * Live agent activity from the server (GET /api/agents). Polls only while something on screen
 * is subscribed and the tab is visible.
 */
import { useSyncExternalStore } from 'react';

export interface AgentActivity {
  id: string;
  workflowRunId: string;
  parentId: string | null;
  parentAgent: string | null;
  agent: string;
  kind: string;
  task: string;
  status: 'running' | 'done' | 'failed' | 'rejected' | 'stopped';
  model: string | null;
  result: string | null;
  error: string | null;
  tokens: number | null;
  startedAt: string;
  endedAt: string | null;
  requestedBy: { id: string; name: string; initials: string };
  chat: { id: string; title: string } | null;
  steps: { seq: number; kind: 'rule' | 'model' | 'tool'; label: string; detail: string | null; status: 'running' | 'done' | 'failed' }[];
}

interface State {
  agents: AgentActivity[];
  loaded: boolean;
  error: string | null;
  at: string | null;
}

let state: State = { agents: [], loaded: false, error: null, at: null };
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | null = null;
const POLL_MS = 1500;

async function poll() {
  timer = null;
  if (listeners.size === 0) return;
  if (document.visibilityState === 'visible') {
    try {
      const r = await fetch('/api/agents');
      if (!r.ok) throw new Error(`Request failed (${r.status})`);
      const b = (await r.json()) as { agents: AgentActivity[]; at: string };
      state = { agents: b.agents, loaded: true, error: null, at: b.at };
    } catch (e) {
      state = { ...state, loaded: true, error: (e as Error).message };
    }
    listeners.forEach((l) => l());
  }
  if (listeners.size > 0) timer = setTimeout(poll, POLL_MS);
}

function subscribe(l: () => void) {
  listeners.add(l);
  if (!timer) void poll();
  return () => {
    listeners.delete(l);
    if (listeners.size === 0 && timer) {
      clearTimeout(timer);
      timer = null;
    }
  };
}

export const useAgentActivity = () => useSyncExternalStore(subscribe, () => state);

/* ---------- Token usage (GET /api/usage), refreshed every few seconds while shown ---------- */

export interface UsageTotals {
  calls: number;
  prompt: number;
  completion: number;
  total: number;
  /** Calls where the provider did not report tokens, such as stopped streams. */
  unreported: number;
}
export type UsageRow = UsageTotals & { key: string };
export interface Usage {
  allTime: UsageTotals;
  today: UsageTotals;
  byAgent: UsageRow[];
  byModel: UsageRow[];
  byUser: UsageRow[];
  byDay: UsageRow[];
}

let usage: Usage | null = null;
const usageListeners = new Set<() => void>();
let usageTimer: ReturnType<typeof setTimeout> | null = null;

async function pollUsage() {
  usageTimer = null;
  if (usageListeners.size === 0) return;
  if (document.visibilityState === 'visible') {
    try {
      const r = await fetch('/api/usage');
      if (r.ok) {
        usage = (await r.json()) as Usage;
        usageListeners.forEach((l) => l());
      }
    } catch {
      /* keep the last totals */
    }
  }
  if (usageListeners.size > 0) usageTimer = setTimeout(pollUsage, 4000);
}

function subscribeUsage(l: () => void) {
  usageListeners.add(l);
  if (!usageTimer) void pollUsage();
  return () => {
    usageListeners.delete(l);
    if (usageListeners.size === 0 && usageTimer) {
      clearTimeout(usageTimer);
      usageTimer = null;
    }
  };
}

export const useUsage = () => useSyncExternalStore(subscribeUsage, () => usage);
