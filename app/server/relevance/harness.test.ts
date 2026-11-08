/**
 * Guards the retrieval evaluation (scripts/retrieval-eval.ts): the fixture and its labels are sound,
 * the scoring is right, and with the deterministic fake models retrieval keeps a basic quality floor
 * and the bounded candidates (FTS5 plus nearest vectors) lose nothing the unbounded ranking finds.
 * The real-model numbers come from the script, not from here.
 */
import { describe, expect, it } from 'vitest';

import { fakeModels, NO_MODELS, rank, RERANK_CANDIDATES, type Candidate, type RetrievalModels } from '../retrieval';
import { buildDb, compareRuns, embedAll, fixtureCorpus, retrieveBounded, runAll, score, scoreByKind, sharedWords, unboundedRetriever } from './harness';
import { QUESTIONS } from './questions';

describe('retrieval evaluation fixture', () => {
  const corpus = fixtureCorpus();
  const byId = new Map(corpus.map((p) => [p.id, p]));

  it('has a few hundred passages with unique ids and 40 to 60 questions of every kind', () => {
    expect(corpus.length).toBeGreaterThanOrEqual(250);
    expect(corpus.length).toBeLessThanOrEqual(400);
    expect(byId.size).toBe(corpus.length);
    expect(QUESTIONS.length).toBeGreaterThanOrEqual(40);
    expect(QUESTIONS.length).toBeLessThanOrEqual(60);
    expect(new Set(QUESTIONS.map((q) => q.id)).size).toBe(QUESTIONS.length);
    const n = (k: string) => QUESTIONS.filter((q) => q.kind === k).length;
    expect(n('paraphrase')).toBeGreaterThanOrEqual(15);
    expect(n('exact')).toBeGreaterThanOrEqual(10);
    expect(n('mixed')).toBeGreaterThanOrEqual(5);
    expect(n('none')).toBeGreaterThanOrEqual(8);
  });

  it('labels only passages that exist; unanswerable questions have none, answerable ones some', () => {
    for (const q of QUESTIONS) {
      for (const id of q.relevant) expect(byId.has(id), `${q.id}: ${id}`).toBe(true);
      expect(q.relevant.length > 0, q.id).toBe(q.kind !== 'none');
    }
  });

  it('paraphrase questions share no keyword with any passage they are labelled to find', () => {
    for (const q of QUESTIONS.filter((x) => x.kind === 'paraphrase')) {
      for (const id of q.relevant) expect(sharedWords(q.q, byId.get(id)!), `${q.id} vs ${id}`).toEqual([]);
    }
  });

  it('exact-term questions do share keywords with their answers', () => {
    for (const q of QUESTIONS.filter((x) => x.kind === 'exact')) {
      expect(q.relevant.some((id) => sharedWords(q.q, byId.get(id)!).length > 0), q.id).toBe(true);
    }
  });
});

describe('retrieval evaluation scoring', () => {
  const qs = [
    { id: 'a', q: '', kind: 'exact' as const, relevant: ['x', 'y'] },
    { id: 'b', q: '', kind: 'paraphrase' as const, relevant: ['z'] },
    { id: 'c', q: '', kind: 'none' as const, relevant: [] },
    { id: 'd', q: '', kind: 'none' as const, relevant: [] },
  ];

  it('computes recall@4, MRR, the no-answer false-positive rate and off-target share', () => {
    const results = new Map([
      ['a', ['w', 'x']], // one of two relevant, first at rank 2
      ['b', []], // nothing
      ['c', ['q']], // false positive
      ['d', []], // correct silence
    ]);
    expect(score(qs, results)).toEqual({ recallAt4: 0.25, hitAt4: 0.5, mrr: 0.25, noAnswerFalsePositive: 0.5, offTarget: 0.5, answerable: 2, noAnswer: 2 });
    const byKind = scoreByKind(qs, results);
    expect(byKind.exact.recallAt4).toBe(0.5);
    expect(byKind.paraphrase.recallAt4).toBe(0);
    expect(byKind.none.noAnswerFalsePositive).toBe(0.5);
  });

  it('counts only the top four and caps recall at four relevant passages', () => {
    const many = [{ id: 'm', q: '', kind: 'mixed' as const, relevant: ['1', '2', '3', '4', '5', '6'] }];
    expect(score(many, new Map([['m', ['1', '2', '3', '4', '5']]])).recallAt4).toBe(1);
    expect(score(many, new Map([['m', ['n', 'n', 'n', 'n', '1']]])).mrr).toBe(0);
  });

  it('reports relevant passages one run found and the other lost', () => {
    const a = new Map([['a', ['w']], ['b', ['z']]]);
    const b = new Map([['a', ['x', 'w']], ['b', ['z']]]);
    expect(compareRuns(qs, a, b)).toEqual({ differ: 1, lost: [{ question: 'a', passage: 'x' }] });
  });
});

