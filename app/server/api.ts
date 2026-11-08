/**
 * Server-side API for the Catalyzt UI. The DeepSeek key and the database stay here.
 * Mounted as connect middleware by the Vite plugin in vite.config.ts (dev and preview); the same
 * handler can be mounted in Express or any Node server for production.
 *
 * Who and where: every request resolves a user and an application. There is no sign-in in this
 * preview; the browser says who it is with the x-horizon-user and x-horizon-app headers (or _user
 * and _app query parameters for downloads), and the server checks the user belongs to the
 * application. Production replaces the user header with SSO; nothing else changes.
 *
 *   GET  /api/health               model and workspace status (never the key)
 *   GET  /api/me                   the user, their applications and roles, and everyone (for Sign in as)
 *   GET  /api/chats                the user's recent chats in the application (?limit, ?cursor -> nextCursor)
 *   GET  /api/chats/:id            a chat with its latest page of messages (?limit, ?before=<olderCursor>)
 *   POST /api/run                  SSE stream of WorkflowEvent: the agent workflow (server/workflow.ts)
 *   GET  /api/agents               agent activity in the application: running now, plus recent runs
 *   GET  /api/usage                token totals for the application
 *   GET  /api/stories              stories matching the Jira filter, and the filter
 *   GET  /api/stories/:key         one story
 *   POST /api/stories              create a story in the dummy Jira
 *   POST /api/stories/refine       the Story refiner agent; the refinement is stored
 *   POST /api/jira/sync            sync now
 *   PUT  /api/jira/filter          change the statuses and sync interval (app owner)
 *   GET  /api/hexa/tests           Hexa inventory (filters: q, kind, kinds, purpose, result, origin, repo), stats, scans, uploads
 *   GET  /api/hexa/tests/:id       one test: steps, links and result history
 *   POST /api/hexa/tests/:id/links link or unlink a test to a story, criterion, requirement or component
 *   GET  /api/hexa/runs            recent test runs
 *   GET  /api/hexa/manual/template Octane import template (.xlsx)
 *   GET  /api/hexa/manual/export   manual tests as an Octane import CSV
 *   POST /api/hexa/manual/import   upload manual tests (Octane .xlsx or .csv)
 *   POST /api/hexa/results/upload  upload JUnit XML results
 *   POST /api/hexa/results         CI pushes JUnit results (Bearer HEXA_INGEST_TOKEN; body names the app)
 *   POST /api/hexa/runs/sync       pull results of PR merge-commit runs from GitHub Actions (needs GITHUB_TOKEN)
 *   POST /api/hexa/scans           scan a public GitHub repo for test cases; runs in the background
 */
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { answerBlocks, applyEvent, finishAnswer, initialAnswer } from '../src/lib/answerReducer';
import { CAPABILITIES } from '../src/lib/intent';
import type { RunRequest, WorkflowEvent } from '../src/lib/workflow';
import { extraRoutes } from './api-context';
import { addAttachments, AttachmentError, attachmentsForRun } from './attachments';
import { RequestError } from './context';
import { CHAT_PAGE, componentId, OwnershipError, STATUSES, type ApprovalPayload, type HorizonDb, type PersonRecord, type Role, type StoredStory } from './db';
import { HuddleError, huddleCounts, raiseFeedbackPattern } from './huddle';
import { LocalBlobStore, type BlobStore } from './storage';
import { maxScansFromEnv, RunLimiter, runLimitsFromEnv, type RunLimits } from './limits';
import { DeepSeekError, type DeepSeekConfig } from './deepseek';
import { GitHubError } from './github';
import { ScanError, startRepoScan } from './hexa';
import { importManual, IngestError, ingestJUnit, syncGitHubActions } from './ingest';
import { octaneTemplate, toOctaneCsv } from './octane';
import { parseStoryInput, refineStory, StoryError } from './stories';
import type { Workspace } from './workspace';
import type { RetrievalService } from './retrieval';
import { runWorkflow } from './workflow';
import { analyseAgain, appCoverage, changeStories, createFlow, FlowError, flowByOrigin, flowView, flowWorker, listFlows, recordExecution, setStatus, signOff } from './flows';

const MAX_BODY = 64 * 1024;
/** Uploads (base64 files, CI results) may be larger than ordinary requests. */
const MAX_UPLOAD = 12 * 1024 * 1024;

type Next = (err?: unknown) => void;

function send(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage, max = MAX_BODY): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > max) throw new HttpError(413, max === MAX_BODY ? 'Request too large.' : 'The file is too large (limit about 8 MB).');
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'Request body must be JSON.');
  }
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const isStr = (v: unknown): v is string => typeof v === 'string';
const strArr = (v: unknown): string[] => (Array.isArray(v) ? v.filter(isStr).slice(0, 20) : []);
const history = (v: unknown) =>
  (Array.isArray(v) ? v : [])
    .filter((m): m is { role: 'user' | 'assistant'; text: string } => !!m && (m.role === 'user' || m.role === 'assistant') && isStr(m.text))
    .slice(-12);
const id = (v: unknown) => (isStr(v) && /^[A-Za-z0-9_-]{1,64}$/.test(v) ? v : undefined);

/** A story as the browser's Ticket type expects; UAT state is kept per session in the browser. */
const asTicket = (s: StoredStory) => ({ ...s, uat: { state: 'not-analysed' as const, covered: 0, total: s.acceptanceCriteria.length } });

const STORY_KEY = /\b[A-Z][A-Z0-9]+-\d+\b/g;
/** The application's stories a request can refer to: attached keys and keys written in the text or the recent history. */
function mentionedStories(db: HorizonDb, app: string, body: { text: string; tickets: string[]; history: { text: string }[] }): StoredStory[] {
  const keys = new Set<string>([...body.tickets, ...(body.text.match(STORY_KEY) ?? []), ...body.history.slice(-10).flatMap((h) => h.text.match(STORY_KEY) ?? [])]);
  const out: StoredStory[] = [];
  for (const key of keys) {
    const s = db.getStory(key);
    if (s && s.applicationId === app) out.push(s);
  }
  return out;
}

