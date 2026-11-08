/**
 * Huddle, server side: the team's decisions across testing, reliability and security (docs/HUDDLE.md).
 * Items are raised by people or by Catalyzt's agents, carry a domain, a cited summary and ordered
 * options (a concern may have none and be answered instead), collect advisory votes and comments, and
 * are decided by the domain's decider with a reason. Decisions create follow-up actions with owners and
 * due dates; the item closes when they are all done. A risk or vulnerability acceptance has an expiry
 * and reopens when it passes. Everything is persisted per application; nothing here is placeholder data.
 */
import { randomUUID } from 'node:crypto';

import type { Citation } from '../src/lib/types';
import type { AppRecord, HorizonDb, Role } from './db';

export class HuddleError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export type HuddleKind = 'conflict' | 'mapping' | 'risk' | 'feedback' | 'concern' | 'decision' | 'change_review' | 'vulnerability' | 'incident_followup' | 'capacity_warning';
export const HUDDLE_KINDS: HuddleKind[] = ['concern', 'decision', 'risk', 'change_review', 'vulnerability', 'incident_followup', 'capacity_warning', 'conflict', 'mapping', 'feedback'];
export type HuddleDomain = 'testing' | 'reliability' | 'security' | 'knowledge' | 'process';
export const HUDDLE_DOMAINS: HuddleDomain[] = ['testing', 'reliability', 'security', 'knowledge', 'process'];
/** Where an item lands when its raiser names no domain. */
export const DEFAULT_DOMAIN: Record<HuddleKind, HuddleDomain> = {
  concern: 'testing',
  decision: 'testing',
  risk: 'testing',
  change_review: 'reliability',
  vulnerability: 'security',
  incident_followup: 'reliability',
  capacity_warning: 'reliability',
  conflict: 'knowledge',
  mapping: 'testing',
  feedback: 'process',
};
export type Severity = 'critical' | 'high' | 'medium' | 'low';
export const SEVERITIES: Severity[] = ['critical', 'high', 'medium', 'low'];
/** Default life of a vulnerability acceptance by severity, in days (docs/HUDDLE.md); a risk acceptance defaults to 30. */
export const EXPIRY_DAYS: Record<Severity, number> = { critical: 7, high: 30, medium: 90, low: 180 };
export const RISK_EXPIRY_DAYS = 30;
/** Kinds whose acceptance always carries an expiry and reopens when it passes. */
export const EXPIRING_KINDS: HuddleKind[] = ['risk', 'vulnerability'];
/** Where an item is in its life: open, needs input, decided, follow-up (open actions), closed. */
export type HuddleStage = 'open' | 'needs_input' | 'decided' | 'follow_up' | 'closed';
/** Entities an item can link to, beyond "affects" chips. */
export const LINK_TYPES = ['story', 'test', 'run', 'component', 'chat', 'cve', 'deployment'] as const;
export type HuddleLinkType = (typeof LINK_TYPES)[number];

