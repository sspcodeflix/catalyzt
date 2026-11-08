/**
 * Routes for App Context and Huddle, mounted by server/api.ts after the person and application are
 * resolved. Return true when the request was handled.
 *
 *   GET  /api/context                       sources, open conflicts, connector states, limits
 *   GET  /api/context/sources/:id           one source with its passages and open conflict
 *   POST /api/context/uploads               { files: [{filename, contentBase64}], scope: 'app'|'workspace', workspace? }
 *   POST /api/context/confluence            501: not connected in this build
 *   POST /api/context/sources/:id/sync      re-read a repository's documentation; record a Jira sync
 *   POST /api/context/test                  { question } -> what Catalyzt would use, and what it would not, and why
 *   POST /api/context/conflicts             { sourceId, otherSourceId, title, detail, compare } -> Huddle item
 *   GET  /api/huddle                        a page of the application's items as summaries (?limit, ?cursor, ?status, ?mine, ?waiting=me, ?domain, ?q),
 *                                           with counts, the waiting-on-me count and open items per domain
 *   POST /api/huddle                        raise one: { kind, domain?, title, summary, options, severity?, dueAt?, expiresAt?, links?, affects?, scope? }
 *   GET  /api/huddle/people                 the application's people (action owners)
 *   POST /api/huddle/from-chat              { chatId, messageId, title?, note? } -> a Concern from a finished answer ("Raise with the team")
 *   GET  /api/huddle/:id
 *   POST /api/huddle/:id/vote               { optionId }; advisory
 *   POST /api/huddle/:id/comments           { text }
 *   POST /api/huddle/:id/needs-input        the domain's decider
 *   POST /api/huddle/:id/decide             { optionId, reason, expiresAt? }, the domain's decider; a conflict decision is applied to App Context
 *   POST /api/huddle/:id/answer             { text }, a concern's raiser or decider; closes it
 *   POST /api/huddle/:id/actions            { title, ownerId, dueAt?, link? }
 *   POST /api/huddle/:id/actions/:aid/done  the action's owner or adder, or the decider; the item closes when all are done
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

import { addConfluence, addUploads, getSource, listChunks, listConflicts, listSources, MAX_UPLOAD_MB, raiseConflict, resolveConflictForItem, retrieveContext, syncSource, testQuestion, type ConflictInput } from './context';
import type { AppRecord, HorizonDb, PersonRecord, Role } from './db';
import {
  addAction,
  answerConcern,
  canDecide,
  comment,
  completeAction,
  createItem,
  decide,
  DECIDER_TEXT,
  getItem,
  HUDDLE_DOMAINS,
  HUDDLE_KINDS,
  LINK_TYPES,
  listPage,
  markNeedsInput,
  raiseFromChat,
  SEVERITIES,
  vote,
  type HuddleDomain,
  type HuddleKind,
  type HuddleLinkType,
  type NewHuddleAction,
  type Severity,
} from './huddle';
import { NO_MODELS, type RetrievalService, type RetrievalStatus } from './retrieval';
import type { BlobStore } from './storage';

export interface RouteContext {
  req: IncomingMessage;
  res: ServerResponse;
  /** Path without the query string, e.g. /api/context/sources. */
  url: string;
  method: string;
  query: URLSearchParams;
  db: HorizonDb;
  user: PersonRecord;
  /** The application the session is looking at; membership is already checked. */
  app: AppRecord;
  roles: Role[];
  files: BlobStore;
  /** Embedding and reranking models plus the background embedding job; absent means keyword-only. */
  retrieval?: RetrievalService;
  readJson: (max?: number) => Promise<unknown>;
  send: (status: number, body: unknown) => void;
  /** Throw to answer with a status and message. */
  HttpError: new (status: number, message: string) => Error;
}

const ID = /^[A-Za-z0-9_.:-]{1,120}$/;
const isStr = (v: unknown): v is string => typeof v === 'string';
const MAX_UPLOAD = 12 * 1024 * 1024;

export { retrieveContext };

/** Keyword-only, when no models are configured. */
const KEYWORD_ONLY = (db: HorizonDb, app: string): RetrievalStatus => {
  const n = (db.raw.prepare('SELECT COUNT(*) AS n FROM source_chunks c JOIN context_sources s ON s.id = c.source_id WHERE s.application_id = ?').get(app) as { n: number }).n;
  return { mode: 'keyword', embedder: null, reranker: null, state: 'off', embedded: 0, pending: n, error: null };
};

