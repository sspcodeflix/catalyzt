/**
 * A repeatable, disposable load profile (the scalability review's acceptance criterion 3): a fresh
 * database is filled with synthetic data at the sizes the review measured, then the hot operations
 * are timed. Numbers are observations on this machine, not capacity claims.
 *
 *   cd app && ./node_modules/.bin/vite-node scripts/load-profile.ts [--passages 50000] [--tests 25000] [--calls 100000] [--rounds 20] [--json]
 *
 * Measured: retrieveContext (keyword only, and hybrid with synthetic unit vectors), listTests with a
 * search, usage(), coverageFor, uatStates, the event-loop delay a retrieval causes, and the database
 * size. Nothing touches the real database, the workspace or a model.
 */
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

import { retrieveContext, seedContext } from '../server/context';
import { openDb, seedWorkspace } from '../server/db';
import { FIXTURE } from '../server/fixture';
import { toBlob, type RetrievalModels } from '../server/retrieval';

const arg = (name: string, def: number) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? Number(process.argv[i + 1]) : def;
};
const PASSAGES = arg('passages', 50_000);
const TESTS = arg('tests', 25_000);
const CALLS = arg('calls', 100_000);
const ROUNDS = arg('rounds', 20);
const JSON_OUT = process.argv.includes('--json');
const DIMS = 384;

const WORDS = 'refund settlement merchant account statistics currency checkout cart payment shipping notification gateway config token kubernetes ingress certificate pod restart rollout batch file validation ascending number addenda return reversal balance deposit export import schedule retry webhook queue latency cache session'.split(' ');
const pick = (seed: number) => WORDS[seed % WORDS.length];
const sentence = (i: number) => Array.from({ length: 120 }, (_, k) => pick(i * 7 + k * 13 + ((i * k) % 5))).join(' ');

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
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
const fmt = (xs: number[]) => ({ p50: +pct(xs, 50).toFixed(1), p95: +pct(xs, 95).toFixed(1), p99: +pct(xs, 99).toFixed(1), max: +Math.max(...xs).toFixed(1) });

async function timed<T>(fn: () => Promise<T> | T, rounds = ROUNDS): Promise<number[]> {
  const out: number[] = [];
  for (let i = 0; i < rounds; i++) {
    const t0 = performance.now();
    await fn();
    out.push(performance.now() - t0);
  }
  return out;
}