function parseRunRequest(b: unknown): Omit<RunRequest, 'syncedTickets'> {
  const r = (b ?? {}) as Record<string, unknown>;
  if (!isStr(r.text) || !r.text.trim()) throw new HttpError(400, '`text` is required.');
  const tt = (v: unknown) => (v === 'uat' || v === 'regression' ? v : null);
  const agent = r.agent === 'auto' || CAPABILITIES.includes(r.agent as never) ? (r.agent as RunRequest['agent']) : 'auto';
  const s = (r.scope ?? {}) as Record<string, unknown>;
  return {
    chatId: id(r.chatId),
    chatTitle: isStr(r.chatTitle) ? r.chatTitle.slice(0, 200) : undefined,
    messageId: id(r.messageId),
    answerId: id(r.answerId),
    attachmentIds: strArr(r.attachmentIds).map(id).filter((x): x is string => !!x),
    revision: Number.isInteger(r.revision) ? (r.revision as number) : 1,
    // The guard enforces the length limit with a clear message, so only cap far above it here.
    text: r.text.slice(0, 20_000),
    agent,
    scope: { appName: String(s.appName ?? ''), appId: String(s.appId ?? ''), workspace: String(s.workspace ?? '') },
    testType: tt(r.testType),
    testTypeSource: r.testTypeSource === 'user' || r.testTypeSource === 'rules' ? r.testTypeSource : null,
    tickets: strArr(r.tickets),
    components: strArr(r.components),
    history: history(r.history),
  };
}

function sse(res: ServerResponse) {
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Accel-Buffering', 'no');
  return (e: WorkflowEvent) => {
    if (!res.writableEnded) res.write(`data: ${JSON.stringify(e)}\n\n`);
  };
}

/**
 * Where the person comes from. `dev-picker` trusts the browser's x-horizon-user header (the
 * "Sign in as" picker) and is for development only. `proxy-header` is for a shared deployment
 * behind a sign-in proxy that sets a header with the signed-in email; browser-chosen ids are ignored.
 */
export type Identity = { mode: 'dev-picker' } | { mode: 'proxy-header'; header: string };

export interface ApiOptions {
  identity?: Identity;
  githubToken?: string;
  /** HEXA_INGEST_TOKEN: accepted for any application that has no token of its own. */
  ingestToken?: string;
  /** HEXA_INGEST_TOKEN_<APP>: an application with its own token accepts only that one. */
  ingestTokens?: Record<string, string>;
  /** Where attachment bytes live. Defaults to data/attachments on local disk. */
  files?: BlobStore;
  getWorkspace?: () => Workspace | null;
  /** Re-reads the workspace into the running database (development only; an app owner asks for it). */
  reload?: () => { summary: string };
  /** Hybrid retrieval: the embedding and reranking models and the background embedding job. Absent: keyword-only. */
  retrieval?: RetrievalService;
  /** Concurrent workflow runs per process and per person (default from HORIZON_MAX_RUNS*, else 8 and 2), or a shared limiter. */
  runLimits?: RunLimits | RunLimiter;
  /** Concurrent repository scans per process (default HORIZON_MAX_SCANS, else 2). */
  maxScans?: number;
}

/** A query integer within [min, max], or the default for anything missing, non-finite or out of range. */
const boundedInt = (v: string | null, def: number, max: number, min = 1) => {
  const n = Number(v);
  return v != null && v !== '' && Number.isFinite(n) && n >= min ? Math.min(Math.trunc(n), max) : def;
};

/** A CI run's start time, or null when it is missing, unparsable, more than five minutes ahead or before 2000. */
export const validStartedAt = (v: unknown): string | null => {
  if (!isStr(v)) return null;
  const t = Date.parse(v);
  if (Number.isNaN(t) || t > Date.now() + 5 * 60_000 || t < Date.parse('2000-01-01T00:00:00Z')) return null;
  return new Date(t).toISOString();
};

/** Reads HEXA_INGEST_TOKEN_<APP> variables into { APP: token }. */
export function ingestTokensFromEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    const m = /^HEXA_INGEST_TOKEN_([A-Za-z0-9_-]+)$/.exec(k);
    if (m && v?.trim()) out[m[1]] = v.trim();
  }
  return out;
}

/** The UAT analyst's proposed cases become manual tests in Hexa, linked to the story and its criteria. */
function addUatCases(db: HorizonDb, appId: string, story: StoredStory, cases: NonNullable<ApprovalPayload['cases']>, user: { id: string; name: string }) {
  const tests = cases.slice(0, 50).map((c) => ({
    externalId: c.id,
    name: c.title.slice(0, 300),
    description: `UAT case for ${story.key}${c.criterion ? ` ${c.criterion}` : ''}, proposed by the UAT analyst and approved in Catalyzt.`,
    testType: 'Acceptance',
    purpose: 'uat' as const,
    phase: 'New',
    owner: user.name,
    designer: 'Catalyzt UAT analyst',
    productAreas: '',
    applicationModules: story.components.join(', '),
    userTags: 'uat, horizon',
    estimatedMinutes: null,
    covers: [c.criterion ? `${story.key}#${c.criterion}` : story.key, ...story.components],
    steps: c.steps.map((s, i) => ({ type: (i === c.steps.length - 1 || /^check\b/i.test(s) ? 'validation' : 'simple') as 'simple' | 'validation', description: s })),
  }));
  return db.upsertManualTests(tests, { app: appId, origin: 'uat_analyst', purposeDefault: 'uat', filename: `UAT analysis of ${story.key}`, format: 'horizon', problems: [], userId: user.id });
}

