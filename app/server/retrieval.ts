/**
 * Hybrid retrieval for App Context: keyword overlap and vector similarity fused by rank, then a
 * cross-encoder reranker over the best candidates. Everything runs on this host.
 *
 *   embedder   Xenova/all-MiniLM-L6-v2 (384 dimensions, quantised, ~23 MB): one vector per passage,
 *              stored in SQLite (chunk_embeddings), one for the question at request time.
 *   reranker   Xenova/ms-marco-MiniLM-L-6-v2 (~23 MB): reads the question together with each of the
 *              top candidates and scores how well the passage answers it.
 *
 * Both are ONNX models run by @huggingface/transformers on the CPU. They are downloaded once into
 * HORIZON_MODELS_DIR (default data/models) and loaded lazily on first use. When they are not
 * configured, cannot load, or no passage has a vector yet, retrieval is keyword-only and says so:
 * the API reports the mode, the answer's step says which was used.
 *
 * Nothing here talks to the database except the embedding job, which embeds passages that have
 * no vector for the configured model, in batches, outside request transactions.
 */
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

import type { HorizonDb } from './db';

/* ---------- Model interfaces ---------- */

export interface Embedder {
  /** Model id, stored with every vector so a model change re-embeds. */
  id: string;
  dims: number;
  /** Unit-length vectors, one per text, in order. */
  embed(texts: string[]): Promise<Float32Array[]>;
}

export interface Reranker {
  id: string;
  /** One score per passage: a logit, higher is more relevant. */
  score(query: string, passages: string[]): Promise<number[]>;
}

export interface RetrievalModels {
  embedder: Embedder | null;
  reranker: Reranker | null;
}

export const NO_MODELS: RetrievalModels = { embedder: null, reranker: null };

/* ---------- Local models (transformers.js) ---------- */

export interface LocalModelOptions {
  cacheDir: string;
  embedModel: string;
  rerankModel: string | null;
  /** false: never download; the models must already be in cacheDir. */
  allowDownload: boolean;
  log?: (line: string) => void;
}

export const DEFAULT_EMBED_MODEL = 'Xenova/all-MiniLM-L6-v2';
export const DEFAULT_RERANK_MODEL = 'Xenova/ms-marco-MiniLM-L-6-v2';

type Loader<T> = () => Promise<T>;

/** Loads once; a failure is remembered (and reported) instead of retried on every request. */
class Lazy<T> {
  private p: Promise<T> | null = null;
  state: 'idle' | 'loading' | 'ready' | 'failed' = 'idle';
  error: string | null = null;
  constructor(private readonly load: Loader<T>) {}
  get(): Promise<T> {
    if (!this.p) {
      this.state = 'loading';
      this.p = this.load().then(
        (v) => {
          this.state = 'ready';
          return v;
        },
        (e: unknown) => {
          this.state = 'failed';
          this.error = e instanceof Error ? e.message : String(e);
          throw e;
        },
      );
    }
    return this.p;
  }
}

interface FeaturePipeline {
  (texts: string[], opts: { pooling: 'mean'; normalize: boolean }): Promise<{ dims: number[]; data: Float32Array | number[] }>;
}
interface CrossEncoder {
  tokenizer: (a: string[], o: { text_pair: string[]; padding: boolean; truncation: boolean; max_length: number }) => unknown;
  model: (inputs: unknown) => Promise<{ logits: { data: ArrayLike<number> } }>;
}

async function transformers() {
  const m = await import('@huggingface/transformers');
  return m;
}

/**
 * The two local models behind one lazily loaded handle each. `status()` is what the API shows.
 */
