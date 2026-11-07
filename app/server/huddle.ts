/**
 * Huddle, server side: decisions Horizon will not make on its own. Items are raised by people or
 * by Horizon's agents, carry Horizon's cited summary and ordered options, collect advisory votes
 * and comments, and are decided by an application owner with a reason. Everything is persisted
 * per application; nothing here is placeholder data.
 */
import { randomUUID } from 'node:crypto';

import type { Citation } from '../src/lib/types';
import type { AppRecord, HorizonDb } from './db';

export class HuddleError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export type HuddleKind = 'conflict' | 'mapping' | 'risk' | 'feedback';

export interface HuddleOptionView {
  id: string;
  title: string;
  detail: string;
  /** Initials of the people who voted for it. Votes are advisory. */
  votes: string[];
  keepsUpload: boolean;
}

export interface HuddleItemView {
  id: string;
  kind: HuddleKind;
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
}

export interface NewHuddleItem {
  kind: HuddleKind;
  title: string;
  summary: string;
  scope: string;
  aiSummary: string;
  citations: Citation[];
  options: { title: string; detail: string; keepsUpload?: boolean }[];
  affects: { label: string; href?: string }[];
  sourceId?: string | null;
  openLabel?: string;
  /** Extra links, for example a dedupe key ("feedback_pattern", "analysis|Wrong coverage"). */
  links?: { type: string; ref: string; label?: string; href?: string }[];
}

const OPEN_LABEL: Record<HuddleKind, { label: string; tone: string }> = {
  conflict: { label: 'Needs a decision', tone: 'warn' },
  mapping: { label: 'Needs a decision', tone: 'warn' },
  risk: { label: 'Security sign-off', tone: 'crit' },
  feedback: { label: 'Pattern to review', tone: 'info' },
};