/** Creates the /api middleware. */
export function createApi(getConfig: () => DeepSeekConfig | null, getDb: () => HorizonDb, opts: ApiOptions = {}) {
  const githubToken = opts.githubToken;
  const files = opts.files ?? new LocalBlobStore('data/attachments');
  const runLimiter = opts.runLimits instanceof RunLimiter ? opts.runLimits : new RunLimiter(opts.runLimits ?? runLimitsFromEnv(process.env));
  const maxScans = opts.maxScans ?? maxScansFromEnv(process.env);
  // Test flows analyse their stories in the background, so a long flow goes on while nobody is signed in.
  const flows = flowWorker(getDb, getConfig);
  setTimeout(flows.kick, 1000).unref?.();

  return async function api(req: IncomingMessage, res: ServerResponse, next: Next) {
    let full: URL;
    try {
      full = new URL(req.url ?? '/', 'http://x');
    } catch {
      // F18: an unparsable request line is answered, never thrown out of the listener.
      if (!(req.url ?? '').startsWith('/api/')) return next();
      return send(res, 400, { error: 'Bad request: the URL is not valid.' });
    }
    const url = full.pathname;
    if (!url.startsWith('/api/')) return next();
    const cfg = getConfig();
    const db = getDb();

    try {
      if (url === '/api/health' && req.method === 'GET') {
        const ws = opts.getWorkspace?.() ?? null;
        return send(res, 200, {
          model: cfg
            ? { configured: true, intentModel: cfg.intentModel, chatModel: cfg.chatModel, thinking: cfg.thinking, host: new URL(cfg.baseUrl).host }
            : { configured: false },
          workspace: ws ? { loaded: true, root: ws.root, apps: ws.teams.map((t) => t.id), people: ws.people.length, warnings: ws.warnings } : { loaded: false },
        });
      }

      // CI pushes results here after a merge (see docs/hexa-github-action.yml). Bearer token; the body names the application.
      if (url === '/api/hexa/results' && req.method === 'POST') {
        const perApp = opts.ingestTokens ?? {};
        if (!opts.ingestToken && Object.keys(perApp).length === 0) return send(res, 503, { error: 'Set HEXA_INGEST_TOKEN (or HEXA_INGEST_TOKEN_<APP>) on the server to accept results from CI.' });
        const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
        // Checked against every configured token before the body is read, and against the application's own token after.
        if (!bearer || ![opts.ingestToken, ...Object.values(perApp)].includes(bearer)) return send(res, 401, { error: 'Missing or wrong ingest token.' });
        const b = (await readJson(req, MAX_UPLOAD)) as Record<string, unknown>;
        const app = isStr(b.app) ? b.app : null;
        if (!app) throw new HttpError(400, 'The body must name the application in "app" (set HEXA_APP in the workflow).');
        if (!db.getApp(app)) throw new HttpError(400, `"${app}" is not a known application; "app" must be one of the application ids in Catalyzt.`);
        const expected = perApp[app] ?? opts.ingestToken;
        if (bearer !== expected) return send(res, 401, { error: `The token is not valid for application ${app}.` });
        // Each JUnit file is a string, or { path, xml } so the module the report came from is kept.
        const junit = (Array.isArray(b.junit) ? b.junit : [b.junit])
          .map((j: unknown) => {
            if (isStr(j)) return { path: null as string | null, xml: j };
            const o = j as Record<string, unknown> | null;
            return o && isStr(o.xml) ? { path: isStr(o.path) ? o.path.slice(0, 300) : null, xml: o.xml } : null;
          })
          .filter((j): j is { path: string | null; xml: string } => !!j)
          .slice(0, 50);
        const repo = isStr(b.repo) ? b.repo.slice(0, 200) : null;
        const runId = isStr(b.runId) || typeof b.runId === 'number' ? String(b.runId) : null;
        const attemptRaw = Number(b.attempt ?? 1);
        const attempt = Number.isInteger(attemptRaw) && attemptRaw > 0 ? attemptRaw : 1;
        // The same application, repository, run and attempt delivered again changes nothing.
        if (runId && db.runExists(app, 'webhook', repo, runId, attempt)) return send(res, 200, { duplicate: true, runId, attempt });
        const pr = Number(b.prNumber);
        // Results pushed by CI are recorded as the application's owner.
        const owner = (db.raw.prepare("SELECT user_id FROM memberships WHERE application_id = ? AND role = 'app_owner' LIMIT 1").get(app) as { user_id: string } | undefined)?.user_id ?? db.defaultUser()?.id;
        if (!owner) throw new HttpError(503, 'No people loaded.');
        return send(
          res,
          200,
          await ingestJUnit(
            db,
            junit.map((j, i) => ({ filename: j.path ?? `results-${i + 1}.xml`, xml: j.xml })),
            {
              app,
              source: 'webhook',
              repo,
              framework: isStr(b.framework) ? b.framework.slice(0, 60) : null,
              workflow: isStr(b.workflow) ? b.workflow.slice(0, 200) : null,
              externalRunId: runId,
              attempt,
              runUrl: isStr(b.runUrl) && /^https:\/\//.test(b.runUrl) ? b.runUrl.slice(0, 500) : null,
              event: isStr(b.event) ? b.event.slice(0, 50) : null,
              branch: isStr(b.branch) ? b.branch.slice(0, 200) : null,
              sha: isStr(b.sha) && /^[0-9a-f]{7,40}$/i.test(b.sha) ? b.sha : null,
              prNumber: Number.isInteger(pr) && pr > 0 ? pr : null,
              isMerge: b.mergeCommit === true || (Number.isInteger(pr) && pr > 0),
              // F17: run timing comes from CI; a missing, unparsable, future or ancient value counts as missing, never as "now".
              startedAt: validStartedAt(b.startedAt),
            },
            owner,
          ),
        );
      }

      /* ---------- Who, and which application ---------- */
      if (db.isEmpty()) return send(res, 503, { error: 'No workspace is loaded, so Catalyzt has no people or applications. See SIMULATION_PLAN.md.' });
      const identity: Identity = opts.identity ?? { mode: 'dev-picker' };
      let user: PersonRecord;
      if (identity.mode === 'proxy-header') {
        const v = req.headers[identity.header.toLowerCase()];
        const email = (Array.isArray(v) ? v[0] : v)?.trim().toLowerCase() ?? '';
        if (!email) throw new HttpError(401, `Not signed in: the ${identity.header} header is missing. Catalyzt must be reached through the sign-in proxy.`);
        const found = db.getUserByEmail(email);
        if (!found) throw new HttpError(403, `${email} is not a member of this Catalyzt workspace.`);
        user = found;
      } else {
        const userHeader = req.headers['x-horizon-user'];
        const userId = (isStr(userHeader) ? userHeader : full.searchParams.get('_user')) ?? '';
        user = (userId && db.getUser(userId)) || db.defaultUser()!;
      }
      const apps = db.appsFor(user.id);
      const appHeader = req.headers['x-horizon-app'];
      const wantedApp = (isStr(appHeader) ? appHeader : full.searchParams.get('_app')) ?? '';
      let app = wantedApp ? apps.find((a) => a.id === wantedApp) : apps[0];
      if (wantedApp && !app) {
        if (!db.getApp(wantedApp)) throw new HttpError(404, `Application "${wantedApp}" does not exist.`);
        throw new HttpError(403, `${user.name} is not a member of ${wantedApp}.`);
      }
      const roles: Role[] = app?.roles ?? [];
      const requireRole = (allowed: Role[], what: string) => {
        if (!roles.some((r) => allowed.includes(r))) throw new HttpError(403, `Only ${allowed.map((r) => r.replace('_', ' ')).join(' or ')} can ${what}.`);
      };

      if (url === '/api/me' && req.method === 'GET') {
        // The people list exists only for the development picker; behind a proxy there is nobody to switch to.
        return send(res, 200, { user, apps, app: app ?? null, people: identity.mode === 'dev-picker' ? db.listPeople() : [], identity: identity.mode === 'dev-picker' ? 'dev' : 'proxy' });
      }
      if (!app) throw new HttpError(403, `${user.name} is not a member of any application.`);
      const appId = app.id;
      const member = app;

      // App Context and Huddle routes live in api-context.ts.
      if (
        await extraRoutes({
          req,
          res,
          url,
          method: req.method ?? 'GET',
          query: full.searchParams,
          db,
          user,
          app: member,
          roles,
          files,
          retrieval: opts.retrieval,
          readJson: (max) => readJson(req, max),
          send: (status, body) => send(res, status, body),
          HttpError,
        })
      )
        return;

      if (url === '/api/chats' && req.method === 'GET') {
        // Recent chats a page at a time (?limit, ?cursor); without them, the first 12 as before.
        return send(res, 200, db.listChatsPage(appId, user.id, { limit: boundedInt(full.searchParams.get('limit'), 12, 100), cursor: full.searchParams.get('cursor') }));
      }

      // Development only: seed the running server from the workspace again (new stories, edited manual tests).
      if (url === '/api/workspace/reload' && req.method === 'POST') {
        if (identity.mode !== 'dev-picker' || !opts.reload) throw new HttpError(404, 'Not found.');
        requireRole(['app_owner'], 'reload the workspace');
        const r = opts.reload();
        db.audit('user', user.id, 'workspace.reload', 'workspace', 'all', {});
        return send(res, 200, { ok: true, summary: r.summary });
      }

      /* ---------- Test flows (docs/FLOWS.md) ---------- */
      if (url.startsWith('/api/flows') || /^\/api\/hexa\/tests\/[^/]+\/executions$/.test(url)) {
        try {
          const str = (v: unknown, max = 200) => (isStr(v) ? v.slice(0, max) : '');
          const keys = (v: unknown) => (Array.isArray(v) ? v.filter(isStr).map((k) => k.trim()).filter((k) => /^[A-Z][A-Z0-9]+-\d+$/.test(k)).slice(0, 101) : []);
          if (url === '/api/flows' && req.method === 'GET') {
            // ?origin=<answer revision>: the flow a chat answer's Start card started, if any.
            const origin = full.searchParams.get('origin');
            if (origin) return send(res, 200, { flowId: /^[A-Za-z0-9_-]{1,80}$/.test(origin) ? flowByOrigin(db, appId, origin) : null });
            return send(res, 200, { flows: listFlows(db, member, user.id, { all: full.searchParams.get('all') === '1' }) });
          }
          if (url === '/api/flows/coverage' && req.method === 'GET') return send(res, 200, appCoverage(db, member));
          if (url === '/api/flows' && req.method === 'POST') {
            const b = (await readJson(req)) as Record<string, unknown>;
            const kind = b.kind === 'uat' || b.kind === 'regression' ? b.kind : null;
            if (!kind) throw new HttpError(400, 'kind must be uat or regression.');
            const origin = str(b.origin, 80);
            const fid = createFlow(db, member, user, roles, { kind, title: str(b.title, 120), stories: keys(b.stories), origin: /^[A-Za-z0-9_-]{1,80}$/.test(origin) ? origin : null });
            flows.kick();
            return send(res, 201, { flow: flowView(db, member, fid, user.id, roles) });
          }
          const fm = /^\/api\/flows\/([A-Za-z0-9_-]{1,64})(?:\/(status|stories|analyse|signoff))?$/.exec(url);
          if (fm && !fm[2] && req.method === 'GET') return send(res, 200, { flow: flowView(db, member, fm[1], user.id, roles) });
          if (fm && fm[2] && req.method === 'POST') {
            const b = (await readJson(req)) as Record<string, unknown>;
            if (fm[2] === 'status') {
              const st = b.status === 'active' || b.status === 'paused' || b.status === 'cancelled' ? b.status : null;
              if (!st) throw new HttpError(400, 'status must be active, paused or cancelled.');
              setStatus(db, member, fm[1], user, roles, st);
            } else if (fm[2] === 'stories') {
              changeStories(db, member, fm[1], user, roles, keys(b.add), keys(b.remove));
              flows.kick();
            } else if (fm[2] === 'analyse') {
              analyseAgain(db, member, fm[1], user, roles, str(b.storyKey, 40));
              flows.kick();
            } else {
              const decision = b.decision === 'signed_off' || b.decision === 'rejected' ? b.decision : null;
              if (!decision) throw new HttpError(400, 'decision must be signed_off or rejected.');
              signOff(db, member, fm[1], user, roles, str(b.storyKey, 40), decision, str(b.note, 1000) || null);
            }
            return send(res, 200, { flow: flowView(db, member, fm[1], user.id, roles) });
          }
          const em = /^\/api\/hexa\/tests\/([^/]+)\/executions$/.exec(url);
          if (em && req.method === 'POST') {
            const b = (await readJson(req)) as Record<string, unknown>;
            const status = b.status === 'passed' || b.status === 'failed' || b.status === 'blocked' ? b.status : null;
            if (!status) throw new HttpError(400, 'status must be passed, failed or blocked.');
            return send(res, 201, recordExecution(db, member, decodeURIComponent(em[1]), user, roles, status, str(b.note, 2000) || null));
          }
        } catch (e) {
          if (e instanceof FlowError) throw new HttpError(e.status, e.message);
          throw e;
        }
      }

      // The home page's entry points: real work waiting in this application, never invented numbers.
      if (url === '/api/home' && req.method === 'GET') {
        const runs = db.listRuns(appId, 10);
        const latest = runs[0];
        return send(res, 200, {
          pendingApprovals: db.listPendingApprovals(appId, 10),
          openDecisions: huddleCounts(db, appId, null).open,
          stories: db.countStories(appId),
          runs: { recent: runs.length, failed: runs.filter((r) => r.status === 'failed').length, latest: latest ? { id: latest.id, repo: latest.repo, status: latest.status, at: latest.at, prNumber: latest.prNumber } : null },
          tests: db.testStats(appId).total,
          flows: listFlows(db, member, user.id),
        });
      }

      if (url === '/api/run' && req.method === 'POST') {
        // Criterion 2: a bounded number of workflows per process and per person. Over the limit the
        // request is refused before its body is read, so nothing is written.
        const slot = runLimiter.acquire(user.id);
        if (!slot.ok) {
          res.setHeader('Retry-After', String(slot.retryAfterSeconds));
          return send(res, 429, { error: slot.message, limit: slot.scope });
        }
        res.once('close', slot.release);
        res.once('finish', slot.release);
        const body = parseRunRequest(await readJson(req));
        // The ids the browser sends must belong together, to this application, and to this person,
        // before anything runs or is written. A chat of another application is not disclosed (404).
        if (body.chatId || body.messageId || body.answerId) {
          if (!body.chatId || !body.messageId || !body.answerId) throw new HttpError(400, 'chatId, messageId and answerId go together.');
          if (body.messageId === body.answerId) throw new HttpError(400, 'messageId and answerId must differ.');
          const chat = db.getChat(body.chatId);
          if (chat && chat.applicationId !== appId) throw new HttpError(404, 'This chat does not exist in this application.');
          if (chat && chat.createdBy !== user.id) throw new HttpError(403, 'Only the person who started this chat can add to it.');
          const m = db.messageChat(body.messageId);
          if (m && (m.chatId !== body.chatId || m.role !== 'user')) throw new HttpError(409, 'messageId belongs to another chat or answer.');
          const a = db.messageChat(body.answerId);
          if (a && (a.chatId !== body.chatId || a.role !== 'assistant')) throw new HttpError(409, 'answerId belongs to another chat or message.');
        }
        // Attached files must be this person's, in this application, and not another chat's.
        const attachments = body.attachmentIds?.length ? attachmentsForRun(db, appId, user.id, body.attachmentIds, body.chatId) : [];
        const abort = new AbortController();
        res.on('close', () => abort.abort());
        const write = sse(res);
        // The same reducer the browser renders with builds the answer that gets stored.
        let answer = initialAnswer();
        const emit = (e: WorkflowEvent) => {
          answer = applyEvent(answer, e);
          write(e);
        };
        // Stories come from the database, never from the browser; only this application's.
        const run: RunRequest = {
          ...body,
          // Revisions are numbered by the server; the browser's number is never trusted.
          revision: body.answerId ? db.nextRevision(body.answerId) : 1,
          scope: { appName: member.name, appId, workspace: body.scope.workspace || member.workspaces[0] || '' },
          // Only the stories the request can refer to are hydrated (attached keys, keys in the text or
          // recent history), never the whole backlog per request.
          syncedTickets: mentionedStories(db, appId, body).map(asTicket),
          knownComponents: member.components.map((c) => c.name),
          attachments,
        };
        let workflowRunId: string | null = null;
        let failure: string | undefined;
        try {
          workflowRunId = (await runWorkflow(run, cfg, emit, abort.signal, { db, userId: user.id, app: appId, models: opts.retrieval?.models })).workflowRunId;
        } catch (e) {
          if (!abort.signal.aborted) {
            failure = e instanceof DeepSeekError ? e.userMessage : 'The answer failed. Try again.';
            console.error('[horizon api] workflow failed:', (e as Error).message);
            emit({ type: 'error', message: failure });
          }
        }
        if (body.chatId && body.messageId && body.answerId) {
          const final = failure || abort.signal.aborted ? finishAnswer(answer, abort.signal.aborted, failure) : answer;
          // Committed before the browser hears "saved"; a client that stopped still gets its revision stored.
          const saved = db.saveAnswer({
            app: appId,
            chatId: body.chatId,
            answerId: body.answerId,
            userMessageId: body.messageId,
            workflowRunId,
            userId: user.id,
            status: final.status,
            intent: final.intent,
            blocks: answerBlocks(final),
            citations: final.citations,
            artifact: final.artifact ?? null,
          });
          if (!abort.signal.aborted) write({ type: 'saved', revisionId: saved.revisionId, revision: saved.revision, approvals: saved.approvals });
        }
        return res.end();
      }

      // Uploads: bytes to the blob store, metadata and readable text to the database.
      if (url === '/api/attachments' && req.method === 'POST') {
        const b = (await readJson(req, MAX_UPLOAD)) as Record<string, unknown>;
        const list = (Array.isArray(b.files) ? b.files : []).slice(0, 20).map((f: Record<string, unknown>) => ({
          filename: String(f.filename ?? 'file'),
          data: Buffer.from(String(f.contentBase64 ?? ''), 'base64'),
        }));
        const chatId = id(b.chatId) ?? null;
        return send(res, 200, await addAttachments(db, files, member, user, list, chatId));
      }
      const attachmentMatch = /^\/api\/attachments\/([A-Za-z0-9_-]{1,64})$/.exec(url);
      if (attachmentMatch && req.method === 'GET') {
        const a = db.getAttachment(attachmentMatch[1]);
        if (!a || a.applicationId !== appId) return send(res, 404, { error: 'This attachment does not exist in this application.' });
        if (full.searchParams.get('download') !== '1') return send(res, 200, { attachment: { ...a, storageKey: undefined } });
        const data = await files.get(a.storageKey);
        if (!data) return send(res, 410, { error: 'The file is no longer in storage.' });
        res.statusCode = 200;
        res.setHeader('Content-Type', a.mime);
        res.setHeader('Content-Length', String(data.length));
        res.setHeader('Content-Disposition', `attachment; filename="${a.filename.replace(/"/g, '')}"`);
        res.setHeader('Cache-Control', 'private, no-store');
        return res.end(data);
      }

      const chatMatch = /^\/api\/chats\/([A-Za-z0-9_-]{1,64})$/.exec(url);
      if (chatMatch && req.method === 'GET') {
        // The latest page of messages (?limit); ?before=<olderCursor> reads the page before it.
        const before = full.searchParams.get('before');
        const chat = db.getChatFull(chatMatch[1], user.id, { limit: boundedInt(full.searchParams.get('limit'), CHAT_PAGE, 200, 2), before: before != null && /^\d+$/.test(before) ? Number(before) : null });
        if (!chat || chat.applicationId !== appId) return send(res, 404, { error: 'This chat does not exist in this application.' });
        return send(res, 200, { chat });
      }

      const ratingMatch = /^\/api\/answers\/([A-Za-z0-9_-]{1,80})\/rating$/.exec(url);
      if (ratingMatch && req.method === 'POST') {
        const rev = db.revisionChat(ratingMatch[1]);
        if (!rev || rev.app !== appId) return send(res, 404, { error: 'This answer does not exist in this application.' });
        const b = (await readJson(req)) as Record<string, unknown>;
        const stars = Number(b.stars);
        if (!Number.isInteger(stars) || stars < 1 || stars > 5) throw new HttpError(400, 'Stars must be 1 to 5.');
        const reasons = strArr(b.reasons).map((x) => x.slice(0, 60)).slice(0, 10);
        const comment = isStr(b.comment) ? b.comment.trim().slice(0, 280) : '';
        // Below 4 stars the feedback must be usable: a reason and what was expected (DESIGN.md, Feedback).
        if (stars < 4 && reasons.length === 0) throw new HttpError(400, 'Pick at least one reason.');
        if (stars < 4 && comment.length < 10) throw new HttpError(400, 'Say what you expected, in at least 10 characters.');
        db.rateAnswer({ revisionId: ratingMatch[1], userId: user.id, stars, reasons, comment: comment || null });
        db.audit('user', user.id, 'answer.rate', 'answer_revision', ratingMatch[1], { stars, reasons });
        // The feedback-pattern rule: a reason shared 3+ times in 7 days for one capability goes to Huddle, once.
        const patterns = stars < 4 ? db.lowRatingPatterns(appId) : [];
        const raised = patterns.map((p) => raiseFeedbackPattern(db, member, p)).filter((i) => i !== null).map((i) => i!.id);
        return send(res, 200, { ok: true, stars, patterns, raised });
      }

      const approvalMatch = /^\/api\/approvals\/([A-Za-z0-9_-]{1,96})\/decision$/.exec(url);
      if (approvalMatch && req.method === 'POST') {
        const found = db.getApproval(approvalMatch[1]);
        if (!found || found.app !== appId) return send(res, 404, { error: 'This approval does not exist in this application.' });
        const b = (await readJson(req)) as Record<string, unknown>;
        const decision = b.decision === 'approved' || b.decision === 'declined' ? b.decision : null;
        if (!decision) throw new HttpError(400, 'decision must be approved or declined.');
        const view = (a: NonNullable<typeof found>) => ({ id: a.id, status: a.status, decidedAt: a.decidedAt ?? undefined, decidedBy: a.decidedByName ?? undefined, outcome: a.outcome ?? undefined, revisionId: a.revisionId, supersededBy: a.supersededBy });
        // The same decision delivered again is answered with what was recorded; a different one is a conflict.
        const settled = (a: NonNullable<typeof found>) => {
          if (a.status === decision) return send(res, 200, { approval: view(a), replay: true });
          throw new HttpError(409, a.status === 'expired' ? 'This approval was superseded by a newer revision of the answer.' : `This was already ${a.status}.`);
        };
        if (found.status !== 'pending') return settled(found);
        // Server-side rules: an owner or a component manager decides, and approving needs a rating first.
        requireRole(['app_owner', 'component_manager'], `${decision === 'approved' ? 'approve' : 'decline'} a change`);
        if (decision === 'approved' && !db.hasRating(found.revisionId, user.id)) throw new HttpError(403, 'Rate the answer before approving.');
        // F19: a component manager decides only changes to components they manage, taken from the frozen
        // payload (older approvals: the story's components); an owner decides any. A change that names no
        // component is the owner's to decide.
        if (!roles.includes('app_owner')) {
          const targets = found.payload.components ?? (found.payload.storyKey ? db.getStory(found.payload.storyKey)?.components ?? [] : []);
          if (targets.length === 0) throw new HttpError(403, 'This change names no component you manage; only an app owner can decide it.');
          const foreign = targets.filter((name) => member.components.find((c) => c.name === name)?.managerId !== user.id);
          if (foreign.length) throw new HttpError(403, `Only the manager of ${foreign.join(', ')} or an app owner can decide this change.`);
        }
        // The action runs from the payload frozen with the approval, inside the decision's transaction.
        const execute =
          decision === 'approved' && found.action === 'add_uat_cases'
            ? (payload: ApprovalPayload) => {
                const story = payload.storyKey ? db.getStory(payload.storyKey) : undefined;
                if (!story || story.applicationId !== appId) throw new HttpError(409, 'The story this approval refers to is no longer in this application.');
                if (!payload.cases?.length) throw new HttpError(409, 'This approval has no test cases to add.');
                const r = addUatCases(db, appId, story, payload.cases, user);
                const n = r.created + r.updated;
                return { ok: true, text: `Added ${n} manual test${n === 1 ? '' : 's'} to Hexa, linked to ${story.key}` };
              }
            : undefined;
        const result = db.decideApproval(found.id, decision, user.id, execute);
        if (result.kind === 'missing') return send(res, 404, { error: 'This approval does not exist in this application.' });
        if (result.kind === 'already') return settled(result.approval);
        return send(res, 200, { approval: view(result.approval) });
      }

      if (url === '/api/hexa/tests' && req.method === 'GET') {
        const p = full.searchParams;
        const pick = (k: string, allowed: string[]) => (allowed.includes(p.get(k) ?? '') ? (p.get(k) as string) : undefined);
        return send(res, 200, {
          ...db.listTests(appId, {
            q: (p.get('q') ?? '').slice(0, 100) || undefined,
            // The tests that belong to one component (by link, repository, path and package), not a text search.
            component: (p.get('component') ?? '').slice(0, 100) || undefined,
            kind: pick('kind', ['automated', 'manual', 'proposed']),
            kinds: (p.get('kinds') ?? '').split(',').filter((k) => ['automated', 'manual', 'proposed'].includes(k)),
            purpose: pick('purpose', ['uat', 'regression']),
            result: pick('result', ['passed', 'failed', 'skipped', 'not_run', 'none']),
            origin: pick('origin', ['repo_scan', 'uat_analyst', 'authoring', 'manual', 'upload', 'ci_results']),
            repo: p.get('repo')?.slice(0, 200) || undefined,
            // F26: a page size is a positive integer up to the cap; anything else is the default.
            limit: boundedInt(p.get('limit'), 50, 200),
            offset: boundedInt(p.get('offset'), 0, 1_000_000, 0),
          }),
          stats: db.testStats(appId),
          scans: db.listScans(appId, 8),
          uploads: db.listUploads(appId, 6),
        });
      }

      const testMatch = /^\/api\/hexa\/tests\/([A-Za-z0-9_-]{1,64})(\/links)?$/.exec(url);
      if (testMatch && req.method === 'GET' && !testMatch[2]) {
        const t = db.getTest(testMatch[1]);
        if (!t || t.applicationId !== appId) return send(res, 404, { error: `${testMatch[1]} does not exist in ${appId}.` });
        return send(res, 200, { test: t });
      }
      if (testMatch && req.method === 'POST' && testMatch[2]) {
        const t = db.getTest(testMatch[1]);
        if (!t || t.applicationId !== appId) return send(res, 404, { error: `${testMatch[1]} does not exist in ${appId}.` });
        const b = (await readJson(req)) as Record<string, unknown>;
        const type = b.type;
        if (type !== 'story' && type !== 'criterion' && type !== 'requirement' && type !== 'component') throw new HttpError(400, 'type must be story, criterion, requirement or component.');
        const ref = isStr(b.ref) ? b.ref.trim().slice(0, 120) : '';
        if (!ref) throw new HttpError(400, 'ref is required.');
        const storyKey = type === 'criterion' ? ref.split('#')[0] : type === 'story' ? ref : null;
        if (storyKey) {
          const s = db.getStory(storyKey);
          if (!s || s.applicationId !== appId) throw new HttpError(400, `${storyKey} is not a story of ${appId}.`);
          if (type === 'criterion') {
            const n = Number(/^AC(\d+)$/.exec(ref.split('#')[1] ?? '')?.[1]);
            if (!n || n > s.acceptanceCriteria.length) throw new HttpError(400, `${storyKey} has no criterion ${ref.split('#')[1] ?? ''}.`);
          }
        }
        if (type === 'component' && !member.components.some((c) => c.name === ref)) throw new HttpError(400, `${ref} is not a component of ${appId}.`);
        // An automated test from a repository the target does not live in is almost always a mistake (a
        // word-matched link): refused with the reason unless the person confirms; coverage never counts it anyway.
        if (b.remove !== true && b.force !== true && t.kind === 'automated' && t.repo) {
          const targetComponents = type === 'component' ? [ref] : storyKey ? (db.getStory(storyKey)?.components ?? []) : [];
          const repos = new Set(member.components.filter((c) => targetComponents.includes(c.name) && c.repo).map((c) => c.repo as string));
          if (repos.size && !repos.has(t.repo)) {
            return send(res, 409, {
              error: `${t.id} is a test in ${t.repo}, but ${type === 'component' ? ref : storyKey} lives in ${[...repos].join(', ')}. It would not count as evidence. Link it anyway only if that is really intended.`,
              code: 'other_repo',
            });
          }
        }
        db.linkTest(t.id, type, type === 'component' ? componentId(appId, ref) : ref, user.id, b.remove === true);
        return send(res, 200, { test: db.getTest(t.id) });
      }

      if (url === '/api/hexa/runs' && req.method === 'GET') {
        return send(res, 200, { runs: db.listRuns(appId, 30) });
      }

      if (url === '/api/hexa/manual/template' && req.method === 'GET') {
        const buf = await octaneTemplate(db.listStories(appId)[0]?.key);
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', 'attachment; filename="hexa-octane-manual-tests-template.xlsx"');
        return res.end(buf);
      }

      if (url === '/api/hexa/manual/export' && req.method === 'GET') {
        const ids = (full.searchParams.get('ids') ?? '').split(',').filter((x) => /^[A-Za-z0-9_-]{1,64}$/.test(x));
        res.statusCode = 200;
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="hexa-${appId}-manual-tests-octane-${new Date().toISOString().slice(0, 10)}.csv"`);
        return res.end(`﻿${toOctaneCsv(db.manualForExport(appId, ids))}`);
      }

      if (url === '/api/hexa/manual/import' && req.method === 'POST') {
        const b = (await readJson(req, MAX_UPLOAD)) as Record<string, unknown>;
        const data = Buffer.from(String(b.contentBase64 ?? ''), 'base64');
        if (!data.length) throw new HttpError(400, 'Choose a file to upload.');
        const purpose = b.purpose === 'uat' || b.purpose === 'regression' ? b.purpose : null;
        return send(res, 200, await importManual(db, appId, { filename: String(b.filename ?? 'upload'), data }, purpose, user.id));
      }

      if (url === '/api/hexa/results/upload' && req.method === 'POST') {
        const b = (await readJson(req, MAX_UPLOAD)) as Record<string, unknown>;
        const files = (Array.isArray(b.files) ? b.files : []).slice(0, 20).map((f: Record<string, unknown>) => ({
          filename: String(f.filename ?? 'results.xml'),
          xml: Buffer.from(String(f.contentBase64 ?? ''), 'base64').toString('utf8'),
        }));
        const repo = isStr(b.repo) && b.repo.trim() ? b.repo.trim().slice(0, 200) : null;
        const pr = Number(b.prNumber);
        return send(
          res,
          200,
          await ingestJUnit(
            db,
            files,
            {
              app: appId,
              source: 'upload',
              repo,
              workflow: isStr(b.workflow) && b.workflow.trim() ? b.workflow.slice(0, 200) : null,
              externalRunId: null,
              attempt: 1,
              runUrl: isStr(b.runUrl) && /^https:\/\//.test(b.runUrl) ? b.runUrl.slice(0, 500) : null,
              event: 'upload',
              branch: isStr(b.branch) && b.branch.trim() ? b.branch.slice(0, 200) : null,
              sha: isStr(b.sha) && /^[0-9a-f]{7,40}$/i.test(b.sha) ? b.sha : null,
              prNumber: Number.isInteger(pr) && pr > 0 ? pr : null,
              isMerge: Number.isInteger(pr) && pr > 0,
              startedAt: null,
            },
            user.id,
          ),
        );
      }

      if (url === '/api/hexa/runs/sync' && req.method === 'POST') {
        const b = (await readJson(req)) as Record<string, unknown>;
        return send(res, 200, await syncGitHubActions(db, appId, String(b.repo ?? ''), githubToken, user.id));
      }

      if (url === '/api/hexa/scans' && req.method === 'POST') {
        const b = (await readJson(req)) as Record<string, unknown>;
        try {
          return send(res, 202, startRepoScan(db, appId, String(b.repo ?? ''), user.id, githubToken, maxScans));
        } catch (e) {
          if (e instanceof ScanError && e.status === 429) res.setHeader('Retry-After', '30');
          if (e instanceof ScanError) throw new HttpError(e.status, e.message);
          throw e;
        }
      }

      if (url === '/api/usage' && req.method === 'GET') {
        return send(res, 200, db.usage(appId));
      }

      if (url === '/api/agents' && req.method === 'GET') {
        return send(res, 200, { agents: db.listAgentActivity({ app: appId, recent: 60 }), at: new Date().toISOString() });
      }

      if (url === '/api/stories' && req.method === 'GET') {
        const filter = db.getFilter(appId);
        // R13: each story carries its latest saved UAT analysis, so the Search page is right after a reload.
        const states = db.uatStates(appId);
        return send(res, 200, { stories: db.listStories(appId, filter).map((s) => ({ ...s, uat: states.get(s.key) ?? { state: 'not-analysed', covered: 0, total: s.acceptanceCriteria.length } })), filter });
      }

      if (url === '/api/stories' && req.method === 'POST') {
        const input = parseStoryInput(await readJson(req), user.id, member.components.map((c) => c.name));
        const story = db.createStory(input, appId);
        return send(res, 201, { story, visible: db.getFilter(appId).statuses.includes(story.status as never) });
      }

      if (url === '/api/stories/refine' && req.method === 'POST') {
        const abort = new AbortController();
        res.on('close', () => abort.abort());
        const body = await readJson(req);
        // The refiner is an agent like any other: it gets a workflow run, so it shows on the Agents page.
        const wf = randomUUID();
        const agentId = randomUUID();
        db.startWorkflow({ id: wf, app: appId, chatId: null, messageId: null, revision: 1, userId: user.id });
        db.startAgent({ id: agentId, workflowRunId: wf, parentId: null, agent: 'Story refiner', kind: 'refiner', task: 'Refine a story and its acceptance criteria', model: cfg?.intentModel ?? null });
        const stepId = randomUUID();
        db.addStep({ id: stepId, agentRunId: agentId, kind: cfg ? 'model' : 'rule', label: 'Refining the story' });
        try {
          const r = await refineStory(body, cfg, abort.signal);
          if (r.call && cfg) {
            db.recordModelCall({
              workflowRunId: wf,
              agentRunId: agentId,
              agent: 'Story refiner',
              userId: user.id,
              model: cfg.intentModel,
              purpose: 'refine',
              status: r.call.status,
              promptTokens: r.call.usage?.promptTokens ?? null,
              completionTokens: r.call.usage?.completionTokens ?? null,
              latencyMs: r.call.latencyMs,
            });
          }
          db.finishStep(stepId, { status: 'done', label: r.source === 'model' ? 'Refined with the model' : 'Tidied with rules', detail: r.note });
          db.finishAgent(agentId, {
            status: 'done',
            result: `${r.output.acceptanceCriteria.length} criteria, ${r.output.questions.length} questions`,
            model: r.model,
            promptTokens: r.call?.usage?.promptTokens,
            completionTokens: r.call?.usage?.completionTokens,
          });
          db.finishWorkflow(wf, 'done', 'Story refined');
          const refinementId = db.saveRefinement({ input: r.input, output: r.output, source: r.source, model: r.model, agentRunId: agentId, createdBy: user.id });
          return send(res, 200, { refinementId, refined: r.output, source: r.source, model: r.model, note: r.note ?? null });
        } catch (e) {
          const rejected = e instanceof StoryError && e.policy;
          db.finishStep(stepId, { status: 'failed', detail: (e as Error).message });
          db.finishAgent(agentId, { status: rejected ? 'rejected' : 'failed', error: (e as Error).message });
          db.finishWorkflow(wf, rejected ? 'rejected' : 'failed', rejected ? 'Rejected by the story guard' : 'Failed');
          if (e instanceof StoryError && e.policy) db.guardEvent({ workflowRunId: wf, agentRunId: agentId, layer: 'story', policy: e.policy.id, userId: user.id });
          throw e;
        }
      }

      const storyKey = /^\/api\/stories\/([A-Z][A-Z0-9]+-\d+)$/.exec(url)?.[1];
      if (storyKey && req.method === 'GET') {
        const story = db.getStory(storyKey);
        return story && story.applicationId === appId ? send(res, 200, { story }) : send(res, 404, { error: `${storyKey} does not exist in ${appId}.` });
      }

      if (url === '/api/jira/sync' && req.method === 'POST') {
        // F22: stories come from the workspace backlog, not a live Jira. An owner re-imports the backlog
        // (the same reload as the workspace); anyone else re-reads the rows, and nothing claims a sync happened.
        let notice = 'Stories come from the workspace backlog; there is no live Jira connection in this build.';
        if (opts.reload && roles.includes('app_owner')) notice = `Backlog re-imported from the workspace. ${opts.reload().summary}`;
        else notice += opts.reload ? ' Only an app owner can re-import the backlog.' : ' Restart the service to re-import an edited backlog.';
        const filter = db.getFilter(appId);
        return send(res, 200, { stories: db.listStories(appId, filter), filter, notice });
      }

      if (url === '/api/jira/filter' && req.method === 'PUT') {
        requireRole(['app_owner'], 'change the Jira filter');
        const b = (await readJson(req)) as Record<string, unknown>;
        const statuses = strArr(b.statuses).filter((s): s is (typeof STATUSES)[number] => STATUSES.includes(s as never));
        const every = Number(b.everyMinutes);
        if (statuses.length === 0) throw new HttpError(400, 'Choose at least one status.');
        if (![5, 15, 30, 60].includes(every)) throw new HttpError(400, 'Sync interval must be 5, 15, 30 or 60 minutes.');
        const filter = db.setFilter({ statuses: [...new Set(statuses)], everyMinutes: every }, user.id, appId);
        return send(res, 200, { stories: db.listStories(appId, filter), filter });
      }

      return send(res, 404, { error: 'Not found.' });
    } catch (e) {
      if (e instanceof HttpError) return send(res, e.status, { error: e.message });
      if (e instanceof AttachmentError || e instanceof RequestError || e instanceof HuddleError) return send(res, e.status, { error: e.message });
      if (e instanceof OwnershipError) return send(res, 409, { error: e.message });
      if (e instanceof StoryError) return send(res, e.policy ? 422 : 400, { error: e.message, policy: e.policy?.id ?? null });
      if (e instanceof IngestError) return send(res, 400, { error: e.message });
      if (e instanceof GitHubError) return send(res, 502, { error: e.message });
      if (e instanceof DeepSeekError) {
        console.error('[horizon api]', e.message);
        return send(res, e.status === 401 || e.status === 403 ? 502 : e.status, { error: e.userMessage });
      }
      if ((e as Error).name === 'AbortError') return;
      console.error('[horizon api] unexpected:', e);
      return send(res, 500, { error: 'Something went wrong on the server.' });
    }
  };
}