export function localModels(o: LocalModelOptions): RetrievalModels & { status(): { embedder: Lazy<unknown>['state']; reranker: Lazy<unknown>['state'] | 'off'; error: string | null } } {
  const log = o.log ?? (() => {});
  const configure = async () => {
    const t = await transformers();
    t.env.cacheDir = resolve(o.cacheDir);
    t.env.allowRemoteModels = o.allowDownload;
    t.env.allowLocalModels = true;
    return t;
  };
  const embedLazy = new Lazy<FeaturePipeline>(async () => {
    const t = await configure();
    const t0 = Date.now();
    const p = (await t.pipeline('feature-extraction', o.embedModel, { dtype: 'q8' })) as unknown as FeaturePipeline;
    log(`[retrieval] embedder ${o.embedModel} ready in ${Date.now() - t0} ms`);
    return p;
  });
  const rerankLazy = new Lazy<CrossEncoder>(async () => {
    const t = await configure();
    const t0 = Date.now();
    const id = o.rerankModel!;
    const tokenizer = await t.AutoTokenizer.from_pretrained(id);
    const model = await t.AutoModelForSequenceClassification.from_pretrained(id, { dtype: 'q8' });
    log(`[retrieval] reranker ${id} ready in ${Date.now() - t0} ms`);
    return { tokenizer: tokenizer as unknown as CrossEncoder['tokenizer'], model: model as unknown as CrossEncoder['model'] };
  });

  const embedder: Embedder = {
    id: o.embedModel,
    dims: 384,
    async embed(texts) {
      if (texts.length === 0) return [];
      const p = await embedLazy.get();
      const out = await p(texts, { pooling: 'mean', normalize: true });
      const dims = out.dims[out.dims.length - 1];
      embedder.dims = dims;
      const data = out.data instanceof Float32Array ? out.data : Float32Array.from(out.data);
      return texts.map((_, i) => data.slice(i * dims, (i + 1) * dims));
    },
  };
  const reranker: Reranker | null = o.rerankModel
    ? {
        id: o.rerankModel,
        async score(query, passages) {
          if (passages.length === 0) return [];
          const { tokenizer, model } = await rerankLazy.get();
          const inputs = tokenizer(Array(passages.length).fill(query), { text_pair: passages, padding: true, truncation: true, max_length: 512 });
          const { logits } = await model(inputs);
          return Array.from(logits.data).slice(0, passages.length);
        },
      }
    : null;
  return {
    embedder,
    reranker,
    status: () => ({ embedder: embedLazy.state, reranker: reranker ? rerankLazy.state : 'off', error: embedLazy.error ?? rerankLazy.error }),
  };
}

/**
 * Reads HORIZON_RETRIEVAL (hybrid, default, or keyword), HORIZON_RERANK (on, default, or off),
 * HORIZON_EMBED_MODEL, HORIZON_RERANK_MODEL, HORIZON_MODELS_DIR and HORIZON_MODELS_OFFLINE.
 */
export function modelsFromEnv(env: Record<string, string | undefined>, log?: (line: string) => void): RetrievalModels {
  const mode = (env.HORIZON_RETRIEVAL ?? 'hybrid').trim().toLowerCase();
  if (mode === 'keyword' || mode === 'off') return NO_MODELS;
  return localModels({
    cacheDir: env.HORIZON_MODELS_DIR?.trim() || 'data/models',
    embedModel: env.HORIZON_EMBED_MODEL?.trim() || DEFAULT_EMBED_MODEL,
    rerankModel: (env.HORIZON_RERANK ?? 'on').trim().toLowerCase() === 'off' ? null : env.HORIZON_RERANK_MODEL?.trim() || DEFAULT_RERANK_MODEL,
    allowDownload: env.HORIZON_MODELS_OFFLINE !== '1',
    log,
  });
}

/* ---------- Fake models for tests ---------- */

/**
 * Deterministic stand-ins: words are mapped through a synonym table, then hashed into a vector,
 * so "money back" can land next to "refund" without any model. The reranker scores the share of
 * the question's (canonical) words a passage contains, as a logit around zero.
 */
