/**
 * The retrieval evaluation harness: builds a disposable database from the fixture corpus (or any
 * passage list), runs labelled questions through the real retrieval path, and scores the answers.
 * Used by scripts/retrieval-eval.ts with the real local models and by harness.test.ts with the
 * deterministic fake ones. Nothing here touches the live database or the workspace.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { retrieveContext } from '../context';
import { openDb, seedWorkspace, type HorizonDb } from '../db';
import { FIXTURE } from '../fixture';
import { embedPending, fromBlob, rank, textSha, words, type Candidate, type RetrievalModels } from '../retrieval';
import type { LabelledQuestion, QuestionKind } from './questions';
import { TEAM_DOCS } from './team-docs';

export const EVAL_APP = 'ABCD';
/** The bar and the count retrieveContext applies by default (context.ts MIN_RELEVANCE and limit). */
export const MIN_RELEVANCE = 0.2;
export const TOP_K = 4;

export interface CorpusPassage {
  id: string;
  /** Source grouping: one App Context source per team document or per open-source repository. */
  source: string;
  sourceTitle: string;
  sourceType: 'Text' | 'Repository';
  locator: string;
  text: string;
}

interface Excerpts {
  passages: { id: string; source: string; locator: string; text: string }[];
}

/** The committed corpus: the team documents and the open-source excerpts. */
export function fixtureCorpus(): CorpusPassage[] {
  const out: CorpusPassage[] = [];
  for (const d of TEAM_DOCS) {
    d.passages.forEach((text, i) => out.push({ id: `team:${d.file} ¶${i + 1}`, source: `team-${d.file}`, sourceTitle: d.title, sourceType: 'Text', locator: `${d.file} ¶${i + 1}`, text }));
  }
  const ex = JSON.parse(readFileSync(fileURLToPath(new URL('./excerpts.json', import.meta.url)), 'utf8')) as Excerpts;
  for (const p of ex.passages) out.push({ id: p.id, source: `repo-${p.source}`, sourceTitle: p.source, sourceType: 'Repository', locator: p.locator, text: p.text });
  return out;
}

/** What keyword matching sees of a passage (title, locator and text), as context.ts builds it. */
export const passageWhere = (p: CorpusPassage) => `${p.sourceTitle} · ${p.locator}`;

/** Keywords a question shares with a passage, after the stop list and stemming retrieval applies. */
export function sharedWords(q: string, p: CorpusPassage): string[] {
  const pw = new Set(words(`${passageWhere(p)} ${p.text}`));
  return [...new Set(words(q))].filter((w) => pw.has(w));
}

/** A database with the fixture workspace and one App Context source per corpus source, all usable. */
export function buildDb(passages: CorpusPassage[], path = ':memory:'): HorizonDb {
  const db = openDb(path);
  seedWorkspace(db, FIXTURE);
  const at = new Date().toISOString();
  const src = db.raw.prepare("INSERT OR IGNORE INTO context_sources (id, application_id, scope_type, type, title, trust, status, created_at, updated_at) VALUES (?, ?, 'app', ?, ?, ?, 'indexed', ?, ?)");
  const chunk = db.raw.prepare('INSERT INTO source_chunks (id, source_id, locator, text, seq, source_version, chars, text_sha) VALUES (?, ?, ?, ?, ?, 1, ?, ?)');
  const seq = new Map<string, number>();
  db.raw.transaction(() => {
    for (const p of passages) {
      const sid = `eval-${p.source}`;
      src.run(sid, EVAL_APP, p.sourceType, p.sourceTitle, p.sourceType === 'Repository' ? 'Code' : 'Team upload', at, at);
      const n = (seq.get(sid) ?? 0) + 1;
      seq.set(sid, n);
      chunk.run(p.id, sid, p.locator, p.text, n, p.text.length, textSha(p.text));
    }
  })();
  return db;
}

/** Embeds every passage with the given models' embedder (no-op without one). */
export async function embedAll(db: HorizonDb, models: RetrievalModels) {
  if (!models.embedder) return { embedded: 0, failed: 0 };
  return embedPending(db, models.embedder);
}

/** Retrieval exactly as an answer gets it: bounded candidates (FTS5 plus nearest vectors), then ranking. */
export async function retrieveBounded(db: HorizonDb, models: RetrievalModels, q: string): Promise<string[]> {
  const r = await retrieveContext(db, EVAL_APP, q, { models, limit: TOP_K, minRelevance: MIN_RELEVANCE });
  return r.passages.map((p) => p.chunkId);
}

