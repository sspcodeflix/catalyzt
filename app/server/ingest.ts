/**
 * Getting tests and results into Hexa:
 *  - importManual: Octane .xlsx or .csv files of manual tests
 *  - ingestJUnit: JUnit XML from an upload or from a CI webhook
 *  - syncGitHubActions: pulls JUnit artifacts from the PR merge-commit runs of a repo's default branch
 * Each one runs as a recorded agent, so it shows on the Agents page.
 */
import { randomUUID } from 'node:crypto';

import { unzipSync, strFromU8 } from 'fflate';

import type { HorizonDb, RunMeta } from './db';
import { GitHubError, parseRepoRef } from './github';
import { JUnitError, parseJUnit, type JUnitCase } from './junit';
import { parseCsv, parseXlsx, readOctaneRows } from './octane';
import { ciSuite, ciTestId, ciTitle, matchCase, rawName } from './results';

export class IngestError extends Error {}

/** Runs `work` as an agent with steps, recorded like the chat workflow's agents. */
async function asAgent<T>(db: HorizonDb, userId: string, agent: string, task: string, work: (step: (label: string, tool: string) => (status: 'done' | 'failed', detail?: string) => void) => Promise<T>): Promise<T> {
  const wf = randomUUID();
  const id = randomUUID();
  db.startWorkflow({ id: wf, chatId: null, messageId: null, revision: 1, userId });
  db.startAgent({ id, workflowRunId: wf, parentId: null, agent, kind: 'tool_agent', task, model: null });
  const step = (label: string, tool: string) => {
    const sid = randomUUID();
    db.addStep({ id: sid, agentRunId: id, kind: 'tool', tool, label });
    return (status: 'done' | 'failed', detail?: string) => db.finishStep(sid, { status, detail });
  };
  try {
    const r = await work(step);
    db.finishAgent(id, { status: 'done', result: typeof r === 'object' && r && 'summary' in r ? String((r as { summary: unknown }).summary) : 'Done' });
    db.finishWorkflow(wf, 'done', task);
    return r;
  } catch (e) {
    db.finishAgent(id, { status: 'failed', error: (e as Error).message });
    db.finishWorkflow(wf, 'failed', task);
    throw e;
  }
}

/* ---------- Manual tests ---------- */

export async function importManual(db: HorizonDb, file: { filename: string; data: Buffer }, purposeDefault: 'uat' | 'regression' | null, userId: string) {
  const lower = file.filename.toLowerCase();
  const format = lower.endsWith('.xlsx') ? 'xlsx' : lower.endsWith('.csv') ? 'csv' : null;
  if (!format) throw new IngestError('Upload an Octane template as .xlsx or .csv.');
  return asAgent(db, userId, 'Hexa importer', `Import manual tests from ${file.filename}`, async (step) => {
    const read = step(`Reading ${format.toUpperCase()}`, 'octane.read');
    let rows: string[][];
    try {
      rows = format === 'xlsx' ? await parseXlsx(file.data) : parseCsv(file.data.toString('utf8'));
    } catch (e) {
      read('failed', (e as Error).message);
      throw new IngestError(`Could not read the file: ${(e as Error).message}`);
    }
    read('done', `${Math.max(rows.length - 1, 0)} rows`);
    const parse = step('Grouping rows into tests and steps', 'octane.parse');
    const { tests, problems } = readOctaneRows(rows);
    parse('done', `${tests.length} tests, ${tests.reduce((a, t) => a + t.steps.length, 0)} steps`);
    if (tests.length === 0) throw new IngestError(problems[0]?.message ?? 'No tests found in the file.');
    const save = step('Saving to Hexa', 'hexa.upsert_manual');
    const r = db.upsertManualTests(tests, { origin: 'upload', purposeDefault, filename: file.filename, format, problems, userId });
    save('done', `${r.created} new · ${r.updated} updated`);
    return { ...r, tests: tests.length, summary: `${r.created} new, ${r.updated} updated manual tests` };
  });
}

/* ---------- Automated results ---------- */

/** Matches parsed cases to known tests and stores the run. */
function storeRun(db: HorizonDb, meta: RunMeta, cases: JUnitCase[], userId: string) {
  const cands = db.automatedCandidates(meta.repo);
  const results = cases.map((c) => {
    const hit = matchCase(c, cands);
    return {
      testCaseId: hit?.id ?? null,
      create: hit ? undefined : { id: ciTestId(meta.repo, c), title: ciTitle(c), suite: ciSuite(c), codeName: rawName(c.name), path: c.file },
      status: c.status,
      durationMs: c.durationMs,
      message: c.message,
    };
  });
  return db.ingestRun(meta, results, userId);
}

export async function ingestJUnit(db: HorizonDb, files: { filename: string; xml: string }[], meta: RunMeta, userId: string) {
  if (files.length === 0) throw new IngestError('No JUnit XML was sent.');
  return asAgent(db, userId, 'Results collector', `Record test results${meta.repo ? ` for ${meta.repo}` : ''}${meta.prNumber ? ` (PR #${meta.prNumber})` : ''}`, async (step) => {
    const parse = step(`Reading ${files.length} JUnit file${files.length > 1 ? 's' : ''}`, 'junit.parse');
    const cases: JUnitCase[] = [];
    for (const f of files) {
      try {
        cases.push(...parseJUnit(f.xml));
      } catch (e) {
        parse('failed', `${f.filename}: ${(e as Error).message}`);
        throw new IngestError(`${f.filename}: ${(e as Error).message}`);
      }
    }
    parse('done', `${cases.length} results`);
    if (cases.length === 0) throw new IngestError('The JUnit XML has no test cases.');
    const store = step('Matching results to tests and saving', 'hexa.ingest_run');
    const r = storeRun(db, meta, cases, userId);
    store('done', `${r.matched} matched · ${r.created} new tests · ${r.failed} failed`);
    return { ...r, summary: `${r.total} results, ${r.failed} failed` };
  });
}

