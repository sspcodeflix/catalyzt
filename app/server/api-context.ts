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
 *   GET  /api/huddle                        the application's decisions
 *   POST /api/huddle                        raise one: { kind, title, summary, options, affects?, scope? }
 *   GET  /api/huddle/:id
 *   POST /api/huddle/:id/vote               { optionId }
 *   POST /api/huddle/:id/comments           { text }
 *   POST /api/huddle/:id/needs-input        app owner
 *   POST /api/huddle/:id/decide             { optionId, reason }, app owner; a conflict decision is applied to App Context
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

import { addConfluence, addUploads, getSource, listChunks, listConflicts, listSources, MAX_UPLOAD_MB, raiseConflict, resolveConflictForItem, retrieveContext, syncSource, testQuestion, type ConflictInput } from './context';
import type { AppRecord, HorizonDb, PersonRecord, Role } from './db';
import { comment, createItem, decide, getItem, listItems, markNeedsInput, vote, type HuddleKind } from './huddle';
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
const KINDS: HuddleKind[] = ['conflict', 'mapping', 'risk', 'feedback'];

export { retrieveContext };

/** Keyword-only, when no models are configured. */
const KEYWORD_ONLY = (db: HorizonDb, app: string): RetrievalStatus => {
  const n = (db.raw.prepare('SELECT COUNT(*) AS n FROM source_chunks c JOIN context_sources s ON s.id = c.source_id WHERE s.application_id = ?').get(app) as { n: number }).n;
  return { mode: 'keyword', embedder: null, reranker: null, state: 'off', embedded: 0, pending: n, error: null };
};

export async function extraRoutes(ctx: RouteContext): Promise<boolean> {
  const { url, method, db, user, app, roles, send, HttpError, retrieval } = ctx;
  const requireOwner = (what: string) => {
    if (!roles.includes('app_owner')) throw new HttpError(403, `Only an app owner can ${what}.`);
  };
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
      send(200, { source, chunks: listChunks(db, app.id, id), conflict });
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
    send(200, { items: listItems(db, app.id, user.id) });
    return true;
  }
  if (url === '/api/huddle' && method === 'POST') {
    const b = (await ctx.readJson()) as Record<string, unknown>;
    const kind = KINDS.includes(b.kind as HuddleKind) ? (b.kind as HuddleKind) : null;
    if (!kind) throw new HttpError(400, `kind must be one of ${KINDS.join(', ')}.`);
    if (kind === 'conflict') throw new HttpError(400, 'Raise a source conflict from App Context (POST /api/context/conflicts), so the passages are excluded with it.');
    const options = (Array.isArray(b.options) ? b.options : []).map((o: unknown) => (isStr(o) ? { title: o, detail: '' } : { title: String((o as Record<string, unknown>)?.title ?? ''), detail: String((o as Record<string, unknown>)?.detail ?? '') })).filter((o: { title: string }) => o.title.trim());
    const affects = (Array.isArray(b.affects) ? b.affects : []).map((a: unknown) => (isStr(a) ? { label: a } : { label: String((a as Record<string, unknown>)?.label ?? ''), href: isStr((a as Record<string, unknown>)?.href) ? String((a as Record<string, unknown>).href) : undefined })).filter((a: { label: string }) => a.label.trim());
    const item = createItem(db, app, { type: 'user', ref: user.id }, {
      kind,
      title: String(b.title ?? ''),
      summary: String(b.summary ?? ''),
      scope: isStr(b.scope) ? b.scope : `${app.name} · whole app`,
      aiSummary: isStr(b.aiSummary) ? b.aiSummary : String(b.summary ?? ''),
      citations: [],
      options,
      affects,
    });
    send(201, { item });
    return true;
  }
  const itemMatch = /^\/api\/huddle\/([^/]+)(?:\/(vote|comments|needs-input|decide))?$/.exec(url);
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
      if (!getItem(db, app.id, id)) return send(404, { error: 'This decision does not exist in this application.' }), true;
      const b = (await ctx.readJson()) as Record<string, unknown>;
      if (action === 'vote') return send(200, { item: vote(db, app.id, id, user.id, String(b.optionId ?? '')) }), true;
      if (action === 'comments') return send(200, { item: comment(db, app.id, id, user.id, String(b.text ?? '')) }), true;
      if (action === 'needs-input') {
        requireOwner('ask for more input');
        return send(200, { item: markNeedsInput(db, app.id, id, user.id) }), true;
      }
      // decide: the decision and its effect on App Context are one transaction.
      requireOwner('decide');
      const result = db.raw.transaction(() => {
        const r = decide(db, app.id, id, user.id, String(b.optionId ?? ''), String(b.reason ?? ''));
        const conflict = r.item.kind === 'conflict' ? resolveConflictForItem(db, id, r.keepsUpload) : null;
        return { item: getItem(db, app.id, id, user.id), conflict };
      })();
      send(200, result);
      return true;
    }
  }
  return false;
}
