/**
 * Relevance evaluation of App Context retrieval (the scalability review's acceptance criterion 5),
 * with the real local models. A disposable in-memory database is filled with the fixture corpus
 * (server/relevance: team documents written for the fixture, plus Apache-2.0/MIT documentation
 * excerpts), every passage is embedded, and the labelled questions are asked in three modes:
 *
 *   keyword             no models: FTS5 candidates and keyword overlap
 *   hybrid              embedder, no reranker: keyword and vector order fused
 *   hybrid + rerank     embedder and cross-encoder: the configuration the app ships with
 *
 * Each mode runs bounded (retrieveContext: FTS5 prefilter plus nearest vectors, as answers get it)
 * and unbounded (the same ranking over every passage), so a candidate the bound drops shows up.
 *
 *   cd app && HORIZON_MODELS_DIR=data/models HORIZON_MODELS_OFFLINE=1 ./node_modules/.bin/vite-node scripts/retrieval-eval.ts [--pad <dir>] [--verbose] [--json]
 *
 * --pad <dir> adds every documentation passage found under <dir>/<team>/repos/<repo> (for example
 * the git-ignored .myworkspace clones) as distractors, so the candidate bound actually bites. The
 * labels stay those of the fixture; padding passages are never counted relevant, so treat padded
 * recall as a lower bound and look at the bounded-versus-unbounded comparison.
 *
 * Metrics: recall@4 (share of relevant passages in the top four, capped at four), hit@4, MRR (first
 * relevant passage), the no-answer false-positive rate (share of unanswerable questions that got any
 * passage) and off-target (share of returned passages on answerable questions not labelled relevant).
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

import { chunkDocs, collectDocs } from '../server/context';
import { buildDb, compareRuns, embedAll, fixtureCorpus, retrieveBounded, runAll, scoreByKind, unboundedRetriever, type CorpusPassage, type Metrics } from '../server/relevance/harness';
import { QUESTIONS } from '../server/relevance/questions';
import { localModels, DEFAULT_EMBED_MODEL, DEFAULT_RERANK_MODEL, NO_MODELS, type RetrievalModels } from '../server/retrieval';

const argv = process.argv.slice(2);
const flag = (n: string) => argv.includes(`--${n}`);
const opt = (n: string) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const JSON_OUT = flag('json');
const VERBOSE = flag('verbose');
const PAD = opt('pad');

/** Documentation passages under <dir>/<team>/repos/<repo>, minus any that repeat a fixture passage (the excerpts came from the same clones). */
function padding(dir: string, fixture: CorpusPassage[]): CorpusPassage[] {
  const norm = (s: string) => s.replace(/…$/, '').replace(/\s+/g, ' ').trim().slice(0, 200);
  const seen = new Set(fixture.map((p) => norm(p.text)));
  const out: CorpusPassage[] = [];
  for (const team of readdirSync(dir)) {
    const repos = join(dir, team, 'repos');
    if (!existsSync(repos) || !statSync(repos).isDirectory()) continue;
    for (const repo of readdirSync(repos)) {
      const docs = collectDocs(join(repos, repo));
      for (const c of chunkDocs(docs)) {
        if (seen.has(norm(c.text))) continue;
        seen.add(norm(c.text));
        out.push({ id: `pad:${team}/${repo}:${c.locator}`, source: `pad-${team}-${repo}`, sourceTitle: repo, sourceType: 'Repository', locator: c.locator, text: c.text });
      }
    }
  }
  return out;
}