export async function extraRoutes(ctx: RouteContext): Promise<boolean> {
  const { url, method, db, user, app, send, HttpError, retrieval } = ctx;
  const models = retrieval?.models ?? NO_MODELS;

  /* ---------- App Context ---------- */
  if (url === '/api/context' && method === 'GET') {
    send(200, {
      sources: listSources(db, app.id),
      conflicts: listConflicts(db, app.id, 'open'),
      // Honest connector states: nothing here pretends to be connected.
      connectors: { confluence: 'not_connected', fabric: 'none', jira: 'workspace', github: 'scan' },
      limits: { maxUploadMb: MAX_UPLOAD_MB, readable: ['Markdown', 'text', 'CSV', 'JSON', 'YAML', 'XML', 'logs', 'source code'], storedOnly: ['PDF', 'Word', 'images', 'ZIP'] },
      // How passages are found right now, for this application: keyword-only until vectors exist.
      retrieval: retrieval ? retrieval.status(db, app.id) : KEYWORD_ONLY(db, app.id),
    });
    return true;
  }
  const sourceMatch = /^\/api\/context\/sources\/([^/]+)(\/sync)?$/.exec(url);
  if (sourceMatch) {
    const id = decodeURIComponent(sourceMatch[1]);
    if (!ID.test(id)) throw new HttpError(400, 'Bad source id.');
    if (!sourceMatch[2] && method === 'GET') {
      const source = getSource(db, app.id, id);
      if (!source) return send(404, { error: 'This source does not exist in this application.' }), true;
      const conflict = source.conflictId ? listConflicts(db, app.id, 'all').find((c) => c.id === source.conflictId) ?? null : null;
      // ?v=<version>: the passages as a citation saw them (F20); otherwise the current ones.
      const v = Number(ctx.query.get('v'));
      const version = Number.isInteger(v) && v >= 1 && v !== source.version ? v : null;
      send(200, { source, chunks: listChunks(db, app.id, id, version ?? undefined), conflict, viewingVersion: version ?? source.version, current: version === null });
      return true;
    }
    if (sourceMatch[2] && method === 'POST') {
      const r = syncSource(db, app.id, id);
      // New passages get their vectors in the background; until then they match by keyword.
      void retrieval?.schedule();
      send(200, r);
      return true;
    }
  }
  if (url === '/api/context/uploads' && method === 'POST') {
    const b = (await ctx.readJson(MAX_UPLOAD)) as Record<string, unknown>;
    const files = (Array.isArray(b.files) ? b.files : []).slice(0, 10).map((f: Record<string, unknown>) => ({ filename: String(f.filename ?? 'file'), data: Buffer.from(String(f.contentBase64 ?? ''), 'base64') }));
    const r = await addUploads(db, ctx.files, app, user, files, b.scope ?? 'app', b.workspace);
    void retrieval?.schedule();
    send(200, r);
    return true;
  }
  if (url === '/api/context/confluence' && method === 'POST') {
    await ctx.readJson();
    addConfluence();
  }
  if (url === '/api/context/test' && method === 'POST') {
    const b = (await ctx.readJson()) as Record<string, unknown>;
    send(200, await testQuestion(db, app, isStr(b.question) ? b.question.slice(0, 500) : '', models));
    return true;
  }
  if (url === '/api/context/conflicts' && method === 'POST') {
    const b = (await ctx.readJson()) as Partial<ConflictInput>;
    send(201, raiseConflict(db, app, user, { sourceId: String(b.sourceId ?? ''), otherSourceId: String(b.otherSourceId ?? ''), title: String(b.title ?? ''), detail: String(b.detail ?? ''), compare: Array.isArray(b.compare) ? b.compare : [] }));
    return true;
  }

  /* ---------- Huddle ---------- */
  if (url === '/api/huddle' && method === 'GET') {
    // Pages of summaries, newest first (?limit, ?cursor, ?status=open|decided, ?mine=1, ?waiting=me, ?domain, ?q); details per item on demand.
    const status = ctx.query.get('status');
    const limit = Number(ctx.query.get('limit'));
    const domain = ctx.query.get('domain');
    if (domain && !HUDDLE_DOMAINS.includes(domain as HuddleDomain)) throw new HttpError(400, `domain must be one of ${HUDDLE_DOMAINS.join(', ')}.`);
    send(
      200,
      listPage(db, app.id, user.id, {
        status: status === 'open' || status === 'decided' ? status : 'all',
        mine: ctx.query.get('mine') === '1',
        waiting: ['me', '1'].includes(ctx.query.get('waiting') ?? ''),
        domain: (domain as HuddleDomain) || undefined,
        q: ctx.query.get('q') ?? undefined,
        limit: Number.isInteger(limit) && limit >= 1 ? limit : undefined,
        cursor: ctx.query.get('cursor'),
      }),
    );
    return true;
  }
  if (url === '/api/huddle/people' && method === 'GET') {
    // The application's people, for an action's owner.
    const people = db.raw
      .prepare("SELECT u.id, u.name, u.initials, GROUP_CONCAT(m.role) AS roles FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.application_id = ? GROUP BY u.id ORDER BY u.name")
      .all(app.id) as { id: string; name: string; initials: string; roles: string }[];
    send(200, { people: people.map((p) => ({ ...p, roles: p.roles.split(',') })) });
    return true;
  }
  if (url === '/api/huddle/from-chat' && method === 'POST') {
    // "Raise with the team" from a finished answer: a Concern with the question, the answer's opening and its sources.
    const b = (await ctx.readJson()) as Record<string, unknown>;
    if (!isStr(b.chatId) || !ID.test(b.chatId) || !isStr(b.messageId) || !ID.test(b.messageId)) throw new HttpError(400, 'chatId and messageId are required.');
    const r = raiseFromChat(db, app, user.id, { chatId: b.chatId, messageId: b.messageId, title: isStr(b.title) ? b.title : undefined, note: isStr(b.note) ? b.note : undefined });
    send(r.already ? 200 : 201, r);
    return true;
  }
  if (url === '/api/huddle' && method === 'POST') {
    const b = (await ctx.readJson()) as Record<string, unknown>;
    const kind = HUDDLE_KINDS.includes(b.kind as HuddleKind) ? (b.kind as HuddleKind) : null;
    if (!kind) throw new HttpError(400, `kind must be one of ${HUDDLE_KINDS.join(', ')}.`);
    if (kind === 'conflict') throw new HttpError(400, 'Raise a source conflict from App Context (POST /api/context/conflicts), so the passages are excluded with it.');
    if (b.domain != null && !HUDDLE_DOMAINS.includes(b.domain as HuddleDomain)) throw new HttpError(400, `domain must be one of ${HUDDLE_DOMAINS.join(', ')}.`);
    if (b.severity != null && !SEVERITIES.includes(b.severity as Severity)) throw new HttpError(400, `severity must be one of ${SEVERITIES.join(', ')}.`);
    const options = (Array.isArray(b.options) ? b.options : [])
      .map((o: unknown) => {
        if (isStr(o)) return { title: o, detail: '' };
        const r = (o ?? {}) as Record<string, unknown>;
        return { title: String(r.title ?? ''), detail: String(r.detail ?? ''), accepts: typeof r.accepts === 'boolean' ? r.accepts : undefined };
      })
      .filter((o: { title: string }) => o.title.trim());
    const affects = (Array.isArray(b.affects) ? b.affects : []).map((a: unknown) => (isStr(a) ? { label: a } : { label: String((a as Record<string, unknown>)?.label ?? ''), href: isStr((a as Record<string, unknown>)?.href) ? String((a as Record<string, unknown>).href) : undefined })).filter((a: { label: string }) => a.label.trim());
    // Links to any entity: { type: story|test|run|component|chat|cve|deployment, ref, label? }; Catalyzt pages get their link.
    const links = (Array.isArray(b.links) ? b.links : []).slice(0, 20).map((l: unknown) => {
      const r = (l ?? {}) as Record<string, unknown>;
      const type = String(r.type ?? '') as HuddleLinkType;
      const ref = String(r.ref ?? '').trim().slice(0, 200);
      if (!LINK_TYPES.includes(type) || !ref) throw new HttpError(400, `Each link needs a type (${LINK_TYPES.join(', ')}) and a ref.`);
      if (type === 'cve' && !/^CVE-\d{4}-\d{4,}$/i.test(ref)) throw new HttpError(400, `${ref} is not a CVE id (CVE-YYYY-NNNN).`);
      const href = type === 'story' ? `/tickets/${encodeURIComponent(ref)}` : type === 'test' ? `/hexa/test/${encodeURIComponent(ref)}` : type === 'chat' ? `/chat/${encodeURIComponent(ref)}` : undefined;
      return { type, ref: type === 'cve' ? ref.toUpperCase() : ref, label: isStr(r.label) && r.label.trim() ? r.label : type === 'cve' ? ref.toUpperCase() : ref, href };
    });
    const item = createItem(db, app, { type: 'user', ref: user.id }, {
      kind,
      domain: (b.domain as HuddleDomain) ?? undefined,
      severity: (b.severity as Severity) ?? null,
      dueAt: isStr(b.dueAt) ? b.dueAt : null,
      expiresAt: isStr(b.expiresAt) ? b.expiresAt : null,
      title: String(b.title ?? ''),
      summary: String(b.summary ?? ''),
      scope: isStr(b.scope) ? b.scope : `${app.name} · whole app`,
      aiSummary: isStr(b.aiSummary) ? b.aiSummary : String(b.summary ?? ''),
      citations: [],
      options,
      affects,
      links,
    });
    send(201, { item });
    return true;
  }
  const actionMatch = /^\/api\/huddle\/([^/]+)\/actions\/([^/]+)\/done$/.exec(url);
  if (actionMatch && method === 'POST') {
    const id = decodeURIComponent(actionMatch[1]);
    const actionId = decodeURIComponent(actionMatch[2]);
    if (!ID.test(id) || !ID.test(actionId)) throw new HttpError(400, 'Bad id.');
    await ctx.readJson();
    send(200, { item: completeAction(db, app.id, id, actionId, user.id) });
    return true;
  }
  const itemMatch = /^\/api\/huddle\/([^/]+)(?:\/(vote|comments|needs-input|decide|answer|actions))?$/.exec(url);
  if (itemMatch) {
    const id = decodeURIComponent(itemMatch[1]);
    if (!ID.test(id)) throw new HttpError(400, 'Bad decision id.');
    const action = itemMatch[2];
    if (!action && method === 'GET') {
      const item = getItem(db, app.id, id, user.id);
      if (!item) return send(404, { error: 'This decision does not exist in this application.' }), true;
      send(200, { item });
      return true;
    }
    if (action && method === 'POST') {
      const current = getItem(db, app.id, id);
      if (!current) return send(404, { error: 'This decision does not exist in this application.' }), true;
      const b = (await ctx.readJson()) as Record<string, unknown>;
      // Deciders by domain (docs/HUDDLE.md): checked here for every step that settles the item.
      const requireDecider = (what: string) => {
        if (!canDecide(db, app.id, id, user.id)) throw new HttpError(403, `Only ${DECIDER_TEXT[current.domain]} can ${what} a ${current.domain} item.`);
      };
      if (action === 'vote') return send(200, { item: vote(db, app.id, id, user.id, String(b.optionId ?? '')) }), true;
      if (action === 'comments') return send(200, { item: comment(db, app.id, id, user.id, String(b.text ?? '')) }), true;
      if (action === 'actions') {
        const input: NewHuddleAction = { title: String(b.title ?? ''), ownerId: String(b.ownerId ?? ''), dueAt: isStr(b.dueAt) ? b.dueAt : null, link: isStr(b.link) ? b.link : null };
        return send(201, { item: addAction(db, app.id, id, user.id, input) }), true;
      }
      if (action === 'answer') {
        // A concern is answered by its raiser or the domain's decider.
        const raiser = (db.raw.prepare('SELECT raised_by FROM huddle_items WHERE id = ?').get(id) as { raised_by: string }).raised_by;
        if (raiser !== user.id) requireDecider('answer');
        return send(200, { item: answerConcern(db, app.id, id, user.id, String(b.text ?? '')) }), true;
      }
      if (action === 'needs-input') {
        requireDecider('ask for more input on');
        return send(200, { item: markNeedsInput(db, app.id, id, user.id) }), true;
      }
      // decide: the decision and its effect on App Context are one transaction.
      requireDecider('decide');
      const result = db.raw.transaction(() => {
        const r = decide(db, app.id, id, user.id, String(b.optionId ?? ''), String(b.reason ?? ''), { expiresAt: isStr(b.expiresAt) ? b.expiresAt : null });
        const conflict = r.item.kind === 'conflict' ? resolveConflictForItem(db, id, r.keepsUpload) : null;
        return { item: getItem(db, app.id, id, user.id), conflict };
      })();
      send(200, result);
      return true;
    }
  }
  return false;
}
