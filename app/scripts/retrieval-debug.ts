/**
 * Shows how App Context ranks passages for a question: keyword score, cosine, reranker logit and the
 * relevance the answer sees. Read-only; uses the live database and the cached models.
 *
 *   cd app && ./node_modules/.bin/vite-node scripts/retrieval-debug.ts <APP> "<question>"
 */
import { openDb } from '../server/db';
import { keywordScore, modelsFromEnv, words, rank, type Candidate } from '../server/retrieval';

const [app, question] = process.argv.slice(2);
if (!app || !question) {
  console.error('usage: retrieval-debug.ts <APP> "<question>"');
  process.exit(2);
}
const db = openDb(process.env.HORIZON_DB_PATH || 'data/horizon.db');
const models = modelsFromEnv(process.env as Record<string, string | undefined>);
const rows = db.raw
  .prepare(
    `SELECT c.id, c.locator, c.text, s.title, e.vector FROM source_chunks c JOIN context_sources s ON s.id = c.source_id
     LEFT JOIN chunk_embeddings e ON e.chunk_id = c.id AND e.model = ? WHERE s.application_id = ? AND c.excluded_reason IS NULL`,
  )
  .all(models.embedder?.id ?? '', app) as { id: string; locator: string; text: string; title: string; vector: Buffer | null }[];
const cands: Candidate[] = rows.map((r) => ({ key: r.id, where: `${r.title} · ${r.locator}`, text: r.text, vector: r.vector ? new Float32Array(r.vector.buffer.slice(r.vector.byteOffset, r.vector.byteOffset + r.vector.byteLength)) : null }));
const qw = new Set(words(question));
console.log(`${cands.length} passages, ${cands.filter((c) => c.vector).length} embedded; question words: ${[...qw].join(' ')}`);
const r = await rank(models, question, cands, { limit: 20, minRelevance: 0 });
console.log(`mode ${r.mode}, reranked ${r.reranked}`);
for (const x of r.ranked) console.log(`${x.relevance.toFixed(3)} kw ${x.keyword.toFixed(2)} cos ${x.vector?.toFixed(2) ?? ' -  '} rr ${x.rerank?.toFixed(2) ?? '  -  '} | ${x.item.where} | ${x.item.text.slice(0, 100).replace(/\s+/g, ' ')}`);
// Keyword-only view, for comparison.
const kw = cands.map((c) => ({ c, s: keywordScore(qw, c) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s).slice(0, 5);
console.log('\nkeyword top 5:');
for (const x of kw) console.log(`${x.s.toFixed(2)} | ${x.c.where} | ${x.c.text.slice(0, 100).replace(/\s+/g, ' ')}`);
db.raw.close();
