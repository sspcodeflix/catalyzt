/**
 * App Context in the browser: a view of the server's sources for the selected application. Every
 * action is a server call; nothing is simulated here. Responses for an earlier person or
 * application are dropped (sessionEpoch).
 */
import { useSyncExternalStore } from 'react';

import type { IconName } from '../components/icons';
import { http, sessionEpoch, StaleScopeError } from './session';

export type SourceType = 'Repository' | 'Jira' | 'Confluence' | 'Text' | 'PDF' | 'Word' | 'Image' | 'ZIP' | 'File';
/** stored: kept, but Catalyzt cannot read it in this build. */
export type SourceStatus = 'ready' | 'indexed' | 'review' | 'processing' | 'failed' | 'stored';
/** Trust order: Confluence > Jira > code > team uploads. No Fabric is connected. */
export type Trust = 'High' | 'Tickets' | 'Code' | 'Team upload';
export type ScopeKind = 'app' | 'workspace';

export interface Source {
  id: string;
  type: SourceType;
  title: string;
  sub: string;
  /** 'App' for the whole application, otherwise the workspace name. */
  scope: string;
  trust: Trust;
  status: SourceStatus;
  content: string;
  note: string | null;
  href: string | null;
  addedBy: string | null;
  size: number | null;
  mime: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  syncedAt: string | null;
  chunks: number;
  excludedChunks: number;
  conflictId: string | null;
}

export interface Conflict {
  id: string;
  sourceId: string;
  sourceTitle: string;
  otherSourceId: string;
  otherTitle: string;
  huddleItemId: string | null;
  title: string;
  detail: string;
  compare: { label: string; value: string; where: string }[];
  status: 'open' | 'resolved';
  resolution: 'keep_higher' | 'use_upload' | null;
  createdAt: string;
}

export interface Chunk {
  id: string;
  seq: number;
  locator: string;
  text: string;
  excludedReason: string | null;
}

export interface RankedChunk {
  chunkId: string | null;
  sourceId: string | null;
  sourceTitle: string;
  where: string;
  text: string;
  relevance: number;
  used: boolean;
  reason: string | null;
  href: string | null;
}

export interface Connectors {
  confluence: string;
  fabric: string;
  jira: string;
  github: string;
}

export interface Limits {
  maxUploadMb: number;
  readable: string[];
  storedOnly: string[];
}

interface State {
  sources: Source[];
  conflicts: Conflict[];
  connectors: Connectors | null;
  limits: Limits | null;
  loaded: boolean;
  error: string | null;
  /** Latest announcement for screen readers and the status line. */
  notice: string;
}

const ICONS: Record<SourceType, IconName> = { Repository: 'codeic', Jira: 'doc', Confluence: 'link', Text: 'doc', PDF: 'doc', Word: 'word', Image: 'img', ZIP: 'codeic', File: 'clip' };
export const iconFor = (type: SourceType): IconName => ICONS[type] ?? 'doc';

export const statusLabel: Record<SourceStatus, { label: string; tone: string }> = {
  ready: { label: 'Ready', tone: 'pass' },
  indexed: { label: 'Indexed', tone: 'pass' },
  review: { label: 'Needs review', tone: 'warn' },
  processing: { label: 'Processing', tone: 'info' },
  failed: { label: 'Failed', tone: 'crit' },
  stored: { label: 'Kept, not readable', tone: '' },
};

export const acceptedFileTypes = '.md,.markdown,.txt,.csv,.tsv,.json,.log,.xml,.yaml,.yml,.toml,.ini,.properties,.sql,.html,.feature,.pdf,.doc,.docx,.png,.jpg,.jpeg,.zip';

