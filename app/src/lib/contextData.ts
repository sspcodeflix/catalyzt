/**
 * App Context store: the sources Horizon uses for one application. In-memory stand-in for the
 * API; each exported action maps to one endpoint. All names are placeholders.
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

export const workspaces = ['App-abcd-web-ui', 'App-abcd-api', 'App-abcd-batch'];

export const statusLabel: Record<SourceStatus, { label: string; tone: string }> = {
  ready: { label: 'Ready', tone: 'pass' },
  indexed: { label: 'Indexed', tone: 'pass' },
  review: { label: 'Needs review', tone: 'warn' },
  processing: { label: 'Processing', tone: 'info' },
  failed: { label: 'Failed', tone: 'crit' },
};

const seed: Source[] = [
  { id: 'fabric', icon: 'fabric', title: 'Enterprise Knowledge Fabric', sub: 'Payments Hub space · 214 sections', type: 'Fabric', scope: 'App', trust: 'Highest', status: 'ready', content: '214 sections', updated: 'Synced 2 h ago', readOnly: true },
  { id: 'payout-rules', icon: 'link', title: 'Payout validation rules', sub: 'confluence.example.com/ABCD/3311', type: 'Confluence', scope: 'App', trust: 'High', status: 'ready', content: '31 chunks', updated: 'rev 31 · today' },
  { id: 'jira-uat', icon: 'apps', title: 'Jira · project PAY', sub: 'filter: status = "Ready for UAT" · synced every 15 min · last sync 10:30', type: 'Jira', scope: 'App', trust: 'Tickets', status: 'ready', content: '12 tickets', updated: 'Last sync 10:30', href: '/tickets' },
  { id: 'pay-hub-automation', icon: 'branch', title: 'pay-hub-automation', sub: 'GitHub · discovered · @9f3e1c2', type: 'Repository', scope: 'App-abcd-web-ui', trust: 'Code', status: 'indexed', content: '1,240 files', updated: '10 min ago' },
  { id: 'pay-hub-web', icon: 'branch', title: 'pay-hub-web', sub: 'GitHub · discovered · @71c0a9e', type: 'Repository', scope: 'App-abcd-web-ui', trust: 'Code', status: 'indexed', content: '3,410 files', updated: '10 min ago' },
  { id: 'pay-hub-api', icon: 'branch', title: 'pay-hub-api', sub: 'GitHub · discovered · @c44d201', type: 'Repository', scope: 'App-abcd-api', trust: 'Code', status: 'indexed', content: '2,086 files', updated: '1 h ago' },
  { id: 'pay-hub-contracts', icon: 'branch', title: 'pay-hub-contracts', sub: 'GitHub · discovered · @08be3f4', type: 'Repository', scope: 'App-abcd-api', trust: 'Code', status: 'indexed', content: '188 files', updated: '1 h ago' },
  { id: 'legacy-batch', icon: 'codeic', title: 'legacy-batch.zip', sub: 'ZIP upload · Omar K. · sha256 4be1…', type: 'Repository', scope: 'App-abcd-batch', trust: 'Code', status: 'indexed', content: '312 files', updated: '2 days ago', addedBy: 'Omar K.' },
  { id: 'refund-limits', icon: 'doc', title: 'Refund limits 2026.pdf', sub: '18 pages · Priya N.', type: 'PDF', scope: 'App', trust: 'Team upload', status: 'review', content: '42 chunks', updated: 'Today 10:12', addedBy: 'Priya N.', excludedChunks: 2 },
  { id: 'onboarding-faq', icon: 'word', title: 'Merchant onboarding FAQ.docx', sub: '9 pages · Omar K.', type: 'Word', scope: 'App-abcd-web-ui', trust: 'Team upload', status: 'ready', content: '23 chunks', updated: 'Yesterday', addedBy: 'Omar K.' },
  { id: 'refund-flow', icon: 'img', title: 'Refund screen flow.png', sub: 'Image · Priya N.', type: 'Image', scope: 'App-abcd-web-ui', trust: 'Team upload', status: 'processing', stage: 4, content: 'Text extracted', updated: 'Today 10:20', addedBy: 'Priya N.' },
  { id: 'chargeback-guide', icon: 'link', title: 'Chargeback handling guide', sub: 'confluence.example.com/ABCD/2970', type: 'Confluence', scope: 'App', trust: 'High', status: 'ready', content: '18 chunks', updated: 'rev 12 · last week' },
  { id: 'settlement-calendar', icon: 'doc', title: 'Settlement calendar 2026.pdf', sub: '4 pages · Sara R.', type: 'PDF', scope: 'App-abcd-api', trust: 'Team upload', status: 'ready', content: '9 chunks', updated: 'Last week', addedBy: 'Sara R.' },
  { id: 'iban-rules', icon: 'word', title: 'IBAN validation notes.docx', sub: '3 pages · Omar K.', type: 'Word', scope: 'App-abcd-api', trust: 'Team upload', status: 'ready', content: '6 chunks', updated: '2 weeks ago', addedBy: 'Omar K.' },
  { id: 'old-fees', icon: 'doc', title: 'Old fee schedule.pdf', sub: 'Password protected · Omar K.', type: 'PDF', scope: 'App', trust: 'Team upload', status: 'failed', content: 'Could not open', updated: '3 days ago', addedBy: 'Omar K.', failReason: 'The PDF is password protected. Upload a copy without a password.' },
];

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

let state: State = {
  sources: seed,
  conflict: {
    sourceId: 'refund-limits',
    huddleItemId: 'refund-window',
    title: 'Refund limits 2026.pdf conflicts with the Enterprise Knowledge Fabric.',
    detail:
      'Page 4 says partial refunds are allowed for 30 days; Fabric section Refunds §3.2 says 45 days. Horizon keeps using the Fabric and leaves these 2 chunks out until someone decides.',
    compare: [
      { label: 'Refund limits 2026.pdf', value: '30 days', where: 'Page 4 · from the transaction date · team upload' },
      { label: 'Enterprise Knowledge Fabric', value: '45 days', where: 'Refunds §3.2 v14 · from settlement · highest trust' },
    ],
  },
  notice: '',
};

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
const chunks: Chunk[] = [
  { sourceId: 'fabric', where: 'Fabric · Refunds §3.2 · v14', text: 'Partial refunds may be requested within 45 days of settlement. The total of all partial refunds must not exceed the original amount.' },
  { sourceId: 'fabric', where: 'Fabric · Payouts §2.1 · v14', text: 'Payouts are released daily at 18:00 for settled transactions. IBAN checksum must be validated before a payout is created.' },
  { sourceId: 'payout-rules', where: 'Confluence · Payout validation rules · rev 31', text: 'Refunds to a closed account are returned to the merchant settlement account within 2 working days.' },
  { sourceId: 'refund-limits', where: 'Refund limits 2026.pdf · page 4', text: 'Partial refunds are allowed for 30 days after the transaction date.' },
  { sourceId: 'onboarding-faq', where: 'Merchant onboarding FAQ.docx · page 2', text: 'A merchant can request a refund from the portal once the payment is settled.' },
  { sourceId: 'chargeback-guide', where: 'Confluence · Chargeback handling guide · rev 12', text: 'A chargeback blocks any further refunds on the same payment until it is resolved.' },
  { sourceId: 'jira-uat', where: 'Jira · PAY-1482', text: 'As a merchant I can issue a partial refund up to the remaining refundable amount. Ready for UAT.' },
  { sourceId: 'iban-rules', where: 'IBAN validation notes.docx · page 1', text: 'Reject payouts when the IBAN checksum is invalid; format alone is not enough.' },
];

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