describe('retrieval quality floor with the fake models', () => {
  // A small synonym table for the fake embedder and reranker, so some paraphrase questions can be found by "meaning".
  const synonyms = { money: 'refund', back: 'refund', pager: 'page', respond: 'acknowledge', helpdesk: 'support', staff: 'agents', alter: 'change', colour: 'contrast', letters: 'text', mouse: 'keyboard', handsets: 'device' };
  const corpus = fixtureCorpus();

  async function evaluate(models: RetrievalModels) {
    const db = buildDb(corpus);
    await embedAll(db, models);
    const bounded = await runAll(QUESTIONS, (q) => retrieveBounded(db, models, q));
    const unbounded = await runAll(QUESTIONS, unboundedRetriever(db, models));
    db.raw.close();
    return { bounded, unbounded };
  }

  it('keyword mode finds exact-term and ordinary questions and nothing by meaning alone', async () => {
    const { bounded, unbounded } = await evaluate(NO_MODELS);
    const m = scoreByKind(QUESTIONS, bounded);
    expect(m.exact.recallAt4).toBeGreaterThanOrEqual(0.9);
    expect(m.mixed.recallAt4).toBeGreaterThanOrEqual(0.9);
    // Honest: keyword overlap cannot find a passage that shares no word with the question.
    expect(m.paraphrase.hitAt4).toBe(0);
    expect(compareRuns(QUESTIONS, bounded, unbounded).lost).toEqual([]);
  });

  it('hybrid with the fake models finds paraphrases keywords miss, and the candidate bound loses no relevant passage', async () => {
    const models = fakeModels(synonyms);
    const { bounded, unbounded } = await evaluate(models);
    const m = scoreByKind(QUESTIONS, bounded);
    // Floors a little under what the fakes measure (paraphrase hit 0.1, exact recall 0.81, mixed 0.9); the
    // fake reranker is not calibrated, so no-answer precision is judged with the real models only.
    expect(m.paraphrase.hitAt4).toBeGreaterThanOrEqual(0.1);
    expect(m.exact.recallAt4).toBeGreaterThanOrEqual(0.75);
    expect(m.mixed.recallAt4).toBeGreaterThanOrEqual(0.85);
    expect(compareRuns(QUESTIONS, bounded, unbounded).lost).toEqual([]);
    expect(models.calls.rerank).toBeGreaterThan(0);
  });
});

describe('reranker reads the nearest passages by meaning', () => {
  const unit = (...xs: number[]) => {
    const v = Float32Array.from(xs);
    const n = Math.hypot(...xs) || 1;
    return v.map((x) => x / n);
  };

  it('a passage found only by its vector reaches the cross-encoder even when keyword matches fill the fused top', async () => {
    // Many passages share a word with the question and sit close-ish by vector, so each has two ranks in
    // the fusion; the answer shares no word and has only its (best) vector rank.
    const cands: Candidate[] = Array.from({ length: RERANK_CANDIDATES + 10 }, (_, i) => ({ key: `kw${i}`, where: `notes · ${i}`, text: `refund window note ${i}`, vector: unit(0.5, 0.5 + i * 0.01, 0.3) }));
    cands.push({ key: 'answer', where: 'policy · 1', text: 'Money goes back to the buyer within six weeks.', vector: unit(1, 0.05, 0) });
    const models: RetrievalModels = {
      embedder: { id: 'stub', dims: 3, embed: async () => [unit(1, 0, 0)] },
      reranker: { id: 'stub', score: async (_q, ps) => ps.map((p) => (p.includes('Money goes back') ? 3 : -11)) },
    };
    const r = await rank(models, 'What is the refund window?', cands, { limit: 4, minRelevance: 0.2 });
    expect(r.ranked[0].item.key).toBe('answer');
    expect(r.ranked[0].rerank).toBe(3);
  });
});