const empty = (): State => ({ sources: [], conflicts: [], connectors: null, limits: null, loaded: false, error: null, notice: '' });
let state: State = empty();
const listeners = new Set<() => void>();
const set = (next: Partial<State>) => {
  state = { ...state, ...next };
  listeners.forEach((l) => l());
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export const useContextStore = () => useSyncExternalStore(subscribe, () => state);
export const getSource = (id: string | undefined) => state.sources.find((s) => s.id === id);

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const epoch = sessionEpoch();
  const res = await http(url, init?.body ? { ...init, headers: { 'Content-Type': 'application/json', ...((init.headers as Record<string, string> | undefined) ?? {}) } } : init);
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (epoch !== sessionEpoch()) throw new StaleScopeError();
  if (!res.ok) throw Object.assign(new Error(body.error ?? `Request failed (${res.status}).`), { status: res.status });
  return body;
}

let loading: Promise<void> | null = null;
/** Loads the application's sources once; `force` reloads after a change. */
export function loadContext(force = false): Promise<void> {
  if (loading && !force) return loading;
  loading = api<{ sources: Source[]; conflicts: Conflict[]; connectors: Connectors; limits: Limits }>('/api/context')
    .then((b) => set({ sources: b.sources, conflicts: b.conflicts, connectors: b.connectors, limits: b.limits, loaded: true, error: null }))
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
    state = empty();
    listeners.forEach((l) => l());
  });
}

const toBase64 = (f: File) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] ?? '');
    r.onerror = () => reject(r.error ?? new Error('Could not read the file.'));
    r.readAsDataURL(f);
  });

/** Uploads files for the whole application or one workspace. Returns one message per refused file. */
export async function uploadFiles(files: File[], kind: ScopeKind, workspace: string): Promise<string[]> {
  const payload = await Promise.all(files.map(async (f) => ({ filename: f.name, contentBase64: await toBase64(f) })));
  try {
    const r = await api<{ sources: Source[]; errors: string[]; notice: string }>('/api/context/uploads', { method: 'POST', body: JSON.stringify({ files: payload, scope: kind, workspace }) });
    await loadContext(true);
    set({ notice: r.notice || (r.errors.length ? 'Nothing was added.' : '') });
    return r.errors;
  } catch (e) {
    if (e instanceof StaleScopeError) return [];
    return [(e as Error).message];
  }
}

/** Confluence is not connected in this build; the server says so. Returns the message. */
export async function addConfluence(url: string): Promise<string> {
  try {
    await api('/api/context/confluence', { method: 'POST', body: JSON.stringify({ url }) });
    return '';
  } catch (e) {
    return (e as Error).message;
  }
}

export async function syncSource(id: string): Promise<void> {
  try {
    const r = await api<{ source: Source; notice: string }>(`/api/context/sources/${encodeURIComponent(id)}/sync`, { method: 'POST', body: '{}' });
    await loadContext(true);
    set({ notice: r.notice });
  } catch (e) {
    if (!(e instanceof StaleScopeError)) set({ notice: (e as Error).message });
  }
}

export interface SourceDetail {
  source: Source;
  chunks: Chunk[];
  conflict: Conflict | null;
}

/** One source with its passages. Null when it does not exist in this application. */
export async function fetchSourceDetail(id: string): Promise<SourceDetail | null> {
  try {
    return await api<SourceDetail>(`/api/context/sources/${encodeURIComponent(id)}`);
  } catch (e) {
    if ((e as { status?: number }).status === 404) return null;
    throw e;
  }
}

export async function testQuestion(question: string): Promise<{ results: RankedChunk[]; considered: { passages: number; stories: number; tests: number } }> {
  return api('/api/context/test', { method: 'POST', body: JSON.stringify({ question }) });
}

export async function reportConflict(input: { sourceId: string; otherSourceId: string; title: string; detail: string; compare: { value: string; where: string }[] }): Promise<{ conflict: Conflict; huddleItemId: string }> {
  const r = await api<{ conflict: Conflict; huddleItemId: string }>('/api/context/conflicts', { method: 'POST', body: JSON.stringify(input) });
  await loadContext(true);
  return r;
}

export const TRUST_RANK: Record<Trust, number> = { High: 4, Tickets: 3, Code: 2, 'Team upload': 1 };
