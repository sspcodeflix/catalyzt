/**
 * App Context store: the sources Horizon uses for one application. In-memory stand-in for the
 * API, being replaced by a server-backed store (phase 3). No placeholder data.
 */
import { useSyncExternalStore } from 'react';

import type { IconName } from '../components/icons';

export type SourceType = 'Fabric' | 'Confluence' | 'Jira' | 'Repository' | 'PDF' | 'Word' | 'Image';
export type SourceStatus = 'ready' | 'indexed' | 'review' | 'processing' | 'failed';
/** Trust order: Fabric > Confluence > Jira > team uploads. Code is ranked separately. */
export type Trust = 'Highest' | 'High' | 'Tickets' | 'Code' | 'Team upload';
export type ScopeKind = 'app' | 'workspace' | 'chat';

export interface Source {
  id: string;
  icon: IconName;
  title: string;
  sub: string;
  type: SourceType;
  /** 'App' for the whole app, otherwise a workspace id such as App-abcd-web-ui. */
  scope: string;
  trust: Trust;
  status: SourceStatus;
  /** Index into processingSteps while status is 'processing'. */
  stage?: number;
  content: string;
  updated: string;
  addedBy?: string;
  failReason?: string;
  /** Rows that open somewhere other than the source panel (e.g. Jira opens the ticket list). */
  href?: string;
  readOnly?: boolean;
  excludedChunks?: number;
}

export const processingSteps = [
  'Uploaded',
  'Text extracted',
  'Personal data masked',
  'Split into chunks',
  'Embedding',
  'Conflict check',
  'Ready to use',
] as const;

/** Admin settings, not constants in the product (DESIGN.md). Values here are placeholders. */
export const adminSettings = { maxUploadMb: 50 };

export const workspaces: string[] = [];

export const statusLabel: Record<SourceStatus, { label: string; tone: string }> = {
  ready: { label: 'Ready', tone: 'pass' },
  indexed: { label: 'Indexed', tone: 'pass' },
  review: { label: 'Needs review', tone: 'warn' },
  processing: { label: 'Processing', tone: 'info' },
  failed: { label: 'Failed', tone: 'crit' },
};

/** No seeded sources: the server-backed store (phase 3) lists the repositories and knowledge base of the application. */
const seed: Source[] = [];

/** The open conflict between a team upload and a higher-trust source. */
export interface Conflict {
  sourceId: string;
  huddleItemId: string;
  title: string;
  detail: string;
  compare: { label: string; value: string; where: string }[];
}

interface State {
  sources: Source[];
  conflict: Conflict | null;
  /** Latest announcement for screen readers and the status line. */
  notice: string;
}

let state: State = { sources: seed, conflict: null, notice: '' };

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

/* ---------- Simulated processing ---------- */

let timer: ReturnType<typeof setInterval> | null = null;

function tick() {
  let finished: Source | undefined;
  const sources = state.sources.map((s) => {
    if (s.status !== 'processing') return s;
    const stage = (s.stage ?? 0) + 1;
    if (stage >= processingSteps.length - 1) {
      finished = s;
      const done: Source = {
        ...s,
        stage: undefined,
        status: s.type === 'Repository' ? 'indexed' : 'ready',
        content: s.type === 'Repository' ? 'Indexed' : `${8 + (s.title.length % 30)} chunks`,
        updated: 'Just now',
      };
      return done;
    }
    return { ...s, stage, content: processingSteps[stage] };
  });
  set({ sources, notice: finished ? `${finished.title} is ready and used in every answer for its scope.` : state.notice });
  if (!sources.some((s) => s.status === 'processing') && timer) {
    clearInterval(timer);
    timer = null;
  }
}

function ensureProcessing() {
  if (!timer && state.sources.some((s) => s.status === 'processing')) timer = setInterval(tick, 1100);
}
ensureProcessing();

/* ---------- Actions ---------- */

const ext = (name: string) => name.split('.').pop()?.toLowerCase() ?? '';
const typeFor = (name: string): { type: SourceType; icon: IconName } | null => {
  const e = ext(name);
  if (e === 'pdf') return { type: 'PDF', icon: 'doc' };
  if (e === 'doc' || e === 'docx') return { type: 'Word', icon: 'word' };
  if (['png', 'jpg', 'jpeg'].includes(e)) return { type: 'Image', icon: 'img' };
  if (e === 'zip') return { type: 'Repository', icon: 'codeic' };
  return null;
};

export const acceptedFileTypes = '.pdf,.doc,.docx,.png,.jpg,.jpeg,.zip';

const scopeValue = (kind: ScopeKind, workspace: string) => (kind === 'workspace' ? workspace : 'App');

const time = () => new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });

