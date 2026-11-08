/**
 * A repeatable, disposable load profile (the scalability review's acceptance criteria 3 and 4): a
 * fresh database in a temporary directory is filled with synthetic data, then the hot operations
 * are timed. Numbers are observations on this machine, not capacity claims.
 *
 *   cd app && ./node_modules/.bin/vite-node scripts/load-profile.ts [--json] [sizes]
 *
 * Sizes (defaults in brackets): --passages [50000] --tests [25000] --calls [100000] for ABCD, the
 * review's regression case; --extra-apps [3] more applications with --app-passages [10000] and
 * --app-tests [5000] each; --chat-turns [2000] questions in one long chat (every fourth answer gets
 * two more revisions); --attachments [100] uploaded files of 256 KB; --results [1000] JUnit results
 * per import and --imports [20] imports during the concurrent phase; --rounds [20] timed repetitions.
 *
 * Measured:
 *   - retrieveContext (keyword only, and hybrid with synthetic unit vectors), per application with
 *     several applications loaded, listTests with a search, usage(), coverageFor, uatStates
 *   - the long chat: addUserMessage and saveAnswer per call (saveAnswer is one transaction), the chat
 *     read path (getChatFull) and listChats
 *   - concurrent ingestion and retrieval: a second process (its own connection, as a second server
 *     worker or the CI webhook would have) runs JUnit imports through ingestJUnit while this process
 *     keeps retrieving and saving answers; SQLITE_BUSY errors, writes that waited for the lock, and
 *     the share of the phase the second process held the write lock
 *   - event-loop delay, peak memory (RSS and heap) of both processes, the duration of every write
 *     transaction by operation, DB, WAL and blob growth across the run, the WAL checkpoint, the
 *     online backup (db.raw.backup) and the restore check (in process, and the real script)
 *
 * Nothing touches the real database, the workspace or a model; the temporary directory is removed.
 */
import type Database from 'better-sqlite3';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

import { retrieveContext } from '../server/context';
import { openDb, seedWorkspace, type HorizonDb, type RunMeta } from '../server/db';
import { FIXTURE } from '../server/fixture';
import { ingestJUnit } from '../server/ingest';
import { toBlob, type RetrievalModels } from '../server/retrieval';
import { LocalBlobStore } from '../server/storage';
import type { Workspace } from '../server/workspace';

const argv = process.argv.slice(2);
const arg = (name: string, def: number) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? Number(argv[i + 1]) : def;
};
const PASSAGES = arg('passages', 50_000);
const TESTS = arg('tests', 25_000);
const CALLS = arg('calls', 100_000);
const ROUNDS = arg('rounds', 20);
const EXTRA_APPS = arg('extra-apps', 3);
const APP_PASSAGES = arg('app-passages', 10_000);
const APP_TESTS = arg('app-tests', 5_000);
const CHAT_TURNS = arg('chat-turns', 2_000);
const ATTACHMENTS = arg('attachments', 100);
const RESULTS = arg('results', 1_000);
const IMPORTS = arg('imports', 20);
const JSON_OUT = argv.includes('--json');
const DIMS = 384;
const SCRIPT = fileURLToPath(import.meta.url);
const APP_DIR = resolve(dirname(SCRIPT), '..');

const WORDS = 'refund settlement merchant account statistics currency checkout cart payment shipping notification gateway config token kubernetes ingress certificate pod restart rollout batch file validation ascending number addenda return reversal balance deposit export import schedule retry webhook queue latency cache session'.split(' ');
const pick = (seed: number) => WORDS[seed % WORDS.length];
const sentence = (i: number, n = 120) => Array.from({ length: n }, (_, k) => pick(i * 7 + k * 13 + ((i * k) % 5))).join(' ');

function unit(seed: number): Float32Array {
  const v = new Float32Array(DIMS);
  let x = seed + 1;
  let n = 0;
  for (let d = 0; d < DIMS; d++) {
    x = (x * 1103515245 + 12345) % 2147483648;
    v[d] = x / 2147483648 - 0.5;
    n += v[d] * v[d];
  }
  n = Math.sqrt(n) || 1;
  for (let d = 0; d < DIMS; d++) v[d] /= n;
  return v;
}

const pct = (xs: number[], p: number) => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
interface Stat {
  n: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
}
const fmt = (xs: number[]): Stat => ({ n: xs.length, p50: +pct(xs, 50).toFixed(1), p95: +pct(xs, 95).toFixed(1), p99: +pct(xs, 99).toFixed(1), max: +(xs.length ? Math.max(...xs) : 0).toFixed(1) });
const mb = (bytes: number) => +(bytes / 1_048_576).toFixed(1);

