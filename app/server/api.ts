/**
 * Server-side API for the Horizon UI. The DeepSeek key and the database stay here.
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
 *   GET  /api/chats                the user's recent chats in the application
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
 *   POST /api/hexa/manual/from-uat approved UAT cases become manual tests
 *   POST /api/hexa/results/upload  upload JUnit XML results
 *   POST /api/hexa/results         CI pushes JUnit results (Bearer HEXA_INGEST_TOKEN; body names the app)
 *   POST /api/hexa/runs/sync       pull results of PR merge-commit runs from GitHub Actions (needs GITHUB_TOKEN)
 *   POST /api/hexa/scans           scan a public GitHub repo for test cases; runs in the background
 */
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { answerBlocks, applyEvent, finishAnswer, initialAnswer } from '../src/lib/answerReducer';
import { CAPABILITIES } from '../src/lib/intent';
import type { UatArtifact } from '../src/lib/types';
import type { RunRequest, WorkflowEvent } from '../src/lib/workflow';
import { extraRoutes } from './api-context';
import { componentId, STATUSES, type HorizonDb, type Role, type StoredStory } from './db';
import { DeepSeekError, type DeepSeekConfig } from './deepseek';
import { GitHubError } from './github';
import { ScanError, startRepoScan } from './hexa';
import { importManual, IngestError, ingestJUnit, syncGitHubActions } from './ingest';
import { octaneTemplate, toOctaneCsv } from './octane';
import { parseStoryInput, refineStory, StoryError } from './stories';
import type { Workspace } from './workspace';
import { runWorkflow } from './workflow';

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

export interface ApiOptions {
  githubToken?: string;
  ingestToken?: string;
  getWorkspace?: () => Workspace | null;
}