export interface HuddleActionView {
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

export interface HuddleOptionView {
  id: string;
  title: string;
  detail: string;
  /** Initials of the people who voted for it. Votes are advisory. */
  votes: string[];
  keepsUpload: boolean;
  /** Choosing it accepts a risk, so the acceptance expires (risk and vulnerability items). */
  accepts: boolean;
}

export interface HuddleItemView {
  id: string;
  kind: HuddleKind;
  domain: HuddleDomain;
  stage: HuddleStage;
  severity: Severity | null;
  dueAt: string | null;
  expiresAt: string | null;
  /** Open past its due date, or with an open action past its due date. */
  overdue: boolean;
  /** Set when an accepted risk reopened at its expiry: what was accepted, by whom, until when. */
  reopenNote: string | null;
  /** A concern's answer; it closes the concern. */
  answer?: { text: string; by: string; at: string };
  actions: HuddleActionView[];
  /** Typed links: stories, tests, runs, components, chats, CVEs, deployments. */
  links: { type: HuddleLinkType; ref: string; label: string; href?: string }[];
  /** The asking person may decide (and answer, mark needs input) this item. */
  canDecide: boolean;
  /** Waiting on the asking person: theirs to decide, or they own an open action. */
  waitingOnMe: boolean;
  title: string;
  summary: string;
  raisedBy: string;
  raisedByType: 'user' | 'agent';
  raisedAt: string;
  scope: string;
  /** Initials of everyone involved: raiser (when a person), voters, commenters. */
  people: string[];
  openLabel: string;
  openTone: string;
  aiSummary: string;
  citations: Citation[];
  affects: { label: string; href?: string }[];
  options: HuddleOptionView[];
  comments: { id: string; who: { initials: string; name: string }; at: string; text: string }[];
  needsInput: boolean;
  sourceId: string | null;
  decision?: { optionId: string; reason: string; at: string; by: string };
  /** The option the asking person voted for. */
  myVote: string | null;
  /** R17: open items of the same kind about the same source, or with a near-identical title. Never merged. */
  similar: { id: string; title: string }[];
  /** True for the full item (GET /api/huddle/:id); list pages carry summaries without comments and citations. */
  detail: true;
}

/** A list entry: everything the list and its filters need, without the discussion and the cited summary. */
export type HuddleSummaryView = Omit<HuddleItemView, 'comments' | 'citations' | 'aiSummary' | 'detail'> & { commentCount: number; detail: false };

export interface NewHuddleItem {
  kind: HuddleKind;
  /** Defaults by kind (DEFAULT_DOMAIN). */
  domain?: HuddleDomain;
  severity?: Severity | null;
  dueAt?: string | null;
  /** Risk and vulnerability: until when an acceptance holds. Defaults by severity (vulnerability) or 30 days (risk). */
  expiresAt?: string | null;
  title: string;
  summary: string;
  scope: string;
  aiSummary: string;
  citations: Citation[];
  options: { title: string; detail: string; keepsUpload?: boolean; accepts?: boolean }[];
  affects: { label: string; href?: string }[];
  sourceId?: string | null;
  openLabel?: string;
  /** Extra links, for example a dedupe key ("feedback_pattern", "analysis|Wrong coverage"). */
  links?: { type: string; ref: string; label?: string; href?: string }[];
}

const OPEN_LABEL: Record<HuddleKind, { label: string; tone: string }> = {
  conflict: { label: 'Needs a decision', tone: 'warn' },
  mapping: { label: 'Needs a decision', tone: 'warn' },
  risk: { label: 'Risk acceptance', tone: 'warn' },
  feedback: { label: 'Pattern to review', tone: 'info' },
  concern: { label: 'Question for the team', tone: 'info' },
  decision: { label: 'Needs a decision', tone: 'warn' },
  change_review: { label: 'Change to review', tone: 'warn' },
  vulnerability: { label: 'Needs a plan', tone: 'high' },
  incident_followup: { label: 'Follow-up to plan', tone: 'info' },
  capacity_warning: { label: 'Capacity warning', tone: 'warn' },
};

type Row = Record<string, unknown>;
const now = () => new Date().toISOString();
const DAY = 86_400_000;
const addDays = (iso: string, days: number) => new Date(new Date(iso).getTime() + days * DAY).toISOString();
/** An ISO date or date-time as a full ISO timestamp; a plain date means the end of that day (UTC). Throws when unreadable. */
export function toIsoDate(v: string | null | undefined, what: string): string | null {
  if (v == null || v === '') return null;
  const s = String(v).trim();
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T23:59:59.000Z` : s);
  if (Number.isNaN(d.getTime())) throw new HuddleError(400, `${what} is not a date (use YYYY-MM-DD).`);
  return d.toISOString();
}
/** Option titles that read as accepting a risk ("Accept until…", not "Do not accept"). */
const looksAccepting = (t: string) => /\baccept/i.test(t) && !/\b(not|don't|do not|never|no)\b[^.]*\baccept/i.test(t);
const str = (v: unknown) => (typeof v === 'string' ? v : '');
const json = <T>(v: unknown, fallback: T): T => {
  try {
    return typeof v === 'string' ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
};

/** Creates an item with its options and links. `by` is a person (type user) or an agent name. */
export function createItem(db: HorizonDb, app: AppRecord, by: { type: 'user' | 'agent'; ref: string }, input: NewHuddleItem, at = now()): HuddleItemView {
  const title = input.title.trim().slice(0, 200);
  if (!title) throw new HuddleError(400, 'A title is required.');
  const options = (input.options ?? []).filter((o) => o.title.trim());
  // A concern can be answered instead of decided, so it may have no options; anything else chooses between two or more.
  if (input.kind === 'concern' ? options.length === 1 : options.length < 2)
    throw new HuddleError(400, input.kind === 'concern' ? 'A concern has no options (it is answered) or at least two.' : 'Give at least two options to choose between.');
  const domain = input.domain ?? DEFAULT_DOMAIN[input.kind];
  if (!HUDDLE_DOMAINS.includes(domain)) throw new HuddleError(400, `domain must be one of ${HUDDLE_DOMAINS.join(', ')}.`);
  const severity = input.severity ?? null;
  if (severity && !SEVERITIES.includes(severity)) throw new HuddleError(400, `severity must be one of ${SEVERITIES.join(', ')}.`);
  if (input.kind === 'vulnerability' && !severity) throw new HuddleError(400, 'A vulnerability needs a severity (critical, high, medium or low); it sets how long an acceptance may last.');
  const dueAt = toIsoDate(input.dueAt, 'dueAt');
  // Every acceptance has an end date (docs/HUDDLE.md): the one given, or by severity, or 30 days for a risk.
  let expiresAt = toIsoDate(input.expiresAt, 'expiresAt');
  if (EXPIRING_KINDS.includes(input.kind) && !expiresAt) expiresAt = addDays(at, input.kind === 'vulnerability' ? EXPIRY_DAYS[severity!] : RISK_EXPIRY_DAYS);
  const id = `hd-${randomUUID().slice(0, 8)}`;
  db.raw.transaction(() => {
    db.raw
      .prepare(
        `INSERT INTO huddle_items (id, application_id, kind, domain, title, summary, status, needs_input, raised_by_type, raised_by, created_at, scope, ai_summary, citations, source_id, severity, due_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, 'open', 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, app.id, input.kind, domain, title, input.summary.trim().slice(0, 2000), by.type, by.ref, at, input.scope.slice(0, 200), input.aiSummary.slice(0, 4000), JSON.stringify(input.citations ?? []), input.sourceId ?? null, severity, dueAt, expiresAt);
    const opt = db.raw.prepare('INSERT INTO huddle_options (id, item_id, label, detail, seq, keeps_upload, accepts) VALUES (?, ?, ?, ?, ?, ?, ?)');
    options.slice(0, 6).forEach((o, i) => {
      const label = o.title.trim().slice(0, 200);
      const accepts = EXPIRING_KINDS.includes(input.kind) && (o.accepts ?? looksAccepting(label));
      opt.run(`${id}-o${i + 1}`, id, label, (o.detail ?? '').trim().slice(0, 500), i + 1, o.keepsUpload ? 1 : 0, accepts ? 1 : 0);
    });
    const link = db.raw.prepare('INSERT OR IGNORE INTO huddle_links (item_id, entity_type, entity_ref, label, href) VALUES (?, ?, ?, ?, ?)');
    input.affects.slice(0, 12).forEach((a) => link.run(id, 'affects', (a.href ?? a.label).slice(0, 300), a.label.slice(0, 120), a.href ?? null));
    for (const l of (input.links ?? []).slice(0, 24)) {
      // A component named without its application is stored by its id, so its manager can be found.
      const ref = l.type === 'component' && !l.ref.includes('/') && db.raw.prepare('SELECT 1 FROM components WHERE id = ?').get(`${app.id}/${l.ref}`) ? `${app.id}/${l.ref}` : l.ref;
      link.run(id, l.type.slice(0, 40), ref.slice(0, 300), (l.label ?? '').slice(0, 120), l.href ?? null);
    }
    db.audit(by.type, by.ref, 'huddle.raise', 'huddle_item', id, { app: app.id, kind: input.kind, domain });
  })();
  return getItem(db, app.id, id, by.type === 'user' ? by.ref : null)!;
}

/* ---------- Who decides (docs/HUDDLE.md, "Who decides, by domain") ---------- */

/**
 * The SQL condition "the person may decide item i" for an item alias `i`, with its arguments.
 * Testing: the manager of a linked component (directly, or through a linked story) or an app owner.
 * Reliability: an sre_lead or an app owner. Security: a security_champion or an app owner.
 * Knowledge and process: an app owner. Votes never count.
 */
function deciderSql(userId: string, roles: Role[]): { sql: string; args: unknown[] } {
  if (roles.includes('app_owner')) return { sql: '1', args: [] };
  const parts: string[] = [];
  if (roles.includes('sre_lead')) parts.push("i.domain = 'reliability'");
  if (roles.includes('security_champion')) parts.push("i.domain = 'security'");
  parts.push(`(i.domain = 'testing' AND (
      EXISTS (SELECT 1 FROM huddle_links l JOIN components c ON c.id = l.entity_ref WHERE l.item_id = i.id AND l.entity_type = 'component' AND c.application_id = i.application_id AND c.manager_id = ?)
      OR EXISTS (SELECT 1 FROM huddle_links l JOIN stories s ON s.key = l.entity_ref AND s.application_id = i.application_id JOIN story_components sc ON sc.story_key = s.key
                 JOIN components c ON c.id = sc.component_id WHERE l.item_id = i.id AND l.entity_type = 'story' AND c.manager_id = ?)))`);
  return { sql: `(${parts.join(' OR ')})`, args: [userId, userId] };
}