type Row = Record<string, unknown>;
const now = () => new Date().toISOString();
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
  if (!input.options || input.options.length < 2) throw new HuddleError(400, 'Give at least two options to choose between.');
  const id = `hd-${randomUUID().slice(0, 8)}`;
  db.raw.transaction(() => {
    db.raw
      .prepare(
        `INSERT INTO huddle_items (id, application_id, kind, title, summary, status, needs_input, raised_by_type, raised_by, created_at, scope, ai_summary, citations, source_id)
         VALUES (?, ?, ?, ?, ?, 'open', 0, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, app.id, input.kind, title, input.summary.trim().slice(0, 2000), by.type, by.ref, at, input.scope.slice(0, 200), input.aiSummary.slice(0, 4000), JSON.stringify(input.citations ?? []), input.sourceId ?? null);
    const opt = db.raw.prepare('INSERT INTO huddle_options (id, item_id, label, detail, seq, keeps_upload) VALUES (?, ?, ?, ?, ?, ?)');
    input.options.slice(0, 6).forEach((o, i) => opt.run(`${id}-o${i + 1}`, id, o.title.trim().slice(0, 200), (o.detail ?? '').trim().slice(0, 500), i + 1, o.keepsUpload ? 1 : 0));
    const link = db.raw.prepare('INSERT OR IGNORE INTO huddle_links (item_id, entity_type, entity_ref, label, href) VALUES (?, ?, ?, ?, ?)');
    input.affects.slice(0, 12).forEach((a) => link.run(id, 'affects', (a.href ?? a.label).slice(0, 300), a.label.slice(0, 120), a.href ?? null));
    for (const l of input.links ?? []) link.run(id, l.type.slice(0, 40), l.ref.slice(0, 300), (l.label ?? '').slice(0, 120), l.href ?? null);
    db.audit(by.type, by.ref, 'huddle.raise', 'huddle_item', id, { app: app.id, kind: input.kind });
  })();
  return getItem(db, app.id, id)!;
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
  }));
  const comments = (db.raw.prepare('SELECT c.id, c.text, c.created_at, u.name, u.initials FROM huddle_comments c JOIN users u ON u.id = c.user_id WHERE c.item_id = ? ORDER BY c.created_at, c.rowid').all(id) as Row[]).map((c) => ({
    id: str(c.id),
    who: { initials: str(c.initials), name: str(c.name) },
    at: str(c.created_at),
    text: str(c.text),
  }));
  const links = db.raw.prepare('SELECT entity_type, entity_ref, label, href FROM huddle_links WHERE item_id = ? ORDER BY rowid').all(id) as Row[];
  const dec = db.raw.prepare('SELECT d.option_id, d.reason, d.decided_at, u.name FROM huddle_decisions d JOIN users u ON u.id = d.decided_by WHERE d.item_id = ?').get(id) as Row | undefined;
  const raiser = r.raised_by_type === 'user' ? db.getUser(str(r.raised_by)) : undefined;
  const people = [...new Set([raiser?.initials, ...options.flatMap((o) => o.votes), ...comments.map((c) => c.who.initials)].filter((x): x is string => !!x))];
  const myVote = userId ? ((db.raw.prepare('SELECT option_id FROM huddle_votes WHERE item_id = ? AND user_id = ?').get(id, userId) as { option_id: string } | undefined)?.option_id ?? null) : null;
  return {
    id,
    kind,
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
    affects: links.filter((l) => l.entity_type === 'affects').map((l) => ({ label: str(l.label) || str(l.entity_ref), href: (l.href as string) ?? undefined })),
    options,
    comments,
    needsInput: Number(r.needs_input) === 1,
    sourceId: (r.source_id as string) ?? null,
    decision: dec ? { optionId: str(dec.option_id), reason: str(dec.reason), at: str(dec.decided_at), by: str(dec.name) } : undefined,
    myVote,
  };
}

export function listItems(db: HorizonDb, app: string, userId: string | null = null): HuddleItemView[] {
  return (db.raw.prepare('SELECT * FROM huddle_items WHERE application_id = ? ORDER BY created_at DESC, rowid DESC').all(app) as Row[]).map((r) => toView(db, r, userId));
}

/** An item of this application, or null (an item of another application is not found either). */
export function getItem(db: HorizonDb, app: string, id: string, userId: string | null = null): HuddleItemView | null {
  const r = db.raw.prepare('SELECT * FROM huddle_items WHERE application_id = ? AND id = ?').get(app, id) as Row | undefined;
  return r ? toView(db, r, userId) : null;
}

function mustGetOpen(db: HorizonDb, app: string, id: string) {
  const r = db.raw.prepare('SELECT id, status FROM huddle_items WHERE application_id = ? AND id = ?').get(app, id) as Row | undefined;
  if (!r) throw new HuddleError(404, 'This decision does not exist in this application.');
  if (r.status !== 'open') throw new HuddleError(409, 'This was already decided.');
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
 * Records the decision: the option, the reason, who and when; the item closes. Role checks are
 * the route's job. Returns the decided item and whether the chosen option keeps a team upload
 * (for conflicts), so the caller can apply it to App Context in the same transaction.
 */
export function decide(db: HorizonDb, app: string, itemId: string, userId: string, optionId: string, reason: string) {
  const why = reason.trim().slice(0, 2000);
  if (!why) throw new HuddleError(400, 'A reason is required; it is kept with every affected item.');
  mustGetOpen(db, app, itemId);
  const opt = db.raw.prepare('SELECT keeps_upload FROM huddle_options WHERE id = ? AND item_id = ?').get(optionId, itemId) as { keeps_upload: number } | undefined;
  if (!opt) throw new HuddleError(400, 'That option does not belong to this decision.');
  const t = now();
  db.raw.transaction(() => {
    db.raw.prepare('INSERT INTO huddle_decisions (item_id, option_id, reason, decided_by, decided_at) VALUES (?, ?, ?, ?, ?)').run(itemId, optionId, why, userId, t);
    db.raw.prepare("UPDATE huddle_items SET status = 'decided', needs_input = 0 WHERE id = ?").run(itemId);
    db.audit('user', userId, 'huddle.decide', 'huddle_item', itemId, { optionId });
  })();
  return { item: getItem(db, app, itemId, userId)!, keepsUpload: Number(opt.keeps_upload) === 1 };
}

/** The open item carrying a given link, used to raise a pattern only once. */
export function findOpenItem(db: HorizonDb, app: string, linkType: string, linkRef: string) {
  const r = db.raw
    .prepare("SELECT i.id FROM huddle_items i JOIN huddle_links l ON l.item_id = i.id WHERE i.application_id = ? AND i.status = 'open' AND l.entity_type = ? AND l.entity_ref = ? LIMIT 1")
    .get(app, linkType, linkRef) as { id: string } | undefined;
  return r ? getItem(db, app, r.id) : null;
}

const CAP_LABEL: Record<string, string> = { analysis: 'Test analysis', authoring: 'Test authoring', execution: 'Execution', cloudops: 'CloudOps', security: 'Security' };

/**
 * The feedback-pattern rule (DESIGN.md, Huddle): the same low-rating reason given by several
 * people for one capability within a week becomes a Huddle item raised by Horizon, once per
 * open pattern. Returns the item raised, or null when one is already open.
 */
export function raiseFeedbackPattern(db: HorizonDb, app: AppRecord, p: { capability: string; reason: string; count: number }, days = 7) {
  const key = `${p.capability}|${p.reason}`;
  if (findOpenItem(db, app.id, 'feedback_pattern', key)) return null;
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
    { type: 'agent', ref: 'Horizon' },
    {
      kind: 'feedback',
      title: `${cap} answers rated low for "${p.reason}"`,
      summary: `${p.count} ratings below 4 stars in ${days} days gave the reason "${p.reason}" for ${cap.toLowerCase()} answers.`,
      scope: `${app.name} · whole app`,
      aiSummary: `${p.count} people rated ${cap.toLowerCase()} answers below 4 stars in the last ${days} days and picked "${p.reason}" [1]. Horizon does not change its own behaviour from feedback; the team decides whether the sources, the prompts or the expectation need to change.`,
      citations: [{ n: 1, title: 'Ratings with reasons and comments', detail: `${p.count} in ${days} days · ${cap} · "${p.reason}"` }],
      options: [
        { title: 'Review the sources and prompt for this capability', detail: 'Someone reads the rated answers and their comments, and proposes what to change.' },
        { title: 'Keep as is and watch', detail: 'Leave it; Horizon raises it again if the pattern continues after this is decided.' },
      ],
      affects: recent.map((r) => ({ label: r.title.slice(0, 60), href: `/chat/${r.chat_id}` })),
      links: [{ type: 'feedback_pattern', ref: key }],
    },
  );
}
