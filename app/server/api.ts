/**
 * Server-side API for the Horizon UI. The DeepSeek key and the database stay here.
 * Mounted as connect middleware by the Vite plugin in vite.config.ts (dev and preview); the same
 * handler can be mounted in Express or any Node server for production.
 *
 *   GET  /api/health               model configuration (never the key)
 *   POST /api/run                  SSE stream of WorkflowEvent: the request goes through the agent
 *                                  workflow (server/workflow.ts), recorded in the database
 *   GET  /api/agents               agent activity: running now, plus recent runs
 *   GET  /api/usage                token totals: all time, today, by agent, model, user and day
 *   GET  /api/hexa/tests           Hexa test case inventory (filters: q, kind, origin, repo), stats and recent scans
 *   POST /api/hexa/scans           scan a public GitHub repo for test cases; runs in the background
 *   GET  /api/hexa/tests/:id       one test: steps, links and result history
 *   GET  /api/hexa/runs            recent test runs (CI and uploads)
 *   GET  /api/hexa/manual/template Octane import template (.xlsx)
 *   GET  /api/hexa/manual/export   manual tests as an Octane import CSV
 *   POST /api/hexa/manual/import   upload manual tests (Octane .xlsx or .csv)
 *   POST /api/hexa/manual/from-uat approved UAT cases become manual tests
 *   POST /api/hexa/results/upload  upload JUnit XML results
 *   POST /api/hexa/results         CI pushes JUnit results (Bearer HEXA_INGEST_TOKEN)
 *   POST /api/hexa/runs/sync       pull results of PR merge-commit runs from GitHub Actions (needs GITHUB_TOKEN)
 *   GET  /api/stories              stories matching the Jira filter, and the filter
 *   GET  /api/stories/:key         one story, even if the filter hides it
 *   POST /api/stories              create a story in the dummy Jira
 *   POST /api/stories/refine       the Story refiner agent; the refinement is stored
 *   POST /api/jira/sync            sync now
 *   PUT  /api/jira/filter          change the statuses and sync interval
 *
 * There is no sign-in in this preview: requests act as the user in the `x-horizon-user` header,
 * or the default seeded user. Production takes the user from SSO.
 */
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { CAPABILITIES } from '../src/lib/intent';
import type { RunRequest, WorkflowEvent } from '../src/lib/workflow';
import { DEFAULT_USER, STATUSES, type HorizonDb, type StoredStory } from './db';
import { DeepSeekError, type DeepSeekConfig } from './deepseek';
import { GitHubError } from './github';
import { ScanError, startRepoScan } from './hexa';
import { importManual, IngestError, ingestJUnit, syncGitHubActions } from './ingest';
import { octaneTemplate, toOctaneCsv } from './octane';
import { parseStoryInput, refineStory, StoryError } from './stories';
import { runWorkflow } from './workflow';

const MAX_BODY = 64 * 1024;

type Next = (err?: unknown) => void;