/** "Waiting on me": open and mine to decide, or I own an open action on it. */
function waitingSql(userId: string, roles: Role[]) {
  const d = deciderSql(userId, roles);
  return { sql: `((i.status = 'open' AND ${d.sql}) OR EXISTS (SELECT 1 FROM huddle_actions a WHERE a.item_id = i.id AND a.status = 'open' AND a.owner_id = ?))`, args: [...d.args, userId] };
}

/** Whether the person may decide this item (and answer it, or ask for more input), whatever its status. */
export function canDecide(db: HorizonDb, app: string, itemId: string, userId: string): boolean {
  const d = deciderSql(userId, db.rolesFor(userId, app));
  return !!db.raw.prepare(`SELECT 1 FROM huddle_items i WHERE i.application_id = ? AND i.id = ? AND ${d.sql}`).get(app, itemId, ...d.args);
}

/** Who decides items of a domain, in words, for refusals and the panel. */
export const DECIDER_TEXT: Record<HuddleDomain, string> = {
  testing: 'the manager of an affected component or an app owner',
  reliability: 'an SRE lead or an app owner',
  security: 'a security champion or an app owner',
  knowledge: 'an app owner',
  process: 'an app owner',
};

/* ---------- Expiry (checked on read and list; no scheduler) ---------- */

/**
 * Accepted risks and vulnerabilities whose expiry has passed reopen: the decision moves into a note on
 * the item (what was accepted, by whom, why, until when), and the item is open again for a new
 * decision. Runs on every read and list of the application; one indexed query when nothing expired.
 */
export function reopenExpired(db: HorizonDb, app: string, at = now()) {
  const due = db.raw
    .prepare(
      `SELECT i.id, i.expires_at, d.reason, d.decided_at, o.label, u.name FROM huddle_items i
       JOIN huddle_decisions d ON d.item_id = i.id JOIN huddle_options o ON o.id = d.option_id LEFT JOIN users u ON u.id = d.decided_by
       WHERE i.application_id = ? AND i.status IN ('decided', 'closed') AND i.kind IN ('risk', 'vulnerability') AND o.accepts = 1 AND i.expires_at IS NOT NULL AND i.expires_at <= ?`,
    )
    .all(app, at) as Row[];
  if (!due.length) return 0;
  db.raw.transaction(() => {
    for (const r of due) {
      const note = `Accepted "${str(r.label)}" by ${str(r.name) || 'an owner'} on ${str(r.decided_at).slice(0, 10)} until ${str(r.expires_at).slice(0, 10)} (reason: ${str(r.reason)}). The acceptance expired, so this needs a new decision.`;
      db.raw.prepare('DELETE FROM huddle_decisions WHERE item_id = ?').run(r.id);
      db.raw.prepare("UPDATE huddle_items SET status = 'open', needs_input = 0, closed_at = NULL, reopened_at = ?, reopen_note = ?, updated_at = ? WHERE id = ?").run(at, note, at, r.id);
      db.audit('system', 'huddle', 'huddle.expired', 'huddle_item', str(r.id), { expiresAt: r.expires_at });
    }
  })();
  return due.length;
}

/* ---------- What every view adds: stage, actions, typed links, deciders ---------- */

const IN_IDS = 'IN (SELECT value FROM json_each(?))';

/** Reads, for a set of item rows, their actions, typed links, answerers and the asking person's rights, in a fixed number of queries. */
function extrasFor(db: HorizonDb, app: string, rows: Row[], userId: string | null) {
  const ids = JSON.stringify(rows.map((r) => str(r.id)));
  const t = now();
  const actions = db.raw
    .prepare(`SELECT a.*, u.name, u.initials, d.name AS done_name FROM huddle_actions a JOIN users u ON u.id = a.owner_id LEFT JOIN users d ON d.id = a.done_by WHERE a.item_id ${IN_IDS} ORDER BY a.created_at, a.rowid`)
    .all(ids) as Row[];
  const links = db.raw
    .prepare(`SELECT item_id, entity_type, entity_ref, label, href FROM huddle_links WHERE item_id ${IN_IDS} AND entity_type IN (${LINK_TYPES.map(() => '?').join(', ')}) ORDER BY rowid`)
    .all(ids, ...LINK_TYPES) as Row[];
  const answerers = db.raw.prepare(`SELECT id, name FROM users WHERE id IN (SELECT answered_by FROM huddle_items WHERE id ${IN_IDS})`).all(ids) as Row[];
  let deciders = new Set<string>();
  let waiting = new Set<string>();
  if (userId) {
    const roles = db.rolesFor(userId, app);
    const d = deciderSql(userId, roles);
    const w = waitingSql(userId, roles);
    deciders = new Set((db.raw.prepare(`SELECT i.id FROM huddle_items i WHERE i.id ${IN_IDS} AND ${d.sql}`).all(ids, ...d.args) as Row[]).map((r) => str(r.id)));
    waiting = new Set((db.raw.prepare(`SELECT i.id FROM huddle_items i WHERE i.id ${IN_IDS} AND ${w.sql}`).all(ids, ...w.args) as Row[]).map((r) => str(r.id)));
  }
  const answererBy = new Map(answerers.map((u) => [str(u.id), str(u.name)]));
  return (r: Row) => {
    const id = str(r.id);
    const acts: HuddleActionView[] = actions
      .filter((a) => a.item_id === id)
      .map((a) => ({
        id: str(a.id),
        title: str(a.title),
        owner: { id: str(a.owner_id), name: str(a.name), initials: str(a.initials) },
        dueAt: (a.due_at as string) ?? null,
        status: a.status as 'open' | 'done',
        link: (a.link as string) ?? null,
        overdue: a.status === 'open' && !!a.due_at && str(a.due_at) < t,
        doneAt: (a.done_at as string) ?? null,
        doneBy: (a.done_name as string) ?? null,
      }));
    const openActions = acts.filter((a) => a.status === 'open').length;
    const status = str(r.status);
    const stage: HuddleStage = status === 'closed' ? 'closed' : status === 'decided' ? (openActions ? 'follow_up' : 'decided') : Number(r.needs_input) === 1 ? 'needs_input' : 'open';
    const dueAt = (r.due_at as string) ?? null;
    return {
      domain: (str(r.domain) || DEFAULT_DOMAIN[r.kind as HuddleKind]) as HuddleDomain,
      stage,
      severity: (r.severity as Severity) ?? null,
      dueAt,
      expiresAt: (r.expires_at as string) ?? null,
      overdue: (status === 'open' && !!dueAt && dueAt < t) || acts.some((a) => a.overdue),
      reopenNote: (r.reopen_note as string) ?? null,
      answer: r.answer ? { text: str(r.answer), by: answererBy.get(str(r.answered_by)) ?? str(r.answered_by), at: str(r.answered_at) } : undefined,
      actions: acts,
      links: links
        .filter((l) => l.item_id === id)
        .map((l) => ({ type: l.entity_type as HuddleLinkType, ref: str(l.entity_ref), label: str(l.label) || str(l.entity_ref), href: (l.href as string) ?? undefined })),
      canDecide: deciders.has(id) && status === 'open',
      waitingOnMe: waiting.has(id),
    };
  };
}