export function fakeModels(synonyms: Record<string, string> = {}, dims = 64): RetrievalModels & { calls: { embed: number; rerank: number } } {
  const calls = { embed: 0, rerank: 0 };
  const canon = (w: string) => synonyms[w] ?? w;
  const toks = (s: string) => (s.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((w) => w.length > 2).map(canon);
  const vec = (text: string) => {
    const v = new Float32Array(dims);
    for (const w of toks(text)) {
      const h = createHash('sha1').update(w).digest();
      for (let i = 0; i < 4; i++) v[h[i] % dims] += h[4 + i] & 1 ? 1 : -1;
    }
    let n = 0;
    for (const x of v) n += x * x;
    n = Math.sqrt(n) || 1;
    for (let i = 0; i < dims; i++) v[i] /= n;
    return v;
  };
  return {
    calls,
    embedder: {
      id: 'fake-embedder',
      dims,
      async embed(texts) {
        calls.embed++;
        return texts.map(vec);
      },
    },
    reranker: {
      id: 'fake-reranker',
      async score(query, passages) {
        calls.rerank++;
        const q = new Set(toks(query));
        return passages.map((p) => {
          const pw = new Set(toks(p));
          let hit = 0;
          for (const w of q) if (pw.has(w)) hit++;
          return q.size ? 12 * (hit / q.size) - 8 : -8;
        });
      },
    },
  };
}

/* ---------- Vectors in SQLite ---------- */

export const toBlob = (v: Float32Array) => Buffer.from(v.buffer, v.byteOffset, v.byteLength);
export const fromBlob = (b: Buffer) => new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
export const textSha = (t: string) => createHash('sha256').update(t).digest('hex');

export function cosine(a: Float32Array, b: Float32Array) {
  const n = Math.min(a.length, b.length);
  let s = 0;
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}

/* ---------- Ranking ---------- */

export interface Candidate {
  key: string;
  /** Source title and locator, shown and used for keyword matching. */
  where: string;
  text: string;
  /**
   * The passage's vector for the current embedder; null when it has none yet; undefined when the
   * candidate is never embedded (a Jira story or Hexa test row) and only keywords and the reranker see it.
   */
  vector?: Float32Array | null;
}

const embeddable = (c: Candidate) => c.vector !== undefined;

export type RetrievalMode = 'keyword' | 'hybrid';

export interface Ranked<T extends Candidate> {
  item: T;
  /** 0 to 1, comparable across modes; the bar for use is `minRelevance`. */
  relevance: number;
  keyword: number;
  vector: number | null;
  rerank: number | null;
}

export interface RankResult<T extends Candidate> {
  ranked: Ranked<T>[];
  mode: RetrievalMode;
  reranked: boolean;
  /** How many candidates had a vector, out of all. */
  embedded: number;
  total: number;
}

/** Words that carry no meaning for matching; without them "the" alone would make any passage relevant. */
export const STOP = new Set(['the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'any', 'can', 'had', 'her', 'was', 'one', 'our', 'out', 'has', 'have', 'his', 'how', 'its', 'may', 'new', 'now', 'old', 'see', 'two', 'way', 'who', 'why', 'did', 'does', 'get', 'got', 'let', 'say', 'she', 'too', 'use', 'with', 'this', 'that', 'what', 'when', 'where', 'which', 'while', 'from', 'into', 'than', 'then', 'them', 'they', 'their', 'there', 'these', 'those', 'will', 'would', 'should', 'could', 'about', 'after', 'before', 'being', 'been', 'were', 'your', 'ours', 'also', 'just', 'like', 'over', 'such', 'only', 'other', 'some', 'very', 'each', 'make', 'made', 'most', 'much', 'many', 'more', 'here', 'please', 'show', 'tell', 'give', 'need', 'want', 'know', 'does', 'is', 'it', 'in', 'on', 'of', 'to', 'be', 'as', 'at', 'by', 'or', 'an', 'if', 'do', 'so', 'we', 'he', 'me', 'my', 'no', 'up', 'us']);
/** A light stem, applied to questions and passages alike, so "refunds", "refunding" and "refund" count as one word (the full-text index stems too). */
export const stem = (w: string) => (w.length > 4 ? w.replace(/(ies|ing|ed|es|s)$/, (m) => (m === 'ies' ? 'y' : '')) : w);
export const words = (s: string) => s.toLowerCase().match(/[a-z0-9]+/g)?.filter((w) => w.length > 2 && !STOP.has(w)).map(stem) ?? [];

/** Keyword overlap, 0 to 1: how much of the question the passage covers, with a little for density. */
export function keywordScore(qw: Set<string>, c: { where: string; text: string }) {
  if (qw.size === 0) return 0;
  const cw = words(`${c.where} ${c.text}`);
  if (cw.length === 0) return 0;
  const hits = cw.filter((w) => qw.has(w));
  const matched = new Set(hits).size;
  return matched ? 0.7 * (matched / qw.size) + 0.3 * Math.min(1, hits.length / Math.sqrt(cw.length)) : 0;
}

/** Reciprocal rank fusion: a candidate high on either list rises; k softens the top ranks. */
const RRF_K = 60;
/** How many fused candidates the reranker reads. */
export const RERANK_CANDIDATES = 20;
/** Cosine below this says nothing about relevance for MiniLM-class models. */
const VECTOR_FLOOR = 0.15;
/**
 * Cross-encoder logits for a passage that answers the question sit around -5 and above; passages
 * about something else sit around -10. Relevance maps that range onto 0 to 1.
 */
const RERANK_FLOOR = -9;
const RERANK_SPAN = 10;
/** How much the keyword-and-vector agreement counts next to the reranker (0.6 × 0.5 average clears the 0.2 bar). */
const TOPICAL_WEIGHT = 0.6;
export const rerankRelevance = (logit: number) => Math.max(0, Math.min(1, (logit - RERANK_FLOOR) / RERANK_SPAN));

/**
 * Ranks candidates for a question. Keyword overlap always runs. With an embedder and at least one
 * embedded candidate the question is embedded too and both orders are fused; with a reranker the
 * top of the fused list is rescored by the cross-encoder. Candidates without a vector (not yet
 * embedded, or Jira and Hexa rows) still take part through keywords and the reranker.
 */
export async function rank<T extends Candidate>(models: RetrievalModels, query: string, cands: T[], opts: { limit: number; minRelevance: number; rerank?: boolean; queryVector?: Float32Array | null }): Promise<RankResult<T>> {
  const qw = new Set(words(query));
  const total = cands.filter(embeddable).length;
  const embedded = cands.filter((c) => c.vector).length;
  const kw = cands.map((c) => keywordScore(qw, c));
  const useVectors = !!models.embedder && embedded > 0 && query.trim().length > 0;
  const empty = (mode: RetrievalMode) => ({ ranked: [] as Ranked<T>[], mode, reranked: false, embedded, total });
  if (cands.length === 0) return empty(useVectors ? 'hybrid' : 'keyword');
  if (!useVectors && qw.size === 0) return empty('keyword');

  let vs: (number | null)[] = cands.map(() => null);
  if (useVectors) {
    let q = opts.queryVector ?? null;
    if (!q) {
      try {
        [q] = await models.embedder!.embed([query]);
      } catch {
        // The model could not load: keyword only, honestly labelled.
        return finish(models, query, cands, kw, vs, 'keyword', opts);
      }
    }
    const qv = q;
    vs = cands.map((c) => (c.vector ? cosine(qv, c.vector) : null));
  }
  return finish(models, query, cands, kw, vs, useVectors ? 'hybrid' : 'keyword', opts);
}

/** The question as a vector, or null when there is no embedder or it could not run (callers fall back to keywords). */
export async function embedQuery(models: RetrievalModels, query: string): Promise<Float32Array | null> {
  if (!models.embedder || !query.trim()) return null;
  try {
    const [q] = await models.embedder.embed([query]);
    return q ?? null;
  } catch {
    return null;
  }
}

/* ---------- Vector candidates (F24) ---------- */

interface VectorSet {
  stamp: string;
  rowids: number[];
  matrix: Float32Array;
  dims: number;
}
/** Per database: the current vectors of each application and model, as one matrix, rebuilt when they change. */
const VECTORS = new WeakMap<object, Map<string, VectorSet>>();

/**
 * The passages whose vectors are closest to the question: the application's current vectors are held
 * in memory as one matrix (50k passages × 384 floats is about 77 MB) and rebuilt only when their
 * count or latest row changes, so a question costs one pass of dot products, not a table load.
 */
export function vectorCandidates(db: HorizonDb, app: string, embedder: Embedder | null, q: Float32Array | null, k: number): number[] {
  if (!embedder || !q) return [];
  const sets = VECTORS.get(db) ?? new Map<string, VectorSet>();
  VECTORS.set(db, sets);
  const key = `${app}/${embedder.id}`;
  const st = db.raw
    .prepare(
      `SELECT COUNT(*) AS n, COALESCE(MAX(e.rowid), 0) AS m FROM chunk_embeddings e JOIN source_chunks c ON c.id = e.chunk_id JOIN context_sources s ON s.id = c.source_id
       WHERE e.model = ? AND s.application_id = ? AND c.retired_at IS NULL AND e.text_sha = c.text_sha`,
    )
    .get(embedder.id, app) as { n: number; m: number };
  const stamp = `${st.n}/${st.m}`;
  let set = sets.get(key);
  if (!set || set.stamp !== stamp) {
    const rows = db.raw
      .prepare(
        `SELECT c.rowid AS rid, e.vector FROM chunk_embeddings e JOIN source_chunks c ON c.id = e.chunk_id JOIN context_sources s ON s.id = c.source_id
         WHERE e.model = ? AND s.application_id = ? AND c.retired_at IS NULL AND e.text_sha = c.text_sha ORDER BY c.rowid`,
      )
      .all(embedder.id, app) as { rid: number; vector: Buffer }[];
    const usable = rows.filter((r) => r.vector.byteLength === q.length * 4);
    const dims = q.length;
    const matrix = new Float32Array(usable.length * dims);
    usable.forEach((r, i) => matrix.set(fromBlob(r.vector), i * dims));
    set = { stamp, rowids: usable.map((r) => r.rid), matrix, dims };
    sets.set(key, set);
  }
  if (set.rowids.length === 0 || set.dims !== q.length) return [];
  const scores = new Float32Array(set.rowids.length);
  for (let i = 0; i < set.rowids.length; i++) {
    let s = 0;
    const off = i * set.dims;
    for (let d = 0; d < set.dims; d++) s += set.matrix[off + d] * q[d];
    scores[i] = s;
  }
  return Array.from(scores.keys())
    .sort((a, b) => scores[b] - scores[a])
    .slice(0, k)
    .filter((i) => scores[i] >= 0.1)
    .map((i) => set!.rowids[i]);
}

async function finish<T extends Candidate>(models: RetrievalModels, query: string, cands: T[], kw: number[], vs: (number | null)[], mode: RetrievalMode, opts: { limit: number; minRelevance: number; rerank?: boolean }): Promise<RankResult<T>> {
  const idx = cands.map((_, i) => i);
  const byKw = idx.filter((i) => kw[i] > 0).sort((a, b) => kw[b] - kw[a] || cands[a].where.localeCompare(cands[b].where));
  const byVec = mode === 'hybrid' ? idx.filter((i) => (vs[i] ?? 0) >= VECTOR_FLOOR).sort((a, b) => (vs[b] ?? 0) - (vs[a] ?? 0) || cands[a].where.localeCompare(cands[b].where)) : [];
  const fused = new Map<number, number>();
  byKw.forEach((i, r) => fused.set(i, (fused.get(i) ?? 0) + 1 / (RRF_K + r)));
  byVec.forEach((i, r) => fused.set(i, (fused.get(i) ?? 0) + 1 / (RRF_K + r)));
  const order = [...fused.entries()].sort((a, b) => b[1] - a[1] || cands[a[0]].where.localeCompare(cands[b[0]].where)).map(([i]) => i);
  const embedded = cands.filter((c) => c.vector).length;
  const total = cands.filter(embeddable).length;

  const reranker = opts.rerank === false ? null : models.reranker;
  const top = order.slice(0, RERANK_CANDIDATES);
  let rerankScores: number[] | null = null;
  if (reranker && top.length > 0) {
    try {
      rerankScores = await reranker.score(
        query,
        top.map((i) => `${cands[i].where}\n${cands[i].text}`),
      );
    } catch {
      rerankScores = null;
    }
  }
  const ranked: Ranked<T>[] = top.map((i, pos) => {
    const rr = rerankScores ? rerankScores[pos] : null;
    // The cross-encoder says how well a passage answers the question. A passage that is clearly about
    // the question's subject (strong keyword and vector agreement) is still worth giving the model
    // when nothing answers it outright, so it can say what the sources do and do not state.
    const lexSem = vs[i] == null ? kw[i] : (kw[i] + vs[i]) / 2;
    const relevance = rr != null ? Math.max(rerankRelevance(rr), TOPICAL_WEIGHT * lexSem) : Math.max(kw[i], vs[i] ?? 0);
    return { item: cands[i], relevance: Math.round(relevance * 1000) / 1000, keyword: kw[i], vector: vs[i], rerank: rr };
  });
  if (rerankScores) ranked.sort((a, b) => b.relevance - a.relevance || a.item.where.localeCompare(b.item.where));
  return { ranked: ranked.filter((r) => r.relevance >= opts.minRelevance).slice(0, opts.limit), mode, reranked: !!rerankScores, embedded, total };
}

/* ---------- Embedding job ---------- */

const BATCH = 32;

/** Passages whose text hash is missing (rows from before migration 13) get it, so staleness can be checked in SQL. */
function backfillTextSha(db: HorizonDb) {
  const pick = db.raw.prepare('SELECT id, text FROM source_chunks WHERE text_sha IS NULL LIMIT 500');
  const set = db.raw.prepare('UPDATE source_chunks SET text_sha = ? WHERE id = ? AND text_sha IS NULL');
  for (;;) {
    const rows = pick.all() as { id: string; text: string }[];
    if (rows.length === 0) return;
    db.raw.transaction(() => rows.forEach((r) => set.run(textSha(r.text), r.id)))();
  }
}

/** Passages with a vector computed from their current text, for the status line. */
export function embeddingCounts(db: HorizonDb, model: string | null, app?: string): { embedded: number; pending: number } {
  const where = app ? 'WHERE s.application_id = ?' : '';
  const args = app ? [app] : [];
  const live = `${where ? `${where} AND` : 'WHERE'} c.retired_at IS NULL`;
  const total = (db.raw.prepare(`SELECT COUNT(*) AS n FROM source_chunks c JOIN context_sources s ON s.id = c.source_id ${live}`).get(...args) as { n: number }).n;
  if (!model) return { embedded: 0, pending: total };
  const embedded = (db.raw.prepare(`SELECT COUNT(*) AS n FROM source_chunks c JOIN context_sources s ON s.id = c.source_id JOIN chunk_embeddings e ON e.chunk_id = c.id AND e.model = ? AND e.text_sha = c.text_sha ${live}`).get(model, ...args) as { n: number }).n;
  return { embedded, pending: total - embedded };
}

/**
 * Embeds every passage that has no vector for this embedder computed from its current text, in
 * batches, each batch its own short transaction. A passage whose text changed while it was being
 * embedded is not written with the old vector (F25); the next pass embeds the new text. Returns how
 * many were embedded. Safe to run again at any time.
 */
export async function embedPending(db: HorizonDb, embedder: Embedder, opts: { app?: string; log?: (line: string) => void; signal?: AbortSignal } = {}): Promise<{ embedded: number; failed: number }> {
  backfillTextSha(db);
  const pick = db.raw.prepare(
    `SELECT c.id, c.text, c.text_sha FROM source_chunks c JOIN context_sources s ON s.id = c.source_id
     LEFT JOIN chunk_embeddings e ON e.chunk_id = c.id AND e.model = ?
     WHERE c.retired_at IS NULL AND (e.chunk_id IS NULL OR e.text_sha != c.text_sha) ${opts.app ? 'AND s.application_id = ?' : ''} ORDER BY c.rowid LIMIT ?`,
  );
  const current = db.raw.prepare('SELECT text_sha FROM source_chunks WHERE id = ?');
  const upsert = db.raw.prepare('INSERT OR REPLACE INTO chunk_embeddings (chunk_id, model, dims, vector, text_sha, created_at) VALUES (?, ?, ?, ?, ?, ?)');
  // Writes only the vectors whose passage still has the text they were computed from; returns how many were written.
  const store = db.raw.transaction((rows: { id: string; text_sha: string }[], vectors: Float32Array[], at: string) => {
    let written = 0;
    rows.forEach((r, i) => {
      const now = current.get(r.id) as { text_sha: string } | undefined;
      if (!now || now.text_sha !== r.text_sha || vectors[i].length === 0) return;
      upsert.run(r.id, embedder.id, vectors[i].length, toBlob(vectors[i]), r.text_sha, at);
      written++;
    });
    return written;
  });
  let embedded = 0;
  let failed = 0;
  let idlePasses = 0;
  const t0 = Date.now();
  for (;;) {
    if (opts.signal?.aborted) break;
    const args: unknown[] = [embedder.id];
    if (opts.app) args.push(opts.app);
    args.push(BATCH);
    const rows = pick.all(...args) as { id: string; text: string; text_sha: string }[];
    if (rows.length === 0) break;
    let vectors: Float32Array[];
    try {
      vectors = await embedder.embed(rows.map((r) => r.text));
    } catch (e) {
      failed += rows.length;
      opts.log?.(`[retrieval] embedding stopped: ${(e as Error).message}`);
      break;
    }
    const written = store(rows, vectors, new Date().toISOString());
    embedded += written;
    // Nothing written twice in a row (passages keep changing under us): stop; the next schedule() continues.
    idlePasses = written ? 0 : idlePasses + 1;
    if (idlePasses >= 3) break;
  }
  if (embedded) opts.log?.(`[retrieval] embedded ${embedded} passage${embedded === 1 ? '' : 's'} with ${embedder.id} in ${Date.now() - t0} ms`);
  return { embedded, failed };
}

export interface RetrievalStatus {
  mode: RetrievalMode;
  embedder: string | null;
  reranker: string | null;
  /** off: keyword only by configuration. failed: a model could not load; keyword only. */
  state: 'off' | 'loading' | 'indexing' | 'ready' | 'failed';
  embedded: number;
  pending: number;
  error: string | null;
}

/**
 * Owns the models and the background embedding job for one server. `schedule()` coalesces: one
 * run at a time, and a call during a run queues exactly one more.
 */
export class RetrievalService {
  private running: Promise<void> | null = null;
  private again = false;
  private lastError: string | null = null;

  constructor(
    readonly models: RetrievalModels,
    private readonly getDb: () => HorizonDb,
    private readonly log: (line: string) => void = () => {},
  ) {}

  /** Embeds whatever is pending, in the background. Resolves when this and any queued run finished. */
  schedule(): Promise<void> {
    if (!this.models.embedder) return Promise.resolve();
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      do {
        this.again = false;
        try {
          const r = await embedPending(this.getDb(), this.models.embedder!, { log: this.log });
          this.lastError = r.failed ? 'The embedding model could not run; retrieval is keyword-only until it does.' : null;
        } catch (e) {
          this.lastError = (e as Error).message;
          this.log(`[retrieval] embedding job failed: ${this.lastError}`);
        }
      } while (this.again);
      this.running = null;
    })();
    return this.running;
  }

  /** For tests and shutdown: resolves when no job is running. */
  whenIdle(): Promise<void> {
    return this.running ?? Promise.resolve();
  }

  status(db: HorizonDb, app?: string): RetrievalStatus {
    const e = this.models.embedder;
    const counts = embeddingCounts(db, e?.id ?? null, app);
    const loader = (this.models as { status?: () => { embedder: string; reranker: string; error: string | null } }).status?.();
    let state: RetrievalStatus['state'];
    if (!e) state = 'off';
    else if (loader?.embedder === 'failed' || loader?.reranker === 'failed') state = 'failed';
    else if (this.running) state = loader?.embedder === 'loading' ? 'loading' : 'indexing';
    else state = counts.embedded > 0 || counts.pending === 0 ? 'ready' : this.lastError ? 'failed' : 'ready';
    return {
      mode: e && counts.embedded > 0 && state !== 'failed' ? 'hybrid' : 'keyword',
      embedder: e?.id ?? null,
      reranker: this.models.reranker?.id ?? null,
      state,
      embedded: counts.embedded,
      pending: counts.pending,
      error: loader?.error ?? this.lastError,
    };
  }
}