/* ---------- GitHub Actions ---------- */

interface GhRun {
  id: number;
  name: string;
  html_url: string;
  head_sha: string;
  head_branch: string;
  event: string;
  run_started_at: string;
  conclusion: string | null;
  artifacts_url: string;
}

const JUNIT_ARTIFACT = /junit|test[-_ ]?results?|test[-_ ]?reports?|surefire|failsafe/i;

async function gh<T>(url: string, token: string, accept = 'application/vnd.github+json'): Promise<T> {
  const res = await fetch(url, { headers: { Accept: accept, Authorization: `Bearer ${token}`, 'User-Agent': 'horizon-hexa' }, signal: AbortSignal.timeout(30_000) });
  if (res.status === 401) throw new GitHubError('GITHUB_TOKEN was rejected.');
  if (res.status === 404) throw new GitHubError('Repository not found, or the token cannot read it.');
  if (res.status === 403 || res.status === 429) throw new GitHubError('GitHub rate limit reached, or the token lacks the actions:read permission.');
  if (!res.ok) throw new GitHubError(`GitHub returned ${res.status}.`);
  return (await res.json()) as T;
}

/**
 * Collects results from the PR merge-commit runs on the default branch: push runs whose commit
 * is the merge commit of a merged pull request. Artifacts whose name looks like test results are
 * downloaded and their JUnit XML ingested. Runs already ingested are skipped.
 */
export async function syncGitHubActions(db: HorizonDb, input: string, token: string | undefined, userId: string, limit = 10) {
  if (!token) throw new IngestError('Set GITHUB_TOKEN on the server to read GitHub Actions: GitHub requires a token to download run artifacts, even for public repositories.');
  const ref = parseRepoRef(input);
  if (!ref) throw new IngestError('Enter a GitHub repository as owner/repo or a github.com link.');
  const repo = `${ref.owner}/${ref.repo}`;
  return asAgent(db, userId, 'Results collector', `Collect merge-commit test results from GitHub Actions for ${repo}`, async (step) => {
    const list = step('Listing completed runs on the default branch', 'github.list_runs');
    const meta = await gh<{ default_branch: string }>(`https://api.github.com/repos/${repo}`, token);
    const branch = ref.ref ?? meta.default_branch;
    const { workflow_runs: runs } = await gh<{ workflow_runs: GhRun[] }>(
      `https://api.github.com/repos/${repo}/actions/runs?branch=${encodeURIComponent(branch)}&event=push&status=completed&per_page=${limit}`,
      token,
    );
    list('done', `${runs.length} runs on ${branch}`);

    const out = { checked: runs.length, ingested: 0, already: 0, notMerge: 0, noResults: 0, results: 0, failed: 0 };
    for (const run of runs) {
      if (db.runExists('github_actions', repo, String(run.id))) {
        out.already++;
        continue;
      }
      const s = step(`Run #${run.id} (${run.name})`, 'github.read_run');
      const pulls = await gh<{ number: number; merged_at: string | null; merge_commit_sha: string | null }[]>(`https://api.github.com/repos/${repo}/commits/${run.head_sha}/pulls`, token);
      const pr = pulls.find((p) => p.merged_at && p.merge_commit_sha === run.head_sha);
      if (!pr) {
        out.notMerge++;
        s('done', 'Not a PR merge commit; skipped');
        continue;
      }
      const { artifacts } = await gh<{ artifacts: { name: string; expired: boolean; archive_download_url: string }[] }>(run.artifacts_url, token);
      const files: { filename: string; xml: string }[] = [];
      for (const a of artifacts.filter((x) => !x.expired && JUNIT_ARTIFACT.test(x.name))) {
        const res = await fetch(a.archive_download_url, { headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'horizon-hexa' }, signal: AbortSignal.timeout(60_000) });
        if (!res.ok) continue;
        const zip = unzipSync(new Uint8Array(await res.arrayBuffer()), { filter: (f) => f.name.toLowerCase().endsWith('.xml') && f.originalSize < 20 * 1024 * 1024 });
        for (const [name, bytes] of Object.entries(zip)) files.push({ filename: `${a.name}/${name}`, xml: strFromU8(bytes) });
      }
      const cases: JUnitCase[] = [];
      for (const f of files) {
        try {
          cases.push(...parseJUnit(f.xml));
        } catch (e) {
          if (!(e instanceof JUnitError)) throw e;
        }
      }
      if (cases.length === 0) {
        out.noResults++;
        s('done', `PR #${pr.number}: no JUnit artifact (name it like "test-results" or "junit")`);
        continue;
      }
      const r = storeRun(
        db,
        { source: 'github_actions', repo, workflow: run.name, externalRunId: String(run.id), runUrl: run.html_url, event: run.event, branch: run.head_branch, sha: run.head_sha, prNumber: pr.number, isMerge: true, startedAt: run.run_started_at },
        cases,
        userId,
      );
      out.ingested++;
      out.results += r.total;
      out.failed += r.failed;
      s('done', `PR #${pr.number}: ${r.total} results, ${r.failed} failed`);
    }
    return { ...out, summary: `${out.ingested} merge-commit runs ingested` };
  });
}
