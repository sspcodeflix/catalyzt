/**
 * Huddle, server side: decisions Catalyzt will not make on its own. Items are raised by people or
 * by Catalyzt's agents, carry Catalyzt's cited summary and ordered options, collect advisory votes
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
  /** R17: open items of the same kind about the same source, or with a near-identical title. Never merged. */
  similar: { id: string; title: string }[];
  /** True for the full item (GET /api/huddle/:id); list pages carry summaries without comments and citations. */
  detail: true;
}

/** A list entry: everything the list and its filters need, without the discussion and the cited summary. */
export type HuddleSummaryView = Omit<HuddleItemView, 'comments' | 'citations' | 'aiSummary' | 'detail'> & { commentCount: number; detail: false };

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
  risk: { label: 'Risk acceptance', tone: 'warn' },
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
    similar: r.status === 'open' ? (similarOpen(db, str(r.application_id)).get(id) ?? []) : [],
    detail: true,
  };
}

/** Every item of the application, in full. Kept for tests and small callers; the API pages with listPage. */
export function listItems(db: HorizonDb, app: string, userId: string | null = null): HuddleItemView[] {
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
  /** open, decided, or everything (default). */
  status?: 'open' | 'decided' | 'all';
  /** Open items the person raised, voted on or commented on. */
  mine?: boolean;
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
 * no gaps. Options, votes, comment counts, decisions and links of the page are read in a fixed number
 * of queries, not per item. Counts cover the whole application.
 */
export function listPage(db: HorizonDb, app: string, userId: string | null, q: HuddlePageQuery = {}) {
  const limit = Math.max(1, Math.min(200, Math.trunc(Number.isFinite(q.limit) ? q.limit! : HUDDLE_PAGE)));
  const where = ['i.application_id = ?'];
  const args: unknown[] = [app];
  const mine = `(i.raised_by = @me OR EXISTS (SELECT 1 FROM huddle_votes v WHERE v.item_id = i.id AND v.user_id = @me) OR EXISTS (SELECT 1 FROM huddle_comments c WHERE c.item_id = i.id AND c.user_id = @me))`;
  if (q.status === 'open' || q.status === 'decided') where.push('i.status = ?'), args.push(q.status);
  if (q.mine && userId) where.push(`i.status = 'open' AND ${mine.replace(/@me/g, '?')}`), args.push(userId, userId, userId);
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
  const inPage = 'IN (SELECT value FROM json_each(?))';
  const options = db.raw.prepare(`SELECT * FROM huddle_options WHERE item_id ${inPage} ORDER BY item_id, seq, rowid`).all(ids) as Row[];
  const votes = db.raw.prepare(`SELECT v.item_id, v.option_id, v.user_id, u.initials FROM huddle_votes v JOIN users u ON u.id = v.user_id WHERE v.item_id ${inPage} ORDER BY v.rowid`).all(ids) as Row[];
  const commenters = db.raw.prepare(`SELECT c.item_id, u.initials, COUNT(*) AS n FROM huddle_comments c JOIN users u ON u.id = c.user_id WHERE c.item_id ${inPage} GROUP BY c.item_id, u.id ORDER BY MIN(c.created_at), MIN(c.rowid)`).all(ids) as Row[];
  const links = db.raw.prepare(`SELECT item_id, label, entity_ref, href FROM huddle_links WHERE entity_type = 'affects' AND item_id ${inPage} ORDER BY rowid`).all(ids) as Row[];
  const decisions = db.raw.prepare(`SELECT d.item_id, d.option_id, d.reason, d.decided_at, u.name FROM huddle_decisions d JOIN users u ON u.id = d.decided_by WHERE d.item_id ${inPage}`).all(ids) as Row[];
  const raisers = db.raw.prepare(`SELECT u.id, u.name, u.initials FROM users u WHERE u.id IN (SELECT raised_by FROM huddle_items WHERE id ${inPage} AND raised_by_type = 'user')`).all(ids) as Row[];
  const similar = page.some((r) => r.status === 'open') ? similarOpen(db, app) : new Map<string, { id: string; title: string }[]>();
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
    }));
    const raiser = r.raised_by_type === 'user' ? raiserBy.get(str(r.raised_by)) : undefined;
    const talk = commentsBy.get(id) ?? [];
    const dec = decisionBy.get(id);
    return {
      id,
      kind,
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
      myVote: userId ? (itemVotes.find((v) => v.user_id === userId)?.option_id as string | undefined) ?? null : null,
      similar: r.status === 'open' ? (similar.get(id) ?? []) : [],
      detail: false,
    };
  });
  return { items, nextCursor, counts: huddleCounts(db, app, userId) };
}

/** Open, decided and "mine" (open items the person raised, voted on or commented on) for the whole application. */
export function huddleCounts(db: HorizonDb, app: string, userId: string | null) {
  const c = db.raw.prepare("SELECT SUM(status = 'open') AS open, SUM(status = 'decided') AS decided FROM huddle_items WHERE application_id = ?").get(app) as { open: number | null; decided: number | null };
  const mine = userId
    ? (db.raw
        .prepare(
          `SELECT COUNT(*) AS n FROM huddle_items i WHERE i.application_id = ? AND i.status = 'open'
             AND (i.raised_by = ? OR EXISTS (SELECT 1 FROM huddle_votes v WHERE v.item_id = i.id AND v.user_id = ?) OR EXISTS (SELECT 1 FROM huddle_comments c WHERE c.item_id = i.id AND c.user_id = ?))`,
        )
        .get(app, userId, userId, userId) as { n: number }).n
    : 0;
  return { open: c.open ?? 0, decided: c.decided ?? 0, mine };
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