function toView(db: HorizonDb, r: Row, userId: string | null): HuddleItemView {
  const id = str(r.id);
  const kind = r.kind as HuddleKind;
  const options = (db.raw.prepare('SELECT * FROM huddle_options WHERE item_id = ? ORDER BY seq, rowid').all(id) as Row[]).map((o) => ({
    id: str(o.id),
    title: str(o.label),
    detail: str(o.detail),
    votes: (db.raw.prepare('SELECT u.initials FROM huddle_votes v JOIN users u ON u.id = v.user_id WHERE v.item_id = ? AND v.option_id = ? ORDER BY v.rowid').all(id, o.id) as { initials: string }[]).map((x) => x.initials),
    keepsUpload: Number(o.keeps_upload) === 1,
    accepts: Number(o.accepts) === 1,
  }));
  const comments = (db.raw.prepare('SELECT c.id, c.text, c.created_at, u.name, u.initials FROM huddle_comments c JOIN users u ON u.id = c.user_id WHERE c.item_id = ? ORDER BY c.created_at, c.rowid').all(id) as Row[]).map((c) => ({
    id: str(c.id),
    who: { initials: str(c.initials), name: str(c.name) },
    at: str(c.created_at),
    text: str(c.text),
  }));
  const links = db.raw.prepare("SELECT entity_type, entity_ref, label, href FROM huddle_links WHERE item_id = ? AND entity_type = 'affects' ORDER BY rowid").all(id) as Row[];
  const dec = db.raw.prepare('SELECT d.option_id, d.reason, d.decided_at, u.name FROM huddle_decisions d JOIN users u ON u.id = d.decided_by WHERE d.item_id = ?').get(id) as Row | undefined;
  const raiser = r.raised_by_type === 'user' ? db.getUser(str(r.raised_by)) : undefined;
  const people = [...new Set([raiser?.initials, ...options.flatMap((o) => o.votes), ...comments.map((c) => c.who.initials)].filter((x): x is string => !!x))];
  const myVote = userId ? ((db.raw.prepare('SELECT option_id FROM huddle_votes WHERE item_id = ? AND user_id = ?').get(id, userId) as { option_id: string } | undefined)?.option_id ?? null) : null;
  return {
    id,
    kind,
    ...extrasFor(db, str(r.application_id), [r], userId)(r),
    title: str(r.title),
    summary: str(r.summary),
    raisedBy: raiser?.name ?? str(r.raised_by),
    raisedByType: r.raised_by_type as 'user' | 'agent',
    raisedAt: str(r.created_at),
    scope: str(r.scope),
    people,
    openLabel: OPEN_LABEL[kind].label,
    openTone: OPEN_LABEL[kind].tone,
    aiSummary: str(r.ai_summary),
    citations: json<Citation[]>(r.citations, []),
    affects: links.map((l) => ({ label: str(l.label) || str(l.entity_ref), href: (l.href as string) ?? undefined })),
    options,
    comments,
    needsInput: Number(r.needs_input) === 1,
    sourceId: (r.source_id as string) ?? null,
    decision: dec ? { optionId: str(dec.option_id), reason: str(dec.reason), at: str(dec.decided_at), by: str(dec.name) } : undefined,
    myVote,
    similar: r.status === 'open' ? (similarOpen(db, str(r.application_id)).get(id) ?? []) : [],
    detail: true,
  };
}

/** Every item of the application, in full. Kept for tests and small callers; the API pages with listPage. */
export function listItems(db: HorizonDb, app: string, userId: string | null = null): HuddleItemView[] {
  reopenExpired(db, app);
  return (db.raw.prepare('SELECT * FROM huddle_items WHERE application_id = ? ORDER BY created_at DESC, id DESC').all(app) as Row[]).map((r) => toView(db, r, userId));
}

/* ---------- Likely duplicates (R17) ---------- */

/** A title reduced to its words: case, punctuation, a trailing "(run …)" tag and filler words do not count. */
export const titleWords = (t: string) =>
  new Set(
    t
      .toLowerCase()
      .replace(/\([^)]*\)\s*$/, ' ')
      .match(/[a-z0-9]+/g)
      ?.filter((w) => (w.length > 2 || /\d/.test(w)) && !['the', 'and', 'for', 'this', 'that', 'with'].includes(w)) ?? [],
  );

/** Near-identical titles: at least 80% of the words shared (Jaccard), and at least two words. */
export function similarTitles(a: string, b: string) {
  const x = titleWords(a);
  const y = titleWords(b);
  if (x.size < 2 || y.size < 2) return a.trim().toLowerCase() === b.trim().toLowerCase();
  let shared = 0;
  for (const w of x) if (y.has(w)) shared++;
  return shared / (x.size + y.size - shared) >= 0.8;
}

/**
 * For each open item, the other open items of the same kind that are about the same source or carry
 * a near-identical title, oldest first. Reads only ids, kinds, titles and sources of open items.
 */
export function similarOpen(db: HorizonDb, app: string): Map<string, { id: string; title: string }[]> {
  const open = db.raw.prepare("SELECT id, kind, title, source_id FROM huddle_items WHERE application_id = ? AND status = 'open' ORDER BY created_at, id").all(app) as { id: string; kind: string; title: string; source_id: string | null }[];
  const out = new Map<string, { id: string; title: string }[]>();
  const byKind = new Map<string, typeof open>();
  for (const i of open) byKind.set(i.kind, [...(byKind.get(i.kind) ?? []), i]);
  for (const group of byKind.values()) {
    const words = group.map((i) => titleWords(i.title));
    for (let a = 0; a < group.length; a++)
      for (let b = a + 1; b < group.length; b++) {
        const x = group[a];
        const y = group[b];
        const sameSource = !!x.source_id && x.source_id === y.source_id;
        if (!sameSource && !(words[a].size && words[b].size ? similarTitles(x.title, y.title) : false)) continue;
        out.set(x.id, [...(out.get(x.id) ?? []), { id: y.id, title: y.title }]);
        out.set(y.id, [...(out.get(y.id) ?? []), { id: x.id, title: x.title }]);
      }
  }
  // Each item names the oldest similar item first.
  const order = new Map(open.map((i, n) => [i.id, n]));
  for (const list of out.values()) list.sort((p, q) => order.get(p.id)! - order.get(q.id)!);
  return out;
}

/* ---------- Pages of summaries (hardening: Huddle growth) ---------- */

export interface HuddlePageQuery {
  /** open, decided (decided or closed), or everything (default). */
  status?: 'open' | 'decided' | 'all';
  /** Open items the person raised, voted on or commented on. */
  mine?: boolean;
  /** Items waiting on the person: open and theirs to decide, or with an open action they own. */
  waiting?: boolean;
  /** One domain only. */
  domain?: HuddleDomain;
  /** Words in the title or summary. */
  q?: string;
  limit?: number;
  /** The `nextCursor` of the previous page. */
  cursor?: string | null;
}