/**
 * The same ranking over every passage of the application, with no candidate bound: what retrieval
 * would return if the FTS5 prefilter and the vector top-k dropped nothing.
 */
export function unboundedRetriever(db: HorizonDb, models: RetrievalModels) {
  const rows = db.raw
    .prepare(
      `SELECT c.id, c.locator, c.text, s.title, e.vector FROM source_chunks c JOIN context_sources s ON s.id = c.source_id
       LEFT JOIN chunk_embeddings e ON e.chunk_id = c.id AND e.model = ? AND e.text_sha = c.text_sha
       WHERE s.application_id = ? AND c.retired_at IS NULL`,
    )
    .all(models.embedder?.id ?? '', EVAL_APP) as { id: string; locator: string; text: string; title: string; vector: Buffer | null }[];
  const cands: Candidate[] = rows.map((r) => ({ key: r.id, where: `${r.title} · ${r.locator}`, text: r.text, vector: r.vector ? fromBlob(r.vector) : null }));
  return async (q: string): Promise<string[]> => {
    const r = await rank(models, q, cands, { limit: TOP_K, minRelevance: MIN_RELEVANCE });
    return r.ranked.map((x) => x.item.key);
  };
}

/* ---------- Scoring ---------- */

export interface Metrics {
  /** Answerable questions: share of their relevant passages in the top four (capped at four). */
  recallAt4: number;
  /** Answerable questions: at least one relevant passage in the top four. */
  hitAt4: number;
  /** Answerable questions: mean reciprocal rank of the first relevant passage (0 when none). */
  mrr: number;
  /** No-answer questions: share that returned any passage at all. */
  noAnswerFalsePositive: number;
  /** Answerable questions: share of returned passages that are not labelled relevant. */
  offTarget: number;
  answerable: number;
  noAnswer: number;
}

export function score(questions: LabelledQuestion[], results: Map<string, string[]>): Metrics {
  let recall = 0;
  let hit = 0;
  let rr = 0;
  let fp = 0;
  let returned = 0;
  let wrong = 0;
  let answerable = 0;
  let noAnswer = 0;
  for (const q of questions) {
    const got = (results.get(q.id) ?? []).slice(0, TOP_K);
    if (q.relevant.length === 0) {
      noAnswer++;
      if (got.length > 0) fp++;
      continue;
    }
    answerable++;
    const rel = new Set(q.relevant);
    const found = got.filter((id) => rel.has(id)).length;
    recall += found / Math.min(rel.size, TOP_K);
    if (found > 0) hit++;
    const first = got.findIndex((id) => rel.has(id));
    rr += first >= 0 ? 1 / (first + 1) : 0;
    returned += got.length;
    wrong += got.length - found;
  }
  const r3 = (x: number) => Math.round(x * 1000) / 1000;
  return {
    recallAt4: r3(answerable ? recall / answerable : 0),
    hitAt4: r3(answerable ? hit / answerable : 0),
    mrr: r3(answerable ? rr / answerable : 0),
    noAnswerFalsePositive: r3(noAnswer ? fp / noAnswer : 0),
    offTarget: r3(returned ? wrong / returned : 0),
    answerable,
    noAnswer,
  };
}

/** Scores per question kind as well as overall. */
export function scoreByKind(questions: LabelledQuestion[], results: Map<string, string[]>): Record<'all' | QuestionKind, Metrics> {
  const kinds: QuestionKind[] = ['paraphrase', 'exact', 'mixed', 'none'];
  const out = { all: score(questions, results) } as Record<'all' | QuestionKind, Metrics>;
  for (const k of kinds) out[k] = score(questions.filter((q) => q.kind === k), results);
  return out;
}

/** Runs every question through a retriever and collects the passage ids it returned. */
export async function runAll(questions: LabelledQuestion[], retrieve: (q: string) => Promise<string[]>): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  for (const q of questions) out.set(q.id, await retrieve(q.q));
  return out;
}

/** Questions whose top four differ between two runs, and relevant passages one found and the other lost. */
export function compareRuns(questions: LabelledQuestion[], a: Map<string, string[]>, b: Map<string, string[]>) {
  let differ = 0;
  const lost: { question: string; passage: string }[] = [];
  for (const q of questions) {
    const x = a.get(q.id) ?? [];
    const y = b.get(q.id) ?? [];
    if (x.join('\n') !== y.join('\n')) differ++;
    for (const id of q.relevant) if (y.includes(id) && !x.includes(id)) lost.push({ question: q.id, passage: id });
  }
  return { differ, lost };
}