/** The UAT analyst's proposed cases become manual tests in Hexa, linked to the story and its criteria. */
function addUatCases(db: HorizonDb, appId: string, story: StoredStory, artifact: { proposedCases: { id: string; title: string; criterion: string; steps: string[] }[] }, user: { id: string; name: string }) {
  const tests = artifact.proposedCases.slice(0, 50).map((c) => ({
    externalId: c.id,
    name: c.title.slice(0, 300),
    description: `UAT case for ${story.key}${c.criterion ? ` ${c.criterion}` : ''}, proposed by the UAT analyst and approved in Horizon.`,
    testType: 'Acceptance',
    purpose: 'uat' as const,
    phase: 'New',
    owner: user.name,
    designer: 'Horizon UAT analyst',
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

  return async function api(req: IncomingMessage, res: ServerResponse, next: Next) {
    const full = new URL(req.url ?? '/', 'http://x');
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

      // CI pushes results here after a merge (see docs/hexa-github-action.yml). Bearer HEXA_INGEST_TOKEN; the body names the application.
      if (url === '/api/hexa/results' && req.method === 'POST') {
        if (!opts.ingestToken) return send(res, 503, { error: 'Set HEXA_INGEST_TOKEN on the server to accept results from CI.' });
        if (req.headers.authorization !== `Bearer ${opts.ingestToken}`) return send(res, 401, { error: 'Missing or wrong ingest token.' });
        const b = (await readJson(req, MAX_UPLOAD)) as Record<string, unknown>;
        const app = isStr(b.app) ? b.app : null;
        if (!app || !db.getApp(app)) throw new HttpError(400, 'The body must name a known application in "app".');
        const junit = (Array.isArray(b.junit) ? b.junit : [b.junit]).filter(isStr).slice(0, 50);
        const repo = isStr(b.repo) ? b.repo.slice(0, 200) : null;
        const runId = isStr(b.runId) || typeof b.runId === 'number' ? String(b.runId) : null;
        if (runId && db.runExists('webhook', repo, runId)) return send(res, 200, { duplicate: true });
        const pr = Number(b.prNumber);
        // Results pushed by CI are recorded as the application's owner.
        const owner = (db.raw.prepare("SELECT user_id FROM memberships WHERE application_id = ? AND role = 'app_owner' LIMIT 1").get(app) as { user_id: string } | undefined)?.user_id ?? db.defaultUser()?.id;
        if (!owner) throw new HttpError(503, 'No people loaded.');
        return send(
          res,
          200,
          await ingestJUnit(
            db,
            junit.map((xml, i) => ({ filename: `results-${i + 1}.xml`, xml })),
            {
              app,
              source: 'webhook',
              repo,
              workflow: isStr(b.workflow) ? b.workflow.slice(0, 200) : null,
              externalRunId: runId,
              runUrl: isStr(b.runUrl) && /^https:\/\//.test(b.runUrl) ? b.runUrl.slice(0, 500) : null,
              event: isStr(b.event) ? b.event.slice(0, 50) : null,
              branch: isStr(b.branch) ? b.branch.slice(0, 200) : null,
              sha: isStr(b.sha) && /^[0-9a-f]{7,40}$/i.test(b.sha) ? b.sha : null,
              prNumber: Number.isInteger(pr) && pr > 0 ? pr : null,
              isMerge: b.mergeCommit === true || (Number.isInteger(pr) && pr > 0),
              startedAt: isStr(b.startedAt) && !Number.isNaN(Date.parse(b.startedAt)) ? new Date(b.startedAt).toISOString() : null,
            },
            owner,
          ),
        );
      }

      /* ---------- Who, and which application ---------- */
      if (db.isEmpty()) return send(res, 503, { error: 'No workspace is loaded, so Horizon has no people or applications. See SIMULATION_PLAN.md.' });
      const userHeader = req.headers['x-horizon-user'];
      const userId = (isStr(userHeader) ? userHeader : full.searchParams.get('_user')) ?? '';
      const user = (userId && db.getUser(userId)) || db.defaultUser()!;
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
        return send(res, 200, { user, apps, app: app ?? null, people: db.listPeople() });
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
          readJson: (max) => readJson(req, max),
          send: (status, body) => send(res, status, body),
          HttpError,
        })
      )
        return;

      if (url === '/api/chats' && req.method === 'GET') {
        return send(res, 200, { chats: db.listChats(appId, user.id) });
      }

      if (url === '/api/run' && req.method === 'POST') {
        const body = parseRunRequest(await readJson(req));
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
          scope: { appName: member.name, appId, workspace: body.scope.workspace || member.workspaces[0] || '' },
          syncedTickets: db.listStories(appId).map(asTicket),
          knownComponents: member.components.map((c) => c.name),
        };
        let workflowRunId: string | null = null;
        let failure: string | undefined;
        try {
          workflowRunId = (await runWorkflow(run, cfg, emit, abort.signal, { db, userId: user.id, app: appId })).workflowRunId;
        } catch (e) {
          if (!abort.signal.aborted) {
            failure = e instanceof DeepSeekError ? e.userMessage : 'The answer failed. Try again.';
            console.error('[horizon api] workflow failed:', (e as Error).message);
            emit({ type: 'error', message: failure });
          }
        }
        if (body.chatId && body.messageId && body.answerId) {
          const final = failure || abort.signal.aborted ? finishAnswer(answer, abort.signal.aborted, failure) : answer;
          const saved = db.saveAnswer({
            app: appId,
            chatId: body.chatId,
            answerId: body.answerId,
            userMessageId: body.messageId,
            revision: body.revision ?? 1,
            workflowRunId,
            userId: user.id,
            status: final.status,
            intent: final.intent,
            blocks: answerBlocks(final),
            citations: final.citations,
            artifact: final.artifact ?? null,
          });
          if (!abort.signal.aborted) write({ type: 'saved', revisionId: saved.revisionId, approvals: saved.approvals });
        }
        return res.end();
      }

      const chatMatch = /^\/api\/chats\/([A-Za-z0-9_-]{1,64})$/.exec(url);
      if (chatMatch && req.method === 'GET') {
        const chat = db.getChatFull(chatMatch[1], user.id);
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
        return send(res, 200, { ok: true, stars, patterns: stars < 4 ? db.lowRatingPatterns(appId) : [] });
      }

      const approvalMatch = /^\/api\/approvals\/([A-Za-z0-9_-]{1,96})\/decision$/.exec(url);
      if (approvalMatch && req.method === 'POST') {
        const a = db.getApproval(approvalMatch[1]);
        if (!a || a.app !== appId) return send(res, 404, { error: 'This approval does not exist in this application.' });
        const b = (await readJson(req)) as Record<string, unknown>;
        const decision = b.decision === 'approved' || b.decision === 'declined' ? b.decision : null;
        if (!decision) throw new HttpError(400, 'decision must be approved or declined.');
        if (a.status !== 'pending') throw new HttpError(409, `This was already ${a.status}.`);
        if (decision === 'approved') {
          // Server-side rules: the answer is rated first, and only an owner or a component manager approves.
          if (!db.hasRating(a.revisionId, user.id)) throw new HttpError(403, 'Rate the answer before approving.');
          requireRole(['app_owner', 'component_manager'], 'approve a change');
        }
        let outcome: { ok: boolean; text: string } | undefined;
        if (decision === 'approved' && a.action === 'add_uat_cases' && a.target.artifactId) {
          const artifact = db.getArtifact(a.chatId, a.target.artifactId);
          const story = a.target.storyKey ? db.getStory(a.target.storyKey) : undefined;
          if (artifact?.kind === 'uat' && story && story.applicationId === appId) {
            const r = addUatCases(db, appId, story, artifact as UatArtifact, user);
            const n = r.created + r.updated;
            outcome = { ok: true, text: `Added ${n} manual test${n === 1 ? '' : 's'} to Hexa, linked to ${story.key}` };
          } else outcome = { ok: false, text: 'The UAT report this approval refers to is no longer available.' };
        }
        const decided = db.decideApproval(a.id, decision, user.id, outcome);
        if (!decided) throw new HttpError(409, 'This was already decided.');
        return send(res, 200, { approval: { id: a.id, ...decided } });
      }

      if (url === '/api/hexa/tests' && req.method === 'GET') {
        const p = full.searchParams;
        const pick = (k: string, allowed: string[]) => (allowed.includes(p.get(k) ?? '') ? (p.get(k) as string) : undefined);
        return send(res, 200, {
          ...db.listTests(appId, {
            q: (p.get('q') ?? '').slice(0, 100) || undefined,
            kind: pick('kind', ['automated', 'manual', 'proposed']),
            kinds: (p.get('kinds') ?? '').split(',').filter((k) => ['automated', 'manual', 'proposed'].includes(k)),
            purpose: pick('purpose', ['uat', 'regression']),
            result: pick('result', ['passed', 'failed', 'skipped', 'not_run', 'none']),
            origin: pick('origin', ['repo_scan', 'uat_analyst', 'authoring', 'manual', 'upload', 'ci_results']),
            repo: p.get('repo')?.slice(0, 200) || undefined,
            limit: Math.min(Number(p.get('limit')) || 50, 200),
            offset: Math.max(Number(p.get('offset')) || 0, 0),
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

      // UAT cases a person approved on a UAT analysis become manual tests, in Octane shape.
      if (url === '/api/hexa/manual/from-uat' && req.method === 'POST') {
        const b = (await readJson(req)) as { storyKey?: unknown; cases?: unknown };
        const story = isStr(b.storyKey) ? db.getStory(b.storyKey) : undefined;
        if (!story || story.applicationId !== appId) throw new HttpError(400, 'Unknown story.');
        const cases = (Array.isArray(b.cases) ? b.cases : []).slice(0, 50).filter((c): c is { id: string; title: string; criterion: string; steps: string[] } => isStr(c?.id) && isStr(c?.title));
        if (cases.length === 0) throw new HttpError(400, 'No cases to add.');
        return send(res, 200, addUatCases(db, appId, story, { proposedCases: cases.map((c) => ({ ...c, criterion: String(c.criterion ?? ''), steps: strArr(c.steps) })) }, user));
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
          return send(res, 202, startRepoScan(db, appId, String(b.repo ?? ''), user.id, githubToken));
        } catch (e) {
          if (e instanceof ScanError) throw new HttpError(400, e.message);
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
        return send(res, 200, { stories: db.listStories(appId, filter), filter });
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
        const filter = db.markSynced(appId);
        return send(res, 200, { stories: db.listStories(appId, filter), filter });
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