async function main() {
  const cacheDir = process.env.HORIZON_MODELS_DIR?.trim() || 'data/models';
  const real = localModels({ cacheDir, embedModel: process.env.HORIZON_EMBED_MODEL?.trim() || DEFAULT_EMBED_MODEL, rerankModel: process.env.HORIZON_RERANK_MODEL?.trim() || DEFAULT_RERANK_MODEL, allowDownload: process.env.HORIZON_MODELS_OFFLINE !== '1' });
  const corpus = fixtureCorpus();
  const pad = PAD ? padding(PAD, corpus) : [];
  const db = buildDb([...corpus, ...pad]);
  const t0 = performance.now();
  const emb = await embedAll(db, real);
  const embedMs = performance.now() - t0;
  if (emb.failed || emb.embedded === 0) throw new Error(`The embedder did not run (${emb.failed} failed). Set HORIZON_MODELS_DIR to the cached models.`);
  // Load the reranker before timing, so the first mode does not pay for it.
  await real.reranker?.score('warm up', ['warm up']);

  const modes: { name: string; models: RetrievalModels }[] = [
    { name: 'keyword', models: NO_MODELS },
    { name: 'hybrid', models: { embedder: real.embedder, reranker: null } },
    { name: 'hybrid+rerank', models: real },
  ];
  const rows: { mode: string; run: 'bounded' | 'unbounded'; metrics: Record<string, Metrics>; msPerQuestion: number }[] = [];
  const comparisons: { mode: string; differ: number; lostRelevant: { question: string; passage: string }[] }[] = [];
  const failures: Record<string, { id: string; kind: string; q: string; got: string[]; want: string[] }[]> = {};
  for (const m of modes) {
    const tb = performance.now();
    const bounded = await runAll(QUESTIONS, (q) => retrieveBounded(db, m.models, q));
    const msB = (performance.now() - tb) / QUESTIONS.length;
    const all = unboundedRetriever(db, m.models);
    const tu = performance.now();
    const unbounded = await runAll(QUESTIONS, all);
    const msU = (performance.now() - tu) / QUESTIONS.length;
    rows.push({ mode: m.name, run: 'bounded', metrics: scoreByKind(QUESTIONS, bounded), msPerQuestion: +msB.toFixed(1) });
    rows.push({ mode: m.name, run: 'unbounded', metrics: scoreByKind(QUESTIONS, unbounded), msPerQuestion: +msU.toFixed(1) });
    const c = compareRuns(QUESTIONS, bounded, unbounded);
    comparisons.push({ mode: m.name, differ: c.differ, lostRelevant: c.lost });
    failures[m.name] = QUESTIONS.filter((q) => {
      const got = bounded.get(q.id) ?? [];
      return q.relevant.length ? !got.some((id) => q.relevant.includes(id)) : got.length > 0;
    }).map((q) => ({ id: q.id, kind: q.kind, q: q.q, got: bounded.get(q.id) ?? [], want: q.relevant }));
  }
  db.raw.close();

  const report = {
    corpus: { fixture: corpus.length, padding: pad.length, questions: QUESTIONS.length, byKind: Object.fromEntries(['paraphrase', 'exact', 'mixed', 'none'].map((k) => [k, QUESTIONS.filter((q) => q.kind === k).length])) },
    models: { embedder: real.embedder?.id, reranker: real.reranker?.id, embedMs: Math.round(embedMs) },
    rows,
    comparisons,
    failures,
    note: 'Fixture corpus and labels on this machine; small sample (59 questions), so a difference of one question moves recall by about 0.02.',
  };
  if (JSON_OUT) {
    console.log(JSON.stringify(report));
    return;
  }
  console.log(`Retrieval evaluation: ${corpus.length} fixture passages${pad.length ? ` + ${pad.length} padding` : ''}, ${QUESTIONS.length} questions (${Object.entries(report.corpus.byKind).map(([k, n]) => `${n} ${k}`).join(', ')}); embedded in ${report.models.embedMs} ms`);
  const head = ['mode', 'run', 'recall@4', 'hit@4', 'MRR', 'no-answer FP', 'off-target', 'para recall', 'para MRR', 'exact recall', 'mixed recall', 'ms/q'];
  console.log(head.join(' | '));
  for (const r of rows) {
    const a = r.metrics.all;
    console.log([r.mode, r.run, a.recallAt4, a.hitAt4, a.mrr, a.noAnswerFalsePositive, a.offTarget, r.metrics.paraphrase.recallAt4, r.metrics.paraphrase.mrr, r.metrics.exact.recallAt4, r.metrics.mixed.recallAt4, r.msPerQuestion].join(' | '));
  }
  for (const c of comparisons) console.log(`${c.mode}: bounded and unbounded top-4 differ on ${c.differ}/${QUESTIONS.length} questions; relevant passages found only unbounded: ${c.lostRelevant.length ? c.lostRelevant.map((l) => `${l.question} ${l.passage}`).join('; ') : 'none'}`);
  for (const [mode, f] of Object.entries(failures)) {
    console.log(`${mode}: misses ${f.map((x) => x.id).join(' ') || 'none'}`);
    if (VERBOSE) for (const x of f) console.log(`   ${x.id} [${x.kind}] ${x.q}\n      got  ${x.got.join(' | ') || '(nothing)'}\n      want ${x.want.join(' | ') || '(nothing)'}`);
  }
  console.log(report.note);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