async function timed<T>(fn: () => Promise<T> | T, rounds = ROUNDS): Promise<number[]> {
  const out: number[] = [];
  for (let i = 0; i < rounds; i++) {
    const t0 = performance.now();
    await fn();
    out.push(performance.now() - t0);
  }
  return out;
}

/**
 * Times every outermost write transaction on a connection, under the label of the operation running
 * at the time. better-sqlite3 transactions begin deferred, so the time includes any wait for the
 * write lock (the busy timeout) as well as the work.
 */
function instrumentTransactions(raw: Database.Database, label: () => string, sink: Map<string, number[]>) {
  const orig = raw.transaction.bind(raw);
  let depth = 0;
  (raw as unknown as { transaction: unknown }).transaction = (fn: (...a: unknown[]) => unknown) => {
    const tx = orig(fn);
    const wrapped = (...a: unknown[]) => {
      const outer = depth === 0;
      depth++;
      const t0 = performance.now();
      try {
        return tx(...a);
      } finally {
        depth--;
        if (outer) {
          const k = label();
          const xs = sink.get(k) ?? [];
          xs.push(performance.now() - t0);
          sink.set(k, xs);
        }
      }
    };
    return Object.assign(wrapped, { deferred: tx.deferred, immediate: tx.immediate, exclusive: tx.exclusive, default: tx.default });
  };
}

const isBusy = (e: unknown) => {
  const code = (e as { code?: string }).code ?? '';
  return code.startsWith('SQLITE_BUSY') || code.startsWith('SQLITE_LOCKED');
};

function junitXml(n: number, seed: number) {
  const cases: string[] = [];
  for (let i = 0; i < n; i++) {
    const k = (seed * 7919 + i) % TESTS;
    const cls = `com.acme.${pick(k)}.${pick(k + 1)}Test`;
    const fail = i % 100 === seed % 100;
    cases.push(`<testcase classname="${cls}" name="test${k}" time="0.0${i % 10}">${fail ? `<failure message="expected 200 but was 500">stack ${i}</failure>` : ''}</testcase>`);
  }
  return `<?xml version="1.0"?><testsuites><testsuite name="load-${seed}" tests="${n}">${cases.join('')}</testsuite></testsuites>`;
}

/* ---------- The second process: JUnit ingestion on its own connection ---------- */

async function ingestWorker(path: string) {
  const db = openDb(path);
  const tx = new Map<string, number[]>();
  instrumentTransactions(db.raw, () => 'ingestJUnit (worker)', tx);
  const say = (o: object) => process.stdout.write(`${JSON.stringify(o)}\n`);
  say({ type: 'ready' });
  await new Promise((r) => setTimeout(r, 300));
  for (let i = 0; i < IMPORTS; i++) {
    const meta: RunMeta = { app: 'ABCD', source: 'webhook', repo: 'acme/shop', workflow: 'ci', externalRunId: `load-${i}`, attempt: 1, runUrl: null, event: 'push', branch: 'main', sha: `sha${i}`, prNumber: null, isMerge: true, startedAt: new Date().toISOString(), framework: 'JUnit' };
    const t0 = performance.now();
    try {
      const r = await ingestJUnit(db, [{ filename: `shop/target/surefire-reports/TEST-load-${i}.xml`, xml: junitXml(RESULTS, i) }], meta, 'u-ram');
      say({ type: 'import', ms: performance.now() - t0, matched: r.matched, created: r.created, total: r.total });
    } catch (e) {
      say({ type: 'import', ms: performance.now() - t0, error: (e as Error).message, busy: isBusy(e) });
    }
  }
  db.raw.close();
  say({ type: 'done', tx: Object.fromEntries(tx), maxRssMb: +(process.resourceUsage().maxRSS / 1024).toFixed(1), heapUsedMb: mb(process.memoryUsage().heapUsed) });
}

/* ---------- The profile ---------- */

