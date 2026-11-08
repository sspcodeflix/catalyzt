/**
 * The ranking rules of hybrid retrieval, with stub models so the numbers are exact.
 */
import { describe, expect, it } from 'vitest';

import { cosine, fromBlob, keywordScore, rank, rerankRelevance, toBlob, TOPICAL_WEIGHT, words, type Candidate, type RetrievalModels } from './retrieval';

const unit = (...xs: number[]) => {
  const v = Float32Array.from(xs);
  const n = Math.hypot(...xs) || 1;
  return v.map((x) => x / n);
};

const cand = (key: string, text: string, vector?: Float32Array | null): Candidate => ({ key, where: `doc · ${key}`, text, vector });

/** An embedder that answers a fixed vector for the question, and a reranker scripted per passage key. */
const stub = (q: Float32Array, logits: Record<string, number>): RetrievalModels => ({
  embedder: { id: 'stub', dims: 3, embed: async () => [q] },
  reranker: { id: 'stub-rr', score: async (_query, passages) => passages.map((p) => logits[p.split('\n')[0].replace('doc · ', '')] ?? -12) },
});

describe('ranking', () => {
  it('keyword score needs the question’s words; stop words alone match nothing', () => {
    const qw = new Set(words('What is the refund window?'));
    expect([...qw]).toEqual(['refund', 'window']);
    expect(keywordScore(qw, cand('a', 'The refund window is 45 days.'))).toBeGreaterThan(0.7);
    expect(keywordScore(qw, cand('b', 'Restart the pod when it is unhealthy.'))).toBe(0);
    expect(words('the and is')).toEqual([]);
  });

  it('vectors round-trip through BLOBs and cosine is a dot product of unit vectors', () => {
    const v = unit(1, 2, 3);
    expect(cosine(fromBlob(toBlob(v)), v)).toBeCloseTo(1, 5);
    expect(cosine(unit(1, 0, 0), unit(0, 1, 0))).toBeCloseTo(0, 5);
  });

  it('maps reranker logits onto 0 to 1 with the bar at -7', () => {
    expect(rerankRelevance(1)).toBe(1);
    expect(rerankRelevance(-4)).toBeCloseTo(0.5);
    expect(rerankRelevance(-7)).toBeCloseTo(0.2);
    expect(rerankRelevance(-12)).toBe(0);
  });

  it('is keyword-only without an embedder or without any embedded candidate, and says so', async () => {
    const cands = [cand('a', 'The refund window is 45 days.', null), cand('b', 'Pods restart on failure.', null)];
    const none = await rank({ embedder: null, reranker: null }, 'refund window', cands, { limit: 4, minRelevance: 0.2 });
    expect(none).toMatchObject({ mode: 'keyword', reranked: false, embedded: 0, total: 2 });
    expect(none.ranked.map((r) => r.item.key)).toEqual(['a']);
    const unembedded = await rank(stub(unit(1, 0, 0), {}), 'refund window', cands, { limit: 4, minRelevance: 0.2 });
    expect(unembedded.mode).toBe('keyword');
  });

  it('fuses keyword and vector ranks, reranks the top, and keeps a passage the reranker rejects only when words and meaning both agree', async () => {
    const q = unit(1, 0, 0);
    const cands = [
      // Answers the question outright: the reranker says so.
      cand('answer', 'Refunds are allowed for 45 days from settlement.', unit(0.9, 0.1, 0)),
      // About the subject (refund window words, similar vector) but does not answer: kept as topical context.
      cand('topical', 'The refund window and the statistics service are described in the design notes.', unit(0.8, 0.2, 0)),
      // Shares one word but means something else: dropped.
      cand('noise', 'The window manager restarts.', unit(0, 1, 0)),
      // Found by meaning alone, no shared word, and the reranker likes it.
      cand('meaning', 'Money goes back to the buyer within six weeks of the sale.', unit(0.85, 0, 0.1)),
      // Never embedded (a Jira row): only keywords and the reranker see it.
      cand('jira', 'ABCD-1001 refund window story', undefined),
    ];
    const r = await rank(stub(q, { answer: 2, topical: -10, noise: -11, meaning: -3, jira: -11 }), 'What is the refund window?', cands, { limit: 5, minRelevance: 0.2 });
    expect(r).toMatchObject({ mode: 'hybrid', reranked: true, embedded: 4, total: 4 });
    const by = Object.fromEntries(r.ranked.map((x) => [x.item.key, x]));
    expect(r.ranked[0].item.key).toBe('answer');
    expect(by.meaning.relevance).toBeCloseTo(0.6, 2);
    expect(by.topical).toBeDefined();
    expect(by.topical.rerank).toBe(-10);
    expect(by.topical.relevance).toBeGreaterThanOrEqual(0.2);
    expect(by.noise).toBeUndefined();
    // The Jira row has no vector: it scores by words alone (TOPICAL_WEIGHT × keyword) when the reranker rejects it.
    expect(by.jira.vector).toBeNull();
    expect(by.jira.relevance).toBeCloseTo(TOPICAL_WEIGHT * keywordScore(new Set(words('What is the refund window?')), cands[4]), 2);
  });

  it('falls back to keyword ranking when the embedder fails and to fused scores when the reranker fails', async () => {
    const cands = [cand('a', 'The refund window is 45 days.', unit(1, 0, 0)), cand('b', 'Pods restart on failure.', unit(0, 1, 0))];
    const broken: RetrievalModels = { embedder: { id: 'x', dims: 3, embed: async () => { throw new Error('no model'); } }, reranker: null };
    const r = await rank(broken, 'refund window', cands, { limit: 4, minRelevance: 0.2 });
    expect(r.mode).toBe('keyword');
    expect(r.ranked.map((x) => x.item.key)).toEqual(['a']);
    const noRerank: RetrievalModels = { embedder: { id: 'x', dims: 3, embed: async () => [unit(1, 0, 0)] }, reranker: { id: 'rr', score: async () => { throw new Error('down'); } } };
    const r2 = await rank(noRerank, 'refund window', cands, { limit: 4, minRelevance: 0.2 });
    expect(r2).toMatchObject({ mode: 'hybrid', reranked: false });
    expect(r2.ranked[0].item.key).toBe('a');
  });
});