async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'catalyzt-load-'));
  const path = join(dir, 'load.db');
  const db = openDb(path);
  seedWorkspace(db, FIXTURE);
  seedContext(db, FIXTURE);
  const t0 = performance.now();

  // Passages for ABCD's repository source, with a synthetic vector each (unit length) for a fake model.
  const insChunk = db.raw.prepare("INSERT INTO source_chunks (id, source_id, locator, text, seq, source_version, chars, text_sha) VALUES (?, 'ABCD-repo-shop', ?, ?, ?, 1, ?, ?)");
  const insVec = db.raw.prepare("INSERT INTO chunk_embeddings (chunk_id, model, dims, vector, text_sha, created_at) VALUES (?, 'synthetic', ?, ?, ?, 't')");
  db.raw.transaction(() => {
    for (let i = 0; i < PASSAGES; i++) {
      const text = sentence(i);
      insChunk.run(`ABCD-repo-shop@load#${i}`, `docs/load-${i % 500}.md ¶${i}`, text, 100 + i, text.length, `sha${i}`);
      insVec.run(`ABCD-repo-shop@load#${i}`, DIMS, toBlob(unit(i)), `sha${i}`);
    }
  })();
  const tPassages = performance.now() - t0;

  // Automated tests with results in one run, and model calls.
  const t1 = performance.now();
  const insTest = db.raw.prepare("INSERT INTO test_cases (id, application_id, title, suite, code_name, kind, framework, origin, repo, path, status, created_by, created_at, updated_at) VALUES (?, 'ABCD', ?, ?, ?, 'automated', 'JUnit', 'ci_results', 'acme/shop', ?, 'active', 'u-ram', 't', 't')");
  db.raw.transaction(() => {
    for (let i = 0; i < TESTS; i++) insTest.run(`TC-LOAD${i}`, `${pick(i)} ${pick(i + 3)} test ${i}`, `com.acme.${pick(i)}.${pick(i + 1)}Test`, `test${i}`, `src/${pick(i)}/x${i % 300}.java`);
  })();
  db.raw.prepare("INSERT INTO test_runs (id, application_id, source, repo, attempt, status, total, passed, failed, skipped, sha, is_merge, started_at, ingested_at) VALUES ('run-load', 'ABCD', 'webhook', 'acme/shop', 1, 'failed', ?, ?, ?, 0, 'loadsha', 1, 't', 't')").run(TESTS, TESTS - 10, 10);
  const insRes = db.raw.prepare("INSERT INTO test_results (run_id, test_case_id, status) VALUES ('run-load', ?, ?)");
  db.raw.transaction(() => {
    for (let i = 0; i < TESTS; i++) insRes.run(`TC-LOAD${i}`, i < 10 ? 'failed' : 'passed');
  })();
  db.raw.prepare("INSERT INTO workflow_runs (id, application_id, requested_by, status, started_at) VALUES ('wf-load', 'ABCD', 'u-ram', 'done', 't')").run();
  const insCall = db.raw.prepare("INSERT INTO model_calls (workflow_run_id, agent, user_id, model, purpose, status, prompt_tokens, completion_tokens, latency_ms, created_at) VALUES ('wf-load', ?, 'u-ram', 'deepseek-flash', 'answer', 'ok', 900, 300, 1200, ?)");
  db.raw.transaction(() => {
    for (let i = 0; i < CALLS; i++) insCall.run(i % 2 ? 'Analysis agent' : 'Router', new Date(Date.now() - (i % 30) * 86_400_000).toISOString());
  })();
  const tRest = performance.now() - t1;

  const fake: RetrievalModels = { embedder: { id: 'synthetic', dims: DIMS, embed: async (texts) => texts.map((_, i) => unit(99_991 + i)) }, reranker: null };
  const q = 'refund settlement window for the merchant account';

  const keyword = await timed(() => retrieveContext(db, 'ABCD', q));
  const hybridCold = await timed(() => retrieveContext(db, 'ABCD', q, { models: fake }), 1);
  const hybrid = await timed(() => retrieveContext(db, 'ABCD', q, { models: fake }));
  const sample = await retrieveContext(db, 'ABCD', q, { models: fake });
  const search = await timed(() => db.listTests('ABCD', { q: 'refund', limit: 50 }));
  const usageCold = await timed(() => db.usage('ABCD'), 1);
  const usage = await timed(() => db.usage('ABCD'));
  const coverage = await timed(() => db.coverageFor('ABCD-1001'));
  const states = await timed(() => db.uatStates('ABCD'));

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

  const report = {
    sizes: { passages: PASSAGES, tests: TESTS, modelCalls: CALLS, dbMb: +(statSync(path).size / 1_048_576).toFixed(1) },
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
    retrieval: { candidates: sample.candidates, mode: sample.mode, passages: sample.passages.length },
    eventLoopBlockMs: { p50: +pct(gaps, 50).toFixed(1), p99: +pct(gaps, 99).toFixed(1), max: +Math.max(...gaps).toFixed(1) },
    note: 'Synthetic data on this machine; no model inference; not a capacity claim.',
  };
  db.raw.close();
  rmSync(dir, { recursive: true, force: true });
  if (JSON_OUT) console.log(JSON.stringify(report));
  else {
    console.log(`Load profile: ${PASSAGES} passages, ${TESTS} tests, ${CALLS} model calls, ${report.sizes.dbMb} MB`);
    console.log(`fill: passages+vectors ${report.fillMs.passagesAndVectors} ms, tests+results+calls ${report.fillMs.testsResultsCalls} ms`);
    for (const [k, v] of Object.entries(report.ms)) console.log(`${k.padEnd(22)} ${typeof v === 'number' ? `${v} ms (first)` : `p50 ${v.p50} · p95 ${v.p95} · p99 ${v.p99} · max ${v.max} ms`}`);
    console.log(`retrieval: ${report.retrieval.candidates} candidates, mode ${report.retrieval.mode}, ${report.retrieval.passages} passages`);
    console.log(`event-loop block during hybrid retrievals: p50 ${report.eventLoopBlockMs.p50} · p99 ${report.eventLoopBlockMs.p99} · max ${report.eventLoopBlockMs.max} ms`);
    console.log(report.note);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