async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'catalyzt-load-'));
  const path = join(dir, 'load.db');
  const filesDir = join(dir, 'files');
  const sizes: { at: string; dbMb: number; walMb: number; blobsMb: number; rssMb: number; heapMb: number }[] = [];
  const dirSize = (d: string): number => (existsSync(d) ? readdirSync(d, { withFileTypes: true }).reduce((s, e) => s + (e.isDirectory() ? dirSize(join(d, e.name)) : statSync(join(d, e.name)).size), 0) : 0);
  const fileSize = (p: string) => (existsSync(p) ? statSync(p).size : 0);
  const snap = (at: string) => {
    const m = process.memoryUsage();
    sizes.push({ at, dbMb: mb(fileSize(path)), walMb: mb(fileSize(`${path}-wal`)), blobsMb: mb(dirSize(filesDir)), rssMb: mb(m.rss), heapMb: mb(m.heapUsed) });
  };
  let heapPeak = 0;
  let rssPeak = 0;
  const sampler = setInterval(() => {
    const m = process.memoryUsage();
    heapPeak = Math.max(heapPeak, m.heapUsed);
    rssPeak = Math.max(rssPeak, m.rss);
  }, 50);

  let op = 'fill';
  const tx = new Map<string, number[]>();
  const db = openDb(path);
  instrumentTransactions(db.raw, () => op, tx);
  const extraApps = Array.from({ length: EXTRA_APPS }, (_, k) => `APP${k + 3}`);
  const ws: Workspace = {
    ...FIXTURE,
    teams: [
      ...FIXTURE.teams,
      ...extraApps.map((id) => ({ ...FIXTURE.teams[1], id, name: `Load app ${id}`, jiraProject: id, workspaces: ['main'], stories: [{ key: `${id}-1001`, summary: 'Synthetic story', status: 'Ready for UAT' as const, acceptanceCriteria: ['Synthetic criterion'] }] })),
    ],
  };
  seedWorkspace(db, ws);
  snap('schema and seed');
  const t0 = performance.now();

  // Passages with a synthetic unit vector each (a fake model), for ABCD and every extra application.
  const insSrc = db.raw.prepare("INSERT OR IGNORE INTO context_sources (id, application_id, scope_type, type, title, trust, status, created_at, updated_at) VALUES (?, ?, 'app', 'Repository', ?, 'Code', 'indexed', 't', 't')");
  const insChunk = db.raw.prepare('INSERT INTO source_chunks (id, source_id, locator, text, seq, source_version, chars, text_sha) VALUES (?, ?, ?, ?, ?, 1, ?, ?)');
  const insVec = db.raw.prepare("INSERT INTO chunk_embeddings (chunk_id, model, dims, vector, text_sha, created_at) VALUES (?, 'synthetic', ?, ?, ?, 't')");
  const fillPassages = (app: string, n: number, offset: number) =>
    db.raw.transaction(() => {
      const sid = app === 'ABCD' ? 'ABCD-repo-shop' : `${app}-repo-load`;
      insSrc.run(sid, app, app === 'ABCD' ? 'shop' : 'load');
      for (let i = 0; i < n; i++) {
        const text = sentence(offset + i);
        insChunk.run(`${sid}@load#${i}`, sid, `docs/load-${i % 500}.md ¶${i}`, text, 100 + i, text.length, `sha${offset + i}`);
        insVec.run(`${sid}@load#${i}`, DIMS, toBlob(unit(offset + i)), `sha${offset + i}`);
      }
    })();
  fillPassages('ABCD', PASSAGES, 0);
  extraApps.forEach((a, k) => fillPassages(a, APP_PASSAGES, 1_000_000 * (k + 1)));
  const tPassages = performance.now() - t0;

  // Automated tests with results in one run, and model calls.
  const t1 = performance.now();
  const insTest = db.raw.prepare("INSERT INTO test_cases (id, application_id, title, suite, code_name, kind, framework, origin, repo, path, status, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'automated', 'JUnit', 'ci_results', ?, ?, 'active', 'u-ram', 't', 't')");
  const insRun = db.raw.prepare("INSERT INTO test_runs (id, application_id, source, repo, attempt, status, total, passed, failed, skipped, sha, is_merge, started_at, ingested_at) VALUES (?, ?, 'webhook', ?, 1, 'failed', ?, ?, ?, 0, 'loadsha', 1, 't', 't')");
  const insRes = db.raw.prepare('INSERT INTO test_results (run_id, test_case_id, status) VALUES (?, ?, ?)');
  const fillTests = (app: string, n: number) =>
    db.raw.transaction(() => {
      const repo = app === 'ABCD' ? 'acme/shop' : `acme/${app.toLowerCase()}`;
      const p = app === 'ABCD' ? 'TC-LOAD' : `TC-${app}-`;
      for (let i = 0; i < n; i++) insTest.run(`${p}${i}`, app, `${pick(i)} ${pick(i + 3)} test ${i}`, `com.acme.${pick(i)}.${pick(i + 1)}Test`, `test${i}`, repo, `src/${pick(i)}/x${i % 300}.java`);
      insRun.run(`run-load-${app}`, app, repo, n, n - 10, 10);
      for (let i = 0; i < n; i++) insRes.run(`run-load-${app}`, `${p}${i}`, i < 10 ? 'failed' : 'passed');
    })();
  fillTests('ABCD', TESTS);
  for (const a of extraApps) fillTests(a, APP_TESTS);
  db.raw.prepare("INSERT INTO workflow_runs (id, application_id, requested_by, status, started_at) VALUES ('wf-load', 'ABCD', 'u-ram', 'done', 't')").run();
  const insCall = db.raw.prepare("INSERT INTO model_calls (workflow_run_id, agent, user_id, model, purpose, status, prompt_tokens, completion_tokens, latency_ms, created_at) VALUES ('wf-load', ?, 'u-ram', 'deepseek-flash', 'answer', 'ok', 900, 300, 1200, ?)");
  db.raw.transaction(() => {
    for (let i = 0; i < CALLS; i++) insCall.run(i % 2 ? 'Analysis agent' : 'Router', new Date(Date.now() - (i % 30) * 86_400_000).toISOString());
  })();
  const tRest = performance.now() - t1;
  snap('after fill');

  const fake: RetrievalModels = { embedder: { id: 'synthetic', dims: DIMS, embed: async (texts) => texts.map((_, i) => unit(99_991 + i)) }, reranker: null };
  const q = 'refund settlement window for the merchant account';

  op = 'reads';
  const keyword = await timed(() => retrieveContext(db, 'ABCD', q));
  const hybridCold = await timed(() => retrieveContext(db, 'ABCD', q, { models: fake }), 1);
  const hybrid = await timed(() => retrieveContext(db, 'ABCD', q, { models: fake }));
  const sample = await retrieveContext(db, 'ABCD', q, { models: fake });
  const search = await timed(() => db.listTests('ABCD', { q: 'refund', limit: 50 }));
  const usageCold = await timed(() => db.usage('ABCD'), 1);
  const usage = await timed(() => db.usage('ABCD'));
  const coverage = await timed(() => db.coverageFor('ABCD-1001'));
  const states = await timed(() => db.uatStates('ABCD'));

  // Several applications at once: retrievals interleaved across every loaded application (the first
  // call per application builds its vector matrix and is reported apart).
  const apps = ['ABCD', ...extraApps];
  const perAppFirst: Record<string, number> = {};
  for (const a of extraApps) perAppFirst[a] = (await timed(() => retrieveContext(db, a, q, { models: fake }), 1))[0];
  const perApp = new Map<string, number[]>(apps.map((a) => [a, []]));
  for (let r = 0; r < ROUNDS; r++) {
    for (const a of apps) {
      const s = performance.now();
      await retrieveContext(db, a, q, { models: fake });
      perApp.get(a)!.push(performance.now() - s);
    }
  }
  const multiAppAll = [...perApp.values()].flat();
  const searchOther = extraApps.length ? await timed(() => db.listTests(extraApps[0], { q: 'refund', limit: 50 })) : [];

  // How long a retrieval blocks the event loop for everyone else: a 1 ms ticker runs beside ten
  // retrievals (each separated by a real turn of the loop); the longest gap between ticks is the
  // longest stretch nothing else could run.
  const gaps: number[] = [];
  let last = performance.now();
  let ticking = true;
  const tick = () => {
    const now = performance.now();
    gaps.push(now - last);
    last = now;
    if (ticking) setTimeout(tick, 1);
  };
  setTimeout(tick, 1);
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setImmediate(r));
    await retrieveContext(db, 'ABCD', q, { models: fake });
  }
  ticking = false;
  await new Promise((r) => setTimeout(r, 5));

  snap('after retrieval in every application');

  // A long chat: thousands of messages and revisions, then its read path.
  db.upsertChat({ id: 'chat-long', title: 'Long chat', agent: 'Analysis agent', workspace: 'payments', userId: 'u-ram' }, 'ABCD');
  db.upsertChat({ id: 'chat-contend', title: 'Chat during ingestion', agent: 'Analysis agent', workspace: 'payments', userId: 'u-ram' }, 'ABCD');
  const prose = sentence(7, 180);
  const answer = (chatId: string, answerId: string, userMessageId: string) => ({
    app: 'ABCD',
    chatId,
    answerId,
    userMessageId,
    workflowRunId: null,
    userId: 'u-ram',
    status: 'done',
    intent: undefined,
    blocks: [{ kind: 'prose' as const, text: prose }, { kind: 'followups' as const, items: ['What changed?', 'Which tests cover it?'] }],
    citations: [1, 2, 3].map((n) => ({ n, title: `docs/load-${n}.md`, detail: `App Context · docs/load-${n}.md ¶${n} · v1`, href: `/context/source/ABCD-repo-shop?v=1#chunk-${100 + n}` })),
    artifact: null,
  });
  op = 'saveAnswer';
  const addMsg: number[] = [];
  const save: number[] = [];
  for (let i = 0; i < CHAT_TURNS; i++) {
    const s = performance.now();
    db.addUserMessage({ id: `m-${i}`, chatId: 'chat-long', text: `Question ${i}: ${sentence(i, 20)}`, testType: null, testTypeSource: null, userId: 'u-ram', items: [{ type: 'story', ref: 'ABCD-1001' }] });
    addMsg.push(performance.now() - s);
    const revisions = i % 4 === 0 ? 3 : 1;
    for (let r = 0; r < revisions; r++) {
      const s2 = performance.now();
      db.saveAnswer(answer('chat-long', `a-${i}`, `m-${i}`));
      save.push(performance.now() - s2);
    }
  }
  op = 'reads';
  const chatCounts = db.raw.prepare("SELECT (SELECT COUNT(*) FROM messages WHERE chat_id = 'chat-long') AS messages, (SELECT COUNT(*) FROM answer_revisions ar JOIN messages m ON m.id = ar.message_id WHERE m.chat_id = 'chat-long') AS revisions").get() as { messages: number; revisions: number };
  const chatRead = await timed(() => db.getChatFull('chat-long', 'u-ram'), Math.min(ROUNDS, 5));
  const chatList = await timed(() => db.listChats('ABCD', 'u-ram'));
  snap('after long chat');

  // Uploaded files: bytes in the blob store, metadata in SQLite.
  const blobs = new LocalBlobStore(filesDir);
  op = 'addAttachment';
  const attachMs: number[] = [];
  for (let i = 0; i < ATTACHMENTS; i++) {
    const data = Buffer.alloc(256 * 1024, i % 251);
    data.write(`attachment ${i}`);
    const key = `ABCD/att-${i}`;
    const s = performance.now();
    await blobs.put(key, data);
    db.addAttachment({ id: `att-${i}`, app: 'ABCD', chatId: 'chat-long', filename: `evidence-${i}.png`, mime: 'image/png', size: data.length, sha256: createHash('sha256').update(data).digest('hex'), storageKey: key, status: 'stored', note: null, text: null, userId: 'u-ram' });
    attachMs.push(performance.now() - s);
  }
  op = 'reads';
  snap('after attachments');

  // The same mix of work alone, then while a second process ingests JUnit results.
  let turn = 0;
  const mix = async (out: { retrieve: number[]; save: number[]; busy: number; waited: number }) => {
    const s = performance.now();
    await retrieveContext(db, 'ABCD', q, { models: fake });
    out.retrieve.push(performance.now() - s);
    const s2 = performance.now();
    op = 'saveAnswer (during ingestion)';
    try {
      db.addUserMessage({ id: `c-${turn}`, chatId: 'chat-contend', text: `Question ${turn}`, testType: null, testTypeSource: null, userId: 'u-ram', items: [] });
      db.saveAnswer(answer('chat-contend', `ca-${turn}`, `c-${turn}`));
    } catch (e) {
      if (isBusy(e)) out.busy++;
      else throw e;
    }
    op = 'reads';
    const w = performance.now() - s2;
    out.save.push(w);
    if (w > 50) out.waited++;
    turn++;
    await new Promise((r) => setImmediate(r));
  };
  const alone = { retrieve: [] as number[], save: [] as number[], busy: 0, waited: 0 };
  for (let i = 0; i < 50; i++) await mix(alone);

  const during = { retrieve: [] as number[], save: [] as number[], busy: 0, waited: 0 };
  const worker = { imports: [] as { ms: number; matched?: number; created?: number; total?: number; error?: string; busy?: boolean }[], tx: {} as Record<string, number[]>, maxRssMb: 0, heapUsedMb: 0, wallMs: 0, startupMs: 0 };
  const loopDelay = monitorEventLoopDelay({ resolution: 1 });
  const tSpawn = performance.now();
  await new Promise<void>((resolveRun, reject) => {
    const child = spawn(join(APP_DIR, 'node_modules/.bin/vite-node'), [SCRIPT, '--ingest-worker', path, '--results', String(RESULTS), '--imports', String(IMPORTS), '--tests', String(TESTS)], { cwd: APP_DIR, stdio: ['ignore', 'pipe', 'inherit'] });
    let buf = '';
    let finished = false;
    let tReady = 0;
    let looping: Promise<void> = Promise.resolve();
    const loop = async () => {
      while (!finished) await mix(during);
    };
    child.stdout.on('data', (d: Buffer) => {
      buf += d.toString();
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith('{')) continue;
        const msg = JSON.parse(line) as { type: string } & Record<string, unknown>;
        if (msg.type === 'ready') {
          tReady = performance.now();
          worker.startupMs = Math.round(tReady - tSpawn);
          loopDelay.enable();
          looping = loop().catch(reject);
        } else if (msg.type === 'import') worker.imports.push(msg as unknown as (typeof worker.imports)[number]);
        else if (msg.type === 'done') {
          worker.tx = msg.tx as Record<string, number[]>;
          worker.maxRssMb = msg.maxRssMb as number;
          worker.heapUsedMb = msg.heapUsedMb as number;
        }
      }
    });
    child.on('exit', (code) => {
      finished = true;
      loopDelay.disable();
      worker.wallMs = Math.round(performance.now() - tReady);
      if (code !== 0) reject(new Error(`ingestion worker exited with ${code}`));
      else void looping.then(() => resolveRun());
    });
  });
  snap('after concurrent ingestion');

  // Checkpoint the WAL back into the database file, then back up and rehearse a restore.
  const walBefore = fileSize(`${path}-wal`);
  const tCk = performance.now();
  db.raw.pragma('wal_checkpoint(TRUNCATE)');
  const checkpointMs = performance.now() - tCk;
  snap('after checkpoint');

  const backupPath = join(dir, 'backup.db');
  const tB = performance.now();
  await db.raw.backup(backupPath);
  const backupMs = performance.now() - tB;
  // In process: what restore-check does to the copy (copy, open with migrations, integrity, foreign keys).
  const tR = performance.now();
  const scratch = join(dir, 'restored.db');
  copyFileSync(backupPath, scratch);
  const restored = openDb(scratch);
  const integrity = restored.raw.pragma('integrity_check', { simple: true });
  const fk = (restored.raw.pragma('foreign_key_check') as unknown[]).length;
  restored.raw.close();
  const restoreCoreMs = performance.now() - tR;
  rmSync(scratch, { force: true });
  // The real script, as an operator runs it (includes starting vite-node and checking every stored file).
  const tS = performance.now();
  const script = await new Promise<{ code: number | null; out: string }>((res) => {
    const c = spawn(join(APP_DIR, 'node_modules/.bin/vite-node'), [join(APP_DIR, 'scripts/restore-check.ts'), backupPath, filesDir], { cwd: APP_DIR, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    c.stdout.on('data', (d: Buffer) => (out += d.toString()));
    c.stderr.on('data', () => {});
    c.on('exit', (code) => res({ code, out }));
  });
  const restoreScriptMs = performance.now() - tS;
  let restoreProblems: string[] = [];
  try {
    const parsed = JSON.parse(script.out) as { restoredTo?: string; problems?: string[] };
    restoreProblems = parsed.problems ?? [];
    // restore-check leaves its scratch copy for inspection; this run is disposable.
    if (parsed.restoredTo && parsed.restoredTo.startsWith(tmpdir())) rmSync(dirname(parsed.restoredTo), { recursive: true, force: true });
  } catch {
    restoreProblems = ['restore-check output was not JSON'];
  }

  clearInterval(sampler);
  const usageNow = process.resourceUsage();
  const txReport = Object.fromEntries([...tx.entries(), ...Object.entries(worker.tx)].filter(([k]) => k !== 'fill' && k !== 'reads').map(([k, v]) => [k, fmt(v)]));
  const report = {
    sizes: { passages: PASSAGES, tests: TESTS, modelCalls: CALLS, extraApps: EXTRA_APPS, appPassages: APP_PASSAGES, appTests: APP_TESTS, chatMessages: chatCounts.messages, chatRevisions: chatCounts.revisions, attachments: ATTACHMENTS, junitResultsPerImport: RESULTS, imports: IMPORTS, dbMb: sizes.find((s) => s.at === 'after fill')!.dbMb },
    fillMs: { passagesAndVectors: Math.round(tPassages), testsResultsCalls: Math.round(tRest) },
    ms: {
      retrieveKeyword: fmt(keyword),
      retrieveHybridFirst: +hybridCold[0].toFixed(1),
      retrieveHybrid: fmt(hybrid),
      listTestsSearch: fmt(search),
      usageFirst: +usageCold[0].toFixed(1),
      usageCached: fmt(usage),
      coverageFor: fmt(coverage),
      uatStates: fmt(states),
    },
    multiApp: {
      firstCallMs: Object.fromEntries(Object.entries(perAppFirst).map(([k, v]) => [k, +v.toFixed(1)])),
      retrieveHybridByApp: Object.fromEntries([...perApp.entries()].map(([k, v]) => [k, fmt(v)])),
      retrieveHybridAll: fmt(multiAppAll),
      listTestsSearchOtherApp: fmt(searchOther),
    },
    chat: { addUserMessage: fmt(addMsg), saveAnswer: fmt(save), getChatFull: fmt(chatRead), listChats: fmt(chatList), attachmentPutAndRow: fmt(attachMs) },
    concurrent: {
      alone: { retrieveHybrid: fmt(alone.retrieve), saveTurn: fmt(alone.save), busyErrors: alone.busy, waitedOver50ms: alone.waited },
      duringIngestion: { retrieveHybrid: fmt(during.retrieve), saveTurn: fmt(during.save), busyErrors: during.busy, waitedOver50ms: during.waited, turns: during.save.length },
      ingestion: { imports: worker.imports.length, importMs: fmt(worker.imports.map((x) => x.ms)), failed: worker.imports.filter((x) => x.error).length, busyFailures: worker.imports.filter((x) => x.busy).length, matched: worker.imports[0]?.matched ?? null, created: worker.imports[0]?.created ?? null, workerStartupMs: worker.startupMs, phaseMs: worker.wallMs },
      // Share of the phase the worker held the write lock: its transaction time over the phase's wall time.
      workerLockShare: worker.wallMs ? +(Object.values(worker.tx).flat().reduce((a, b) => a + b, 0) / worker.wallMs).toFixed(3) : 0,
      eventLoopDelayMs: { p50: +(loopDelay.percentile(50) / 1e6).toFixed(1), p99: +(loopDelay.percentile(99) / 1e6).toFixed(1), max: +(loopDelay.max / 1e6).toFixed(1) },
    },
    transactionsMs: txReport,
    memoryMb: { mainPeakRss: +(usageNow.maxRSS / 1024).toFixed(1), mainPeakHeapSampled: mb(heapPeak), mainPeakRssSampled: mb(rssPeak), workerPeakRss: worker.maxRssMb },
    growth: sizes,
    checkpoint: { walMbBefore: mb(walBefore), ms: +checkpointMs.toFixed(1) },
    backup: { ms: Math.round(backupMs), mb: mb(fileSize(backupPath)) },
    restore: { coreMs: Math.round(restoreCoreMs), integrity, foreignKeyViolations: fk, scriptMs: Math.round(restoreScriptMs), scriptExit: script.code, scriptProblems: restoreProblems },
    retrieval: { candidates: sample.candidates, mode: sample.mode, passages: sample.passages.length },
    eventLoopBlockMs: { p50: +pct(gaps, 50).toFixed(1), p99: +pct(gaps, 99).toFixed(1), max: +Math.max(...gaps).toFixed(1) },
    note: 'Synthetic data on this machine; no model inference; not a capacity claim.',
  };
  db.raw.close();
  rmSync(dir, { recursive: true, force: true });
  if (JSON_OUT) {
    console.log(JSON.stringify(report));
    return;
  }
  const s = (v: Stat) => `p50 ${v.p50} · p95 ${v.p95} · p99 ${v.p99} · max ${v.max} ms (n ${v.n})`;
  const row = (k: string, v: string) => console.log(`${k.padEnd(40)} ${v}`);
  console.log(`Load profile: ABCD ${PASSAGES} passages, ${TESTS} tests, ${CALLS} model calls; ${EXTRA_APPS} more applications with ${APP_PASSAGES} passages and ${APP_TESTS} tests each; ${report.sizes.dbMb} MB after fill`);
  row('fill', `passages+vectors ${report.fillMs.passagesAndVectors} ms, tests+results+calls ${report.fillMs.testsResultsCalls} ms`);
  console.log('\n-- Reads (ABCD)');
  for (const [k, v] of Object.entries(report.ms)) row(k, typeof v === 'number' ? `${v} ms (first)` : s(v));
  row('event-loop block, hybrid retrievals', `p50 ${report.eventLoopBlockMs.p50} · p99 ${report.eventLoopBlockMs.p99} · max ${report.eventLoopBlockMs.max} ms`);
  console.log('\n-- Several applications (hybrid retrieval, interleaved)');
  for (const [k, v] of Object.entries(report.multiApp.retrieveHybridByApp)) row(`retrieve ${k}${report.multiApp.firstCallMs[k] != null ? ` (first ${report.multiApp.firstCallMs[k]} ms)` : ''}`, s(v));
  row('retrieve, all applications', s(report.multiApp.retrieveHybridAll));
  row('listTests search, another application', s(report.multiApp.listTestsSearchOtherApp));
  console.log(`\n-- Long chat (${chatCounts.messages} messages, ${chatCounts.revisions} revisions)`);
  for (const [k, v] of Object.entries(report.chat)) row(k, s(v));
  console.log(`\n-- Concurrent: ${IMPORTS} JUnit imports of ${RESULTS} results in a second process while this one retrieves and saves answers`);
  const c = report.concurrent;
  row('retrieve, alone', s(c.alone.retrieveHybrid));
  row('retrieve, during ingestion', s(c.duringIngestion.retrieveHybrid));
  row('save a turn (message+answer), alone', s(c.alone.saveTurn));
  row('save a turn, during ingestion', s(c.duringIngestion.saveTurn));
  row('busy errors / turns waiting > 50 ms', `alone ${c.alone.busyErrors} / ${c.alone.waitedOver50ms}; during ${c.duringIngestion.busyErrors} / ${c.duringIngestion.waitedOver50ms} of ${c.duringIngestion.turns}`);
  row('JUnit import (worker, parse+match+store)', `${s(c.ingestion.importMs)}; ${c.ingestion.failed} failed (${c.ingestion.busyFailures} busy); matched ${c.ingestion.matched}, created ${c.ingestion.created}`);
  row('write lock held by the worker', `${(c.workerLockShare * 100).toFixed(1)}% of the ${c.ingestion.phaseMs} ms phase (its transaction time)`);
  row('event-loop delay during the phase', `p50 ${c.eventLoopDelayMs.p50} · p99 ${c.eventLoopDelayMs.p99} · max ${c.eventLoopDelayMs.max} ms`);
  console.log('\n-- Write transactions (outermost, including any wait for the write lock)');
  for (const [k, v] of Object.entries(report.transactionsMs)) row(k, s(v));
  console.log('\n-- Memory');
  row('main process peak RSS', `${report.memoryMb.mainPeakRss} MB (sampled heap peak ${report.memoryMb.mainPeakHeapSampled} MB)`);
  row('ingestion worker peak RSS', `${report.memoryMb.workerPeakRss} MB`);
  console.log('\n-- Growth (DB file, WAL, blob files; RSS and heap of this process)');
  for (const g of sizes) row(g.at, `db ${g.dbMb} MB · wal ${g.walMb} MB · blobs ${g.blobsMb} MB · rss ${g.rssMb} MB · heap ${g.heapMb} MB`);
  row('WAL checkpoint (TRUNCATE)', `${report.checkpoint.ms} ms for ${report.checkpoint.walMbBefore} MB of WAL`);
  console.log('\n-- Backup and restore');
  row('online backup (db.raw.backup)', `${report.backup.ms} ms, ${report.backup.mb} MB`);
  row('restore check, in process', `${report.restore.coreMs} ms (copy, open, integrity ${report.restore.integrity}, ${report.restore.foreignKeyViolations} FK violations)`);
  row('restore check, the script', `${report.restore.scriptMs} ms, exit ${report.restore.scriptExit}${report.restore.scriptProblems.length ? `, problems: ${report.restore.scriptProblems.join('; ')}` : ''}`);
  console.log(`\n${report.note}`);
}

if (argv[0] === '--ingest-worker') {
  ingestWorker(argv[1]).catch((e) => {
    console.error(e);
    process.exit(1);
  });
} else {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