export const HUDDLE_PAGE = 50;
const encodeCursor = (v: unknown[]) => Buffer.from(JSON.stringify(v)).toString('base64url');
export function decodeCursor(c: string | null | undefined): [string, string] | null {
  if (!c) return null;
  try {
    const v = JSON.parse(Buffer.from(c, 'base64url').toString('utf8')) as unknown;
    return Array.isArray(v) && v.length === 2 && typeof v[0] === 'string' && typeof v[1] === 'string' ? [v[0], v[1]] : null;
  } catch {
    return null;
  }
}

/**
 * One page of the application's items, newest first, as summaries. The cursor is the last item's
 * (created_at, id), so items raised after the first page never shift later pages: no duplicates and
 * no gaps. Options, votes, comment counts, decisions, actions and links of the page are read in a fixed
 * number of queries, not per item. Counts cover the whole application.
 */
export function listPage(db: HorizonDb, app: string, userId: string | null, q: HuddlePageQuery = {}) {
  reopenExpired(db, app);
  const limit = Math.max(1, Math.min(200, Math.trunc(Number.isFinite(q.limit) ? q.limit! : HUDDLE_PAGE)));
  const where = ['i.application_id = ?'];
  const args: unknown[] = [app];
  const mine = `(i.raised_by = @me OR EXISTS (SELECT 1 FROM huddle_votes v WHERE v.item_id = i.id AND v.user_id = @me) OR EXISTS (SELECT 1 FROM huddle_comments c WHERE c.item_id = i.id AND c.user_id = @me))`;
  if (q.status === 'open') where.push("i.status = 'open'");
  if (q.status === 'decided') where.push("i.status IN ('decided', 'closed')");
  if (q.mine && userId) where.push(`i.status = 'open' AND ${mine.replace(/@me/g, '?')}`), args.push(userId, userId, userId);
  if (q.waiting && userId) {
    const w = waitingSql(userId, db.rolesFor(userId, app));
    where.push(w.sql), args.push(...w.args);
  }
  if (q.domain && HUDDLE_DOMAINS.includes(q.domain)) where.push('i.domain = ?'), args.push(q.domain);
  const needle = q.q?.trim().slice(0, 100);
  if (needle) {
    const like = `%${needle.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    where.push("(i.title LIKE ? ESCAPE '\\' OR i.summary LIKE ? ESCAPE '\\')"), args.push(like, like);
  }
  const after = decodeCursor(q.cursor);
  if (after) where.push('(i.created_at < ? OR (i.created_at = ? AND i.id < ?))'), args.push(after[0], after[0], after[1]);
  const rows = db.raw.prepare(`SELECT i.* FROM huddle_items i WHERE ${where.join(' AND ')} ORDER BY i.created_at DESC, i.id DESC LIMIT ?`).all(...args, limit + 1) as Row[];
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  const nextCursor = rows.length > limit && last ? encodeCursor([str(last.created_at), str(last.id)]) : null;

  const ids = JSON.stringify(page.map((r) => str(r.id)));
  const options = db.raw.prepare(`SELECT * FROM huddle_options WHERE item_id ${IN_IDS} ORDER BY item_id, seq, rowid`).all(ids) as Row[];
  const votes = db.raw.prepare(`SELECT v.item_id, v.option_id, v.user_id, u.initials FROM huddle_votes v JOIN users u ON u.id = v.user_id WHERE v.item_id ${IN_IDS} ORDER BY v.rowid`).all(ids) as Row[];
  const commenters = db.raw.prepare(`SELECT c.item_id, u.initials, COUNT(*) AS n FROM huddle_comments c JOIN users u ON u.id = c.user_id WHERE c.item_id ${IN_IDS} GROUP BY c.item_id, u.id ORDER BY MIN(c.created_at), MIN(c.rowid)`).all(ids) as Row[];
  const links = db.raw.prepare(`SELECT item_id, label, entity_ref, href FROM huddle_links WHERE entity_type = 'affects' AND item_id ${IN_IDS} ORDER BY rowid`).all(ids) as Row[];
  const decisions = db.raw.prepare(`SELECT d.item_id, d.option_id, d.reason, d.decided_at, u.name FROM huddle_decisions d JOIN users u ON u.id = d.decided_by WHERE d.item_id ${IN_IDS}`).all(ids) as Row[];
  const raisers = db.raw.prepare(`SELECT u.id, u.name, u.initials FROM users u WHERE u.id IN (SELECT raised_by FROM huddle_items WHERE id ${IN_IDS} AND raised_by_type = 'user')`).all(ids) as Row[];
  const similar = page.some((r) => r.status === 'open') ? similarOpen(db, app) : new Map<string, { id: string; title: string }[]>();
  const extras = extrasFor(db, app, page, userId);
  const group = <T extends Row>(xs: T[]) => {
    const m = new Map<string, T[]>();
    for (const x of xs) m.set(str(x.item_id), [...(m.get(str(x.item_id)) ?? []), x]);
    return m;
  };
  const optionsBy = group(options);
  const votesBy = group(votes);
  const commentsBy = group(commenters);
  const linksBy = group(links);
  const decisionBy = new Map(decisions.map((d) => [str(d.item_id), d]));
  const raiserBy = new Map(raisers.map((u) => [str(u.id), u]));

  const items: HuddleSummaryView[] = page.map((r) => {
    const id = str(r.id);
    const kind = r.kind as HuddleKind;
    const itemVotes = votesBy.get(id) ?? [];
    const opts = (optionsBy.get(id) ?? []).map((o) => ({
      id: str(o.id),
      title: str(o.label),
      detail: str(o.detail),
      votes: itemVotes.filter((v) => v.option_id === o.id).map((v) => str(v.initials)),
      keepsUpload: Number(o.keeps_upload) === 1,
      accepts: Number(o.accepts) === 1,
    }));
    const raiser = r.raised_by_type === 'user' ? raiserBy.get(str(r.raised_by)) : undefined;
    const talk = commentsBy.get(id) ?? [];
    const dec = decisionBy.get(id);
    return {
      id,
      kind,
      ...extras(r),
      title: str(r.title),
      summary: str(r.summary),
      raisedBy: raiser ? str(raiser.name) : str(r.raised_by),
      raisedByType: r.raised_by_type as 'user' | 'agent',
      raisedAt: str(r.created_at),
      scope: str(r.scope),
      people: [...new Set([raiser ? str(raiser.initials) : undefined, ...opts.flatMap((o) => o.votes), ...talk.map((c) => str(c.initials))].filter((x): x is string => !!x))],
      openLabel: OPEN_LABEL[kind].label,
      openTone: OPEN_LABEL[kind].tone,
      affects: (linksBy.get(id) ?? []).map((l) => ({ label: str(l.label) || str(l.entity_ref), href: (l.href as string) ?? undefined })),
      options: opts,
      commentCount: talk.reduce((n, c) => n + Number(c.n), 0),
      needsInput: Number(r.needs_input) === 1,
      sourceId: (r.source_id as string) ?? null,
      decision: dec ? { optionId: str(dec.option_id), reason: str(dec.reason), at: str(dec.decided_at), by: str(dec.name) } : undefined,
      myVote: userId ? ((itemVotes.find((v) => v.user_id === userId)?.option_id as string | undefined) ?? null) : null,
      similar: r.status === 'open' ? (similar.get(id) ?? []) : [],
      detail: false,
    };
  });
  return { items, nextCursor, counts: huddleCounts(db, app, userId), waiting: waitingCount(db, app, userId), domains: domainCounts(db, app) };
}

/** Open, decided (decided or closed) and "mine" (open items the person raised, voted on or commented on) for the whole application. */
export function huddleCounts(db: HorizonDb, app: string, userId: string | null) {
  const c = db.raw.prepare("SELECT SUM(status = 'open') AS open, SUM(status IN ('decided', 'closed')) AS decided FROM huddle_items WHERE application_id = ?").get(app) as { open: number | null; decided: number | null };
  const mine = userId
    ? (
        db.raw
          .prepare(
            `SELECT COUNT(*) AS n FROM huddle_items i WHERE i.application_id = ? AND i.status = 'open'
             AND (i.raised_by = ? OR EXISTS (SELECT 1 FROM huddle_votes v WHERE v.item_id = i.id AND v.user_id = ?) OR EXISTS (SELECT 1 FROM huddle_comments c WHERE c.item_id = i.id AND c.user_id = ?))`,
          )
          .get(app, userId, userId, userId) as { n: number }
      ).n
    : 0;
  return { open: c.open ?? 0, decided: c.decided ?? 0, mine };
}

/** How many items wait on the person: open and theirs to decide, or with an open action they own. */
export function waitingCount(db: HorizonDb, app: string, userId: string | null) {
  if (!userId) return 0;
  const w = waitingSql(userId, db.rolesFor(userId, app));
  return (db.raw.prepare(`SELECT COUNT(*) AS n FROM huddle_items i WHERE i.application_id = ? AND ${w.sql}`).get(app, ...w.args) as { n: number }).n;
}

/** Open items per domain, for the filter chips. */
export function domainCounts(db: HorizonDb, app: string): Record<HuddleDomain, number> {
  const out = Object.fromEntries(HUDDLE_DOMAINS.map((d) => [d, 0])) as Record<HuddleDomain, number>;
  for (const r of db.raw.prepare("SELECT domain, COUNT(*) AS n FROM huddle_items WHERE application_id = ? AND status = 'open' GROUP BY domain").all(app) as { domain: HuddleDomain; n: number }[]) out[r.domain] = r.n;
  return out;
}

/** An item of this application, or null (an item of another application is not found either). */
export function getItem(db: HorizonDb, app: string, id: string, userId: string | null = null): HuddleItemView | null {
  reopenExpired(db, app);
  const r = db.raw.prepare('SELECT * FROM huddle_items WHERE application_id = ? AND id = ?').get(app, id) as Row | undefined;
  return r ? toView(db, r, userId) : null;
}

function mustGet(db: HorizonDb, app: string, id: string) {
  const r = db.raw.prepare('SELECT id, kind, status, expires_at, severity FROM huddle_items WHERE application_id = ? AND id = ?').get(app, id) as Row | undefined;
  if (!r) throw new HuddleError(404, 'This decision does not exist in this application.');
  return r;
}
function mustGetOpen(db: HorizonDb, app: string, id: string) {
  const r = mustGet(db, app, id);
  if (r.status !== 'open') throw new HuddleError(409, r.status === 'closed' ? 'This is already closed.' : 'This was already decided.');
  return r;
}

/** One vote per person; voting again moves it. */
export function vote(db: HorizonDb, app: string, itemId: string, userId: string, optionId: string) {
  mustGetOpen(db, app, itemId);
  if (!db.raw.prepare('SELECT 1 FROM huddle_options WHERE id = ? AND item_id = ?').get(optionId, itemId)) throw new HuddleError(400, 'That option does not belong to this decision.');
  db.raw
    .prepare('INSERT INTO huddle_votes (item_id, user_id, option_id, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(item_id, user_id) DO UPDATE SET option_id = excluded.option_id, created_at = excluded.created_at')
    .run(itemId, userId, optionId, now());
  return getItem(db, app, itemId, userId)!;
}

export function comment(db: HorizonDb, app: string, itemId: string, userId: string, text: string) {
  const t = text.trim().slice(0, 2000);
  if (!t) throw new HuddleError(400, 'Write something first.');
  if (!db.raw.prepare('SELECT 1 FROM huddle_items WHERE application_id = ? AND id = ?').get(app, itemId)) throw new HuddleError(404, 'This decision does not exist in this application.');
  db.raw.prepare('INSERT INTO huddle_comments (id, item_id, user_id, text, created_at) VALUES (?, ?, ?, ?, ?)').run(`hc-${randomUUID().slice(0, 8)}`, itemId, userId, t, now());
  return getItem(db, app, itemId, userId)!;
}

export function markNeedsInput(db: HorizonDb, app: string, itemId: string, userId: string) {
  mustGetOpen(db, app, itemId);
  db.raw.prepare('UPDATE huddle_items SET needs_input = 1 WHERE id = ?').run(itemId);
  db.audit('user', userId, 'huddle.needs_input', 'huddle_item', itemId, {});
  return getItem(db, app, itemId, userId)!;
}

/**
 * Records the decision: the option, the reason, who and when. Role checks are the route's job
 * (canDecide). The item is decided; it is in follow-up while it has open actions and closes when they
 * are done. Accepting a risk or a vulnerability sets when the acceptance ends: the date given, the
 * item's own expiry if still ahead, or the default from today. Returns the decided item and whether
 * the chosen option keeps a team upload (for conflicts), so the caller can apply it to App Context in
 * the same transaction.
 */
export function decide(db: HorizonDb, app: string, itemId: string, userId: string, optionId: string, reason: string, opts: { expiresAt?: string | null } = {}) {
  const why = reason.trim().slice(0, 2000);
  if (!why) throw new HuddleError(400, 'A reason is required; it is kept with every affected item.');
  const item = mustGetOpen(db, app, itemId);
  const opt = db.raw.prepare('SELECT keeps_upload, accepts FROM huddle_options WHERE id = ? AND item_id = ?').get(optionId, itemId) as { keeps_upload: number; accepts: number } | undefined;
  if (!opt) throw new HuddleError(400, 'That option does not belong to this decision.');
  const t = now();
  let expiresAt = (item.expires_at as string) ?? null;
  if (Number(opt.accepts) === 1) {
    const given = toIsoDate(opts.expiresAt, 'expiresAt');
    if (given && given <= t) throw new HuddleError(400, 'The acceptance must end in the future.');
    const severity = (item.severity as Severity) ?? 'high';
    expiresAt = given ?? (expiresAt && expiresAt > t ? expiresAt : addDays(t, item.kind === 'vulnerability' ? EXPIRY_DAYS[severity] : RISK_EXPIRY_DAYS));
  }
  db.raw.transaction(() => {
    db.raw.prepare('INSERT INTO huddle_decisions (item_id, option_id, reason, decided_by, decided_at) VALUES (?, ?, ?, ?, ?)').run(itemId, optionId, why, userId, t);
    db.raw.prepare("UPDATE huddle_items SET status = 'decided', needs_input = 0, expires_at = ?, updated_at = ? WHERE id = ?").run(expiresAt, t, itemId);
    db.audit('user', userId, 'huddle.decide', 'huddle_item', itemId, { optionId });
  })();
  return { item: getItem(db, app, itemId, userId)!, keepsUpload: Number(opt.keeps_upload) === 1 };
}

/** Answers a concern: the answer is the record, and the concern closes (or stays in follow-up while it has open actions). */
export function answerConcern(db: HorizonDb, app: string, itemId: string, userId: string, text: string) {
  const answer = text.trim().slice(0, 4000);
  if (!answer) throw new HuddleError(400, 'Write the answer first.');
  const item = mustGetOpen(db, app, itemId);
  if (item.kind !== 'concern') throw new HuddleError(400, 'Only a concern is answered; this one needs a decision between its options.');
  const t = now();
  const open = (db.raw.prepare("SELECT COUNT(*) AS n FROM huddle_actions WHERE item_id = ? AND status = 'open'").get(itemId) as { n: number }).n;
  db.raw.transaction(() => {
    db.raw
      .prepare('UPDATE huddle_items SET answer = ?, answered_by = ?, answered_at = ?, status = ?, needs_input = 0, closed_at = ?, updated_at = ? WHERE id = ?')
      .run(answer, userId, t, open ? 'decided' : 'closed', open ? null : t, t, itemId);
    db.audit('user', userId, 'huddle.answer', 'huddle_item', itemId, {});
  })();
  return getItem(db, app, itemId, userId)!;
}

/* ---------- Actions ---------- */

export interface NewHuddleAction {
  title: string;
  ownerId: string;
  dueAt?: string | null;
  /** Where the work happens: a story, a PR, an approval card, a runbook. */
  link?: string | null;
}

/** Adds a follow-up action with an owner (a member of the application) and an optional due date. Not on a closed item. */
export function addAction(db: HorizonDb, app: string, itemId: string, userId: string, input: NewHuddleAction) {
  const item = mustGet(db, app, itemId);
  if (item.status === 'closed') throw new HuddleError(409, 'This is closed; raise a new item for more work.');
  const title = input.title.trim().slice(0, 200);
  if (!title) throw new HuddleError(400, 'Say what has to be done.');
  if (!db.raw.prepare('SELECT 1 FROM memberships WHERE user_id = ? AND application_id = ?').get(input.ownerId, app)) throw new HuddleError(400, 'The owner must be a member of this application.');
  const link = input.link?.trim().slice(0, 500) || null;
  if (link && !/^(\/|https?:\/\/)/.test(link)) throw new HuddleError(400, 'A link starts with / or http(s)://.');
  const id = `ha-${randomUUID().slice(0, 8)}`;
  const t = now();
  db.raw.prepare('INSERT INTO huddle_actions (id, item_id, title, owner_id, due_at, status, link, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, itemId, title, input.ownerId, toIsoDate(input.dueAt, 'dueAt'), 'open', link, userId, t);
  db.audit('user', userId, 'huddle.action.add', 'huddle_item', itemId, { action: id, owner: input.ownerId });
  return getItem(db, app, itemId, userId)!;
}

/**
 * Marks an action done. Its owner, the person who added it, or a decider of the item may. When the
 * item is decided (or answered) and no open action is left, it closes.
 */
export function completeAction(db: HorizonDb, app: string, itemId: string, actionId: string, userId: string) {
  const item = mustGet(db, app, itemId);
  const a = db.raw.prepare('SELECT owner_id, created_by, status FROM huddle_actions WHERE id = ? AND item_id = ?').get(actionId, itemId) as Row | undefined;
  if (!a) throw new HuddleError(404, 'That action does not belong to this item.');
  if (a.status === 'done') throw new HuddleError(409, 'That action is already done.');
  if (a.owner_id !== userId && a.created_by !== userId && !canDecide(db, app, itemId, userId)) throw new HuddleError(403, "Only the action's owner, the person who added it, or the item's decider can mark it done.");
  const t = now();
  db.raw.transaction(() => {
    db.raw.prepare("UPDATE huddle_actions SET status = 'done', done_by = ?, done_at = ? WHERE id = ?").run(userId, t, actionId);
    const left = (db.raw.prepare("SELECT COUNT(*) AS n FROM huddle_actions WHERE item_id = ? AND status = 'open'").get(itemId) as { n: number }).n;
    if (item.status === 'decided' && left === 0) db.raw.prepare("UPDATE huddle_items SET status = 'closed', closed_at = ?, updated_at = ? WHERE id = ?").run(t, t, itemId);
    db.audit('user', userId, 'huddle.action.done', 'huddle_item', itemId, { action: actionId });
  })();
  return getItem(db, app, itemId, userId)!;
}

/** The open item carrying a given link, used to raise a pattern only once. */
export function findOpenItem(db: HorizonDb, app: string, linkType: string, linkRef: string) {
  const r = db.raw
    .prepare("SELECT i.id FROM huddle_items i JOIN huddle_links l ON l.item_id = i.id WHERE i.application_id = ? AND i.status = 'open' AND l.entity_type = ? AND l.entity_ref = ? LIMIT 1")
    .get(app, linkType, linkRef) as { id: string } | undefined;
  return r ? getItem(db, app, r.id) : null;
}

const CAP_LABEL: Record<string, string> = { analysis: 'Test analysis', authoring: 'Test authoring', execution: 'Execution', cloudops: 'CloudOps', security: 'Security' };

/** The domain an answer's capability implies (docs/HUDDLE.md): testing work, CloudOps, security. */
export const CAPABILITY_DOMAIN: Record<string, HuddleDomain> = { analysis: 'testing', authoring: 'testing', execution: 'testing', cloudops: 'reliability', security: 'security' };

/** The first sentences of an answer, up to about `max` characters, cut at a sentence end when there is one. */
export function opening(text: string, max = 600) {
  const t = text.replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('? '), cut.lastIndexOf('! '));
  return end > max / 3 ? cut.slice(0, end + 1) : `${cut.trimEnd()}…`;
}

/**
 * "Raise with the team" from a finished answer: a Concern carrying the question, the answer's opening
 * and its citations, linked to the chat (and to the stories and components the question named), in the
 * domain the answer's capability implies. Raising the same answer again while its concern is open
 * returns that concern.
 */
export function raiseFromChat(db: HorizonDb, app: AppRecord, userId: string, input: { chatId: string; messageId: string; title?: string; note?: string }) {
  const chat = db.raw.prepare('SELECT id, application_id, title FROM chats WHERE id = ?').get(input.chatId) as Row | undefined;
  if (!chat || chat.application_id !== app.id) throw new HuddleError(404, 'This chat does not exist in this application.');
  const m = db.raw.prepare("SELECT id, seq FROM messages WHERE id = ? AND chat_id = ? AND role = 'assistant'").get(input.messageId, input.chatId) as Row | undefined;
  if (!m) throw new HuddleError(404, 'This answer does not exist in this chat.');
  const rev = db.raw.prepare('SELECT id, status, intent, blocks FROM answer_revisions WHERE message_id = ? ORDER BY revision DESC LIMIT 1').get(m.id) as Row | undefined;
  if (!rev || rev.status !== 'done') throw new HuddleError(409, 'Only a finished answer can be raised with the team.');
  const existing = findOpenItem(db, app.id, 'answer', str(rev.id));
  if (existing) return { item: getItem(db, app.id, existing.id, userId)!, already: true };
  const q = db.raw.prepare("SELECT id, text, removed_reason FROM messages WHERE chat_id = ? AND role = 'user' AND seq < ? ORDER BY seq DESC LIMIT 1").get(input.chatId, m.seq) as Row | undefined;
  const question = q ? (q.removed_reason ? '[Message removed: it contained a secret]' : str(q.text).trim()) : '';
  const prose = json<{ kind: string; text?: string }[]>(rev.blocks, [])
    .flatMap((b) => (b.kind === 'prose' && b.text ? [b.text] : []))
    .join('\n\n');
  const citations = db.raw.prepare("SELECT n, title, detail, CASE WHEN source_type = 'link' THEN source_ref END AS href FROM citations WHERE revision_id = ? ORDER BY n").all(rev.id) as Row[];
  const capability = json<{ capability?: string } | null>(rev.intent, null)?.capability ?? '';
  const domain = CAPABILITY_DOMAIN[capability] ?? 'testing';
  const items = q ? (db.raw.prepare('SELECT item_type, item_ref FROM message_items WHERE message_id = ?').all(q.id) as Row[]) : [];
  const note = (input.note ?? '').trim().slice(0, 1500);
  const title = (input.title ?? '').trim() || question.slice(0, 160) || `About the answer in "${str(chat.title)}"`;
  const begin = opening(prose);
  const links: NonNullable<NewHuddleItem['links']> = [
    { type: 'chat', ref: str(chat.id), label: str(chat.title).slice(0, 80), href: `/chat/${str(chat.id)}` },
    { type: 'answer', ref: str(rev.id) },
    ...items.filter((i) => i.item_type === 'story').map((i) => ({ type: 'story', ref: str(i.item_ref), label: str(i.item_ref), href: `/tickets/${str(i.item_ref)}` })),
    ...items.filter((i) => i.item_type === 'component').map((i) => ({ type: 'component', ref: str(i.item_ref), label: str(i.item_ref).split('/').pop() })),
  ];
  const item = createItem(
    db,
    app,
    { type: 'user', ref: userId },
    {
      kind: 'concern',
      domain,
      title,
      summary: note || (question ? `Question: ${question.slice(0, 400)}` : 'Raised from a chat answer.'),
      scope: `${app.name} · ${CAP_LABEL[capability] ?? 'chat'}`,
      aiSummary: [question && `Question: ${question.slice(0, 600)}`, begin && `The answer began: ${begin}`, note && `Note: ${note}`].filter(Boolean).join('\n\n'),
      citations: citations.map((c) => ({ n: Number(c.n), title: str(c.title), detail: str(c.detail), href: (c.href as string) ?? undefined })),
      options: [],
      affects: [],
      links,
    },
  );
  return { item, already: false };
}

/**
 * The feedback-pattern rule (DESIGN.md, Huddle): the same low-rating reason given by several
 * people for one capability within a week becomes a Huddle item raised by Catalyzt, once per
 * open pattern. Returns the item raised, or null when one is already open.
 */
export function raiseFeedbackPattern(db: HorizonDb, app: AppRecord, p: { capability: string; reason: string; count: number }, days = 7) {
  const key = `${p.capability}|${p.reason}`;
  if (findOpenItem(db, app.id, 'feedback_pattern', key)) return null;
  // R18: ratings and people are different counts; three ratings may come from two people.
  const people = (x: { count: number; people?: number }) => `${x.people ?? x.count} ${(x.people ?? x.count) === 1 ? 'person' : 'people'}`;
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const recent = db.raw
    .prepare(
      `SELECT DISTINCT m.chat_id, c.title FROM ratings r JOIN answer_revisions ar ON ar.id = r.revision_id JOIN messages m ON m.id = ar.message_id JOIN chats c ON c.id = m.chat_id, json_each(r.reasons) je
       WHERE c.application_id = ? AND r.stars < 4 AND r.created_at >= ? AND je.value = ? AND COALESCE(json_extract(ar.intent, '$.capability'), 'unknown') = ? ORDER BY r.created_at DESC LIMIT 5`,
    )
    .all(app.id, since, p.reason, p.capability) as { chat_id: string; title: string }[];
  const cap = CAP_LABEL[p.capability] ?? p.capability;
  return createItem(
    db,
    app,
    { type: 'agent', ref: 'Catalyzt' },
    {
      kind: 'feedback',
      title: `${cap} answers rated low for "${p.reason}"`,
      summary: `${p.count} ratings from ${people(p)} below 4 stars in ${days} days gave the reason "${p.reason}" for ${cap.toLowerCase()} answers.`,
      scope: `${app.name} · whole app`,
      aiSummary: `${p.count} ratings from ${people(p)} put ${cap.toLowerCase()} answers below 4 stars in the last ${days} days with the reason "${p.reason}" [1]. Catalyzt does not change its own behaviour from feedback; the team decides whether the sources, the prompts or the expectation need to change.`,
      citations: [{ n: 1, title: 'Ratings with reasons and comments', detail: `${p.count} ratings from ${people(p)} in ${days} days · ${cap} · "${p.reason}"` }],
      options: [
        { title: 'Review the sources and prompt for this capability', detail: 'Someone reads the rated answers and their comments, and proposes what to change.' },
        { title: 'Keep as is and watch', detail: 'Leave it; Catalyzt raises it again if the pattern continues after this is decided.' },
      ],
      affects: recent.map((r) => ({ label: r.title.slice(0, 60), href: `/chat/${r.chat_id}` })),
      links: [{ type: 'feedback_pattern', ref: key }],
    },
  );
}