/** Returns one message per rejected file; accepted files start processing. */
export function addFiles(files: File[], kind: ScopeKind, workspace: string, by: string): string[] {
  const errors: string[] = [];
  const added: Source[] = [];
  for (const f of files) {
    const t = typeFor(f.name);
    if (!t) {
      errors.push(`${f.name}: this file type isn't supported. Use PDF, Word, PNG, JPG or ZIP.`);
      continue;
    }
    if (f.size > adminSettings.maxUploadMb * 1024 * 1024) {
      errors.push(`${f.name} is over the ${adminSettings.maxUploadMb} MB limit set by your admin.`);
      continue;
    }
    added.push({
      id: `${Date.now().toString(36)}-${added.length}-${f.name.replace(/\W+/g, '-').toLowerCase()}`,
      icon: t.icon,
      title: f.name,
      sub: `${t.type === 'Repository' ? 'ZIP upload' : t.type} · ${by}`,
      type: t.type,
      scope: scopeValue(kind, workspace),
      trust: t.type === 'Repository' ? 'Code' : 'Team upload',
      status: 'processing',
      stage: 0,
      content: processingSteps[0],
      updated: `Today ${time()}`,
      addedBy: by,
    });
  }
  if (kind === 'chat') {
    // Chat-only files are not added to the app (DESIGN.md). TODO: attach them to the user's next chat.
    if (added.length) set({ notice: `${added.length} file${added.length > 1 ? 's' : ''} will be used in your next chat only, not added to the app.` });
    return errors;
  }
  if (added.length) {
    set({ sources: [...added, ...state.sources], notice: `Processing ${added.map((a) => a.title).join(', ')}.` });
    ensureProcessing();
  }
  return errors;
}

/** Returns an error message, or null when the page was added. */
export function addConfluence(url: string, kind: ScopeKind, workspace: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return 'Paste a full link that starts with https://';
  }
  if (parsed.protocol !== 'https:') return 'Paste a full link that starts with https://';
  if (kind === 'chat') {
    set({ notice: 'This page will be used in your next chat only, not added to the app.' });
    return null;
  }
  const s: Source = {
    id: `${Date.now().toString(36)}-confluence`,
    icon: 'link',
    title: decodeURIComponent(parsed.pathname.split('/').filter(Boolean).pop() ?? parsed.host).replace(/[+-]/g, ' '),
    sub: `${parsed.host}${parsed.pathname}`,
    type: 'Confluence',
    scope: scopeValue(kind, workspace),
    trust: 'High',
    status: 'processing',
    stage: 0,
    content: processingSteps[0],
    updated: `Today ${time()}`,
  };
  set({ sources: [s, ...state.sources], notice: `Reading ${s.sub} with your Confluence access.` });
  ensureProcessing();
  return null;
}

export function syncSource(id: string) {
  set({
    sources: state.sources.map((s) => (s.id === id ? { ...s, updated: `Synced ${time()}` } : s)),
    notice: `${getSource(id)?.title ?? 'Source'} synced.`,
  });
}

/**
 * Called when the Huddle decides the conflict. Keeping the higher-trust source leaves the
 * conflicting chunks out; using the upload re-includes them.
 */
export function resolveConflict(sourceId: string, keepUpload: boolean) {
  if (state.conflict?.sourceId !== sourceId) return;
  set({
    conflict: null,
    sources: state.sources.map((s) =>
      s.id === sourceId
        ? { ...s, status: 'ready', excludedChunks: keepUpload ? 0 : s.excludedChunks, updated: `Decided ${time()}` }
        : s,
    ),
    notice: keepUpload ? 'Conflict decided: the excluded chunks are used again.' : 'Conflict decided: the conflicting chunks stay excluded.',
  });
}

/* ---------- Test a question ---------- */

export interface Chunk {
  sourceId: string;
  where: string;
  text: string;
}

/** A small sample of chunks; the real ranking is vector search on the server. */
const chunks: Chunk[] = [];

export interface RankedChunk extends Chunk {
  relevance: number;
  used: boolean;
  reason?: string;
}

const words = (s: string) => s.toLowerCase().match(/[a-z0-9]+/g)?.filter((w) => w.length > 2) ?? [];

/** Top 3 chunks for a question, with whether each would be used. Relevance is not correctness. */
export function testQuestion(q: string): RankedChunk[] {
  const qw = new Set(words(q));
  if (!qw.size) return [];
  return chunks
    .map((c) => {
      const cw = words(c.text + ' ' + c.where);
      const hits = cw.filter((w) => qw.has(w)).length;
      return { c, score: hits / Math.sqrt(cw.length + 1) };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map(({ c, score }) => {
      const src = getSource(c.sourceId);
      const conflicted = state.conflict?.sourceId === c.sourceId || (src?.excludedChunks ?? 0) > 0;
      const unavailable = src?.status === 'failed' || src?.status === 'processing';
      return {
        ...c,
        relevance: Math.min(0.99, 0.5 + score * 0.6),
        used: !conflicted && !unavailable,
        reason: conflicted ? 'Excluded: unresolved conflict' : unavailable ? 'Excluded: not ready' : undefined,
      };
    });
}