function send(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

/** Uploads (base64 files, CI results) may be larger than ordinary requests. */
const MAX_UPLOAD = 12 * 1024 * 1024;

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

class HttpError extends Error {
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

/** Creates the /api middleware. */
export function createApi(getConfig: () => DeepSeekConfig | null, getDb: () => HorizonDb, opts: { githubToken?: string; ingestToken?: string } = {}) {
  const githubToken = opts.githubToken;
  return async function api(req: IncomingMessage, res: ServerResponse, next: Next) {
    const url = req.url?.split('?')[0] ?? '';
    if (!url.startsWith('/api/')) return next();
    const cfg = getConfig();
    const db = getDb();
    const header = req.headers['x-horizon-user'];
    const userId = isStr(header) && db.getUser(header) ? header : DEFAULT_USER;

    try {
      if (url === '/api/health' && req.method === 'GET') {
        return send(res, 200, {
          model: cfg
            ? { configured: true, intentModel: cfg.intentModel, chatModel: cfg.chatModel, thinking: cfg.thinking, host: new URL(cfg.baseUrl).host }
            : { configured: false },
        });
      }

      if (url === '/api/run' && req.method === 'POST') {
        const body = parseRunRequest(await readJson(req));
        const abort = new AbortController();
        res.on('close', () => abort.abort());
        const emit = sse(res);
        // Stories come from the database, never from the browser.
        const run: RunRequest = { ...body, syncedTickets: db.listStories().map(asTicket) };
        try {
          await runWorkflow(run, cfg, emit, abort.signal, { db, userId });
        } catch (e) {
          if (!abort.signal.aborted) {
            console.error('[horizon api] workflow failed:', (e as Error).message);
            emit({ type: 'error', message: e instanceof DeepSeekError ? e.userMessage : 'The answer failed. Try again.' });
          }
        }
        return res.end();
      }

      if (url === '/api/hexa/tests' && req.method === 'GET') {
        const p = new URL(req.url ?? '', 'http://x').searchParams;
        const pick = (k: string, allowed: string[]) => (allowed.includes(p.get(k) ?? '') ? (p.get(k) as string) : undefined);
        return send(res, 200, {
          ...db.listTests({
            q: (p.get('q') ?? '').slice(0, 100) || undefined,
            kind: pick('kind', ['automated', 'manual', 'proposed']),
            kinds: (p.get('kinds') ?? '').split(',').filter((k) => ['automated', 'manual', 'proposed'].includes(k)),
            purpose: pick('purpose', ['uat', 'regression']),
            result: pick('result', ['passed', 'failed', 'skipped', 'not_run', 'none']),
            origin: pick('origin', ['repo_scan', 'uat_analyst', 'authoring', 'manual']),
            repo: p.get('repo')?.slice(0, 200) || undefined,
            limit: Math.min(Number(p.get('limit')) || 50, 200),
            offset: Math.max(Number(p.get('offset')) || 0, 0),
          }),
          stats: db.testStats(),
          scans: db.listScans(8),
          uploads: db.listUploads(6),
        });
      }

      const testId = /^\/api\/hexa\/tests\/([A-Za-z0-9_-]{1,64})$/.exec(url)?.[1];
      if (testId && req.method === 'GET') {
        const t = db.getTest(testId);
        return t ? send(res, 200, { test: t }) : send(res, 404, { error: `${testId} does not exist.` });
      }

      if (url === '/api/hexa/runs' && req.method === 'GET') {
        return send(res, 200, { runs: db.listRuns(30) });
      }

      if (url === '/api/hexa/manual/template' && req.method === 'GET') {
        const buf = await octaneTemplate();
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', 'attachment; filename="hexa-octane-manual-tests-template.xlsx"');
        return res.end(buf);
      }

      if (url === '/api/hexa/manual/export' && req.method === 'GET') {
        const ids = (new URL(req.url ?? '', 'http://x').searchParams.get('ids') ?? '').split(',').filter((x) => /^[A-Za-z0-9_-]{1,64}$/.test(x));
        res.statusCode = 200;
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="hexa-manual-tests-octane-${new Date().toISOString().slice(0, 10)}.csv"`);
        return res.end(`\uFEFF${toOctaneCsv(db.manualForExport(ids))}`);
      }

      if (url === '/api/hexa/manual/import' && req.method === 'POST') {
        const b = (await readJson(req, MAX_UPLOAD)) as Record<string, unknown>;
        const data = Buffer.from(String(b.contentBase64 ?? ''), 'base64');
        if (!data.length) throw new HttpError(400, 'Choose a file to upload.');
        const purpose = b.purpose === 'uat' || b.purpose === 'regression' ? b.purpose : null;
        return send(res, 200, await importManual(db, { filename: String(b.filename ?? 'upload'), data }, purpose, userId));
      }

      // UAT cases a person approved on a UAT analysis become manual tests, in Octane shape.
      if (url === '/api/hexa/manual/from-uat' && req.method === 'POST') {
        const b = (await readJson(req)) as { storyKey?: unknown; cases?: unknown };
        const story = isStr(b.storyKey) ? db.getStory(b.storyKey) : undefined;
        if (!story) throw new HttpError(400, 'Unknown story.');
        const cases = (Array.isArray(b.cases) ? b.cases : []).slice(0, 50) as { id?: unknown; title?: unknown; criterion?: unknown; steps?: unknown }[];
        const tests = cases
          .filter((c) => isStr(c.id) && isStr(c.title))
          .map((c) => {
            const steps = strArr(c.steps);
            return {
              externalId: String(c.id),
              name: String(c.title).slice(0, 300),
              description: `UAT case for ${story.key}${isStr(c.criterion) ? ` ${c.criterion}` : ''}, proposed by the UAT analyst and approved in Horizon.`,
              testType: 'Acceptance',
              purpose: 'uat' as const,
              phase: 'New',
              owner: db.getUser(userId)?.name ?? '',
              designer: 'Horizon UAT analyst',
              productAreas: '',
              applicationModules: story.components.join(', '),
              userTags: 'uat, horizon',
              estimatedMinutes: null,
              covers: [isStr(c.criterion) ? `${story.key}#${c.criterion}` : story.key],
              steps: steps.map((s, i) => ({ type: (i === steps.length - 1 || /^check\b/i.test(s) ? 'validation' : 'simple') as 'simple' | 'validation', description: s })),
            };
          });
        if (tests.length === 0) throw new HttpError(400, 'No cases to add.');
        return send(res, 200, db.upsertManualTests(tests, { origin: 'uat_analyst', purposeDefault: 'uat', filename: `UAT analysis of ${story.key}`, format: 'horizon', problems: [], userId }));
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
            userId,
          ),
        );
      }

      // CI pushes results here after a merge (see docs/hexa-github-action.yml). Bearer HEXA_INGEST_TOKEN.
      if (url === '/api/hexa/results' && req.method === 'POST') {
        if (!opts.ingestToken) return send(res, 503, { error: 'Set HEXA_INGEST_TOKEN on the server to accept results from CI.' });
        if (req.headers.authorization !== `Bearer ${opts.ingestToken}`) return send(res, 401, { error: 'Missing or wrong ingest token.' });
        const b = (await readJson(req, MAX_UPLOAD)) as Record<string, unknown>;
        const junit = (Array.isArray(b.junit) ? b.junit : [b.junit]).filter(isStr).slice(0, 50);
        const repo = isStr(b.repo) ? b.repo.slice(0, 200) : null;
        const runId = isStr(b.runId) || typeof b.runId === 'number' ? String(b.runId) : null;
        if (runId && db.runExists('webhook', repo, runId)) return send(res, 200, { duplicate: true });
        const pr = Number(b.prNumber);
        return send(
          res,
          200,
          await ingestJUnit(
            db,
            junit.map((xml, i) => ({ filename: `results-${i + 1}.xml`, xml })),
            {
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
            userId,
          ),
        );
      }

      if (url === '/api/hexa/runs/sync' && req.method === 'POST') {
        const b = (await readJson(req)) as Record<string, unknown>;
        return send(res, 200, await syncGitHubActions(db, String(b.repo ?? ''), githubToken, userId));
      }

      if (url === '/api/hexa/scans' && req.method === 'POST') {
        const b = (await readJson(req)) as Record<string, unknown>;
        try {
          return send(res, 202, startRepoScan(db, String(b.repo ?? ''), userId, githubToken));
        } catch (e) {
          if (e instanceof ScanError) throw new HttpError(400, e.message);
          throw e;
        }
      }

      if (url === '/api/usage' && req.method === 'GET') {
        return send(res, 200, db.usage());
      }

      if (url === '/api/agents' && req.method === 'GET') {
        return send(res, 200, { agents: db.listAgentActivity({ recent: 60 }), at: new Date().toISOString() });
      }

      if (url === '/api/stories' && req.method === 'GET') {
        const filter = db.getFilter();
        return send(res, 200, { stories: db.listStories(filter), filter });
      }

      if (url === '/api/stories' && req.method === 'POST') {
        const story = db.createStory(parseStoryInput(await readJson(req), userId));
        return send(res, 201, { story, visible: db.getFilter().statuses.includes(story.status as never) });
      }

      if (url === '/api/stories/refine' && req.method === 'POST') {
        const abort = new AbortController();
        res.on('close', () => abort.abort());
        const body = await readJson(req);
        // The refiner is an agent like any other: it gets a workflow run, so it shows on the Agents page.
        const wf = randomUUID();
        const agentId = randomUUID();
        db.startWorkflow({ id: wf, chatId: null, messageId: null, revision: 1, userId });
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
              userId,
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
          const refinementId = db.saveRefinement({ input: r.input, output: r.output, source: r.source, model: r.model, agentRunId: agentId, createdBy: userId });
          return send(res, 200, { refinementId, refined: r.output, source: r.source, model: r.model, note: r.note ?? null });
        } catch (e) {
          const rejected = e instanceof StoryError && e.policy;
          db.finishStep(stepId, { status: 'failed', detail: (e as Error).message });
          db.finishAgent(agentId, { status: rejected ? 'rejected' : 'failed', error: (e as Error).message });
          db.finishWorkflow(wf, rejected ? 'rejected' : 'failed', rejected ? 'Rejected by the story guard' : 'Failed');
          if (e instanceof StoryError && e.policy) db.guardEvent({ workflowRunId: wf, agentRunId: agentId, layer: 'story', policy: e.policy.id, userId });
          throw e;
        }
      }

      const storyKey = /^\/api\/stories\/([A-Z][A-Z0-9]+-\d+)$/.exec(url)?.[1];
      if (storyKey && req.method === 'GET') {
        const story = db.getStory(storyKey);
        return story ? send(res, 200, { story }) : send(res, 404, { error: `${storyKey} does not exist.` });
      }

      if (url === '/api/jira/sync' && req.method === 'POST') {
        const filter = db.markSynced();
        return send(res, 200, { stories: db.listStories(filter), filter });
      }

      if (url === '/api/jira/filter' && req.method === 'PUT') {
        const b = (await readJson(req)) as Record<string, unknown>;
        const statuses = strArr(b.statuses).filter((s): s is (typeof STATUSES)[number] => STATUSES.includes(s as never));
        const every = Number(b.everyMinutes);
        if (statuses.length === 0) throw new HttpError(400, 'Choose at least one status.');
        if (![5, 15, 30, 60].includes(every)) throw new HttpError(400, 'Sync interval must be 5, 15, 30 or 60 minutes.');
        const filter = db.setFilter({ statuses: [...new Set(statuses)], everyMinutes: every }, userId);
        return send(res, 200, { stories: db.listStories(filter), filter });
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
