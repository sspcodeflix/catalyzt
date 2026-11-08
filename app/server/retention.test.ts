/**
 * Retention on a fixture database: dry run changes nothing; apply removes only what nothing
 * references (old model-call detail folded into daily totals, unprotected old runs, uncited retired
 * passage versions, vectors of other models, old orphan files) and never an answer, citation,
 * artifact, approval, Huddle item or audit row.
 */
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { chunkHref, ensureFts, listChunks, listSources, syncSource } from './context';
import type { HorizonDb } from './db';
import { fixtureWithDocs, REFUNDS_DOC, seedRefundTests } from './fixture';
import { policyFromEnv, runRetention, type RetentionPolicy } from './retention';
import { toBlob } from './retrieval';

const DAY = 86_400_000;
const NOW = Date.now();
const ago = (days: number) => new Date(NOW - days * DAY).toISOString();
const count = (db: HorizonDb, t: string, where = '') => (db.raw.prepare(`SELECT COUNT(*) AS n FROM ${t} ${where}`).get() as { n: number }).n;
const KEPT_TABLES = ['answer_revisions', 'citations', 'artifacts', 'approvals', 'ratings', 'huddle_items', 'audit_log', 'messages', 'chats', 'attachments'];

function fixture() {
  const { db, cloneDir } = fixtureWithDocs();
  const tests = seedRefundTests(db);
  const repo = listSources(db, 'ABCD').find((s) => s.type === 'Repository')!;

  // Passages: version 1 (cited by an answer), version 2 (nobody cites it), version 3 current.
  const v1 = listChunks(db, 'ABCD', repo.id)[0];
  writeFileSync(join(cloneDir, 'docs', 'refunds.md'), `${REFUNDS_DOC}\n\nVersion two of the refund notes.`);
  syncSource(db, 'ABCD', repo.id);
  writeFileSync(join(cloneDir, 'docs', 'refunds.md'), `${REFUNDS_DOC}\n\nVersion three of the refund notes.`);
  syncSource(db, 'ABCD', repo.id);

  // An answer that cites the version-1 passage.
  db.upsertChat({ id: 'chat-1', title: 'Refunds', agent: 'auto', workspace: 'payments', userId: 'u-sourav' }, 'ABCD');
  db.addUserMessage({ id: 'msg-1', chatId: 'chat-1', text: 'Refund window?', testType: null, testTypeSource: null, userId: 'u-sourav', items: [] });
  db.saveAnswer({ app: 'ABCD', chatId: 'chat-1', answerId: 'ans-1', userMessageId: 'msg-1', workflowRunId: null, userId: 'u-sourav', status: 'done', intent: undefined, blocks: [{ kind: 'prose', text: 'Forty-five days [1].' }], citations: [{ n: 1, title: 'refunds', detail: 'v1', href: chunkHref(repo.id, v1.seq, 1) }], artifact: null });

  // Runs: the seed run is the target build. Old runs: one plain, one the only run of its workflow, one an audit note names.
  const run = (workflow: string, days: number, sha: string) =>
    db.ingestRun({ app: 'ABCD', source: 'webhook', repo: 'acme/shop', workflow, externalRunId: `${workflow}-${days}`, attempt: 1, runUrl: null, event: 'push', branch: 'main', sha, prNumber: null, isMerge: false, startedAt: ago(days) }, [{ testCaseId: tests[0], status: 'failed', durationMs: 5, message: 'expected 45 got 60' }], 'u-sourav').runId;
  const oldPlain = run('CI', 400, 'aaa1111');
  run('CI', 300, 'aaa2222');
  const onlyNightly = run('nightly', 500, 'bbb1111');
  const noted = run('CI', 450, 'ccc1111');
  db.audit('user', 'u-ram', 'note', 'test_run', noted, { why: 'kept for the incident review' });
  // A fresh, unprotected run stays (younger than the limit).
  const fresh = run('CI', 10, 'ddd1111');

  // Model calls: two old, one recent.
  db.startWorkflow({ id: 'wf-calls', app: 'ABCD', chatId: null, messageId: null, revision: 1, userId: 'u-sourav' });
  for (const [prompt, completion] of [[100, 20], [50, null], [10, 5]] as const)
    db.recordModelCall({ workflowRunId: 'wf-calls', agentRunId: null, agent: 'Router', userId: 'u-sourav', model: 'deepseek-chat', purpose: 'intent', status: 'ok', promptTokens: prompt, completionTokens: completion, latencyMs: 30 });
  const callIds = (db.raw.prepare('SELECT id FROM model_calls ORDER BY id').all() as { id: number }[]).map((r) => r.id);
  db.raw.prepare('UPDATE model_calls SET created_at = ? WHERE id IN (?, ?)').run(ago(200), callIds[0], callIds[1]);

  // Vectors: the configured model and an old one on current passages.
  const current = listChunks(db, 'ABCD', repo.id);
  const vec = toBlob(new Float32Array([1, 0, 0, 0]));
  const sha = (id: string) => (db.raw.prepare('SELECT text_sha FROM source_chunks WHERE id = ?').get(id) as { text_sha: string }).text_sha;
  for (const c of current) for (const model of ['fake-embedder', 'old-model']) db.raw.prepare('INSERT INTO chunk_embeddings (chunk_id, model, dims, vector, text_sha, created_at) VALUES (?, ?, 4, ?, ?, ?)').run(c.id, model, vec, sha(c.id), ago(1));

  // Files: one an attachment refers to, an old orphan, and a new one (an upload in progress).
  const files = mkdtempSync(join(tmpdir(), 'catalyzt-retention-'));
  mkdirSync(join(files, 'ABCD'), { recursive: true });
  writeFileSync(join(files, 'ABCD', 'att-kept'), 'kept');
  writeFileSync(join(files, 'ABCD', 'att-orphan'), 'orphan bytes');
  writeFileSync(join(files, 'ABCD', 'att-new'), 'arriving');
  utimesSync(join(files, 'ABCD', 'att-kept'), new Date(NOW - 10 * DAY), new Date(NOW - 10 * DAY));
  utimesSync(join(files, 'ABCD', 'att-orphan'), new Date(NOW - 10 * DAY), new Date(NOW - 10 * DAY));
  db.addAttachment({ id: 'att-kept', app: 'ABCD', chatId: 'chat-1', filename: 'kept.txt', mime: 'text/plain', size: 4, sha256: 'x', storageKey: 'ABCD/att-kept', status: 'stored', note: null, text: null, userId: 'u-sourav' });

  const policy: RetentionPolicy = { modelCallDays: 90, runDays: 180, retiredPassages: true, keepModels: ['fake-embedder'], filesDir: files, fileGraceHours: 24 };
  return { db, repo, files, policy, runs: { oldPlain, onlyNightly, noted, fresh }, current };
}

describe('retention', () => {
  it('a dry run reports counts and bytes and changes nothing', () => {
    const { db, policy } = fixture();
    const tables = ['model_calls', 'test_runs', 'test_results', 'source_chunks', 'chunk_embeddings', ...KEPT_TABLES];
    const before = tables.map((t) => count(db, t));
    const r = runRetention(db, policy, { now: NOW });
    expect(r.applied).toBe(false);
    expect(r.modelCalls.rows).toBe(2);
    expect(r.testRuns.rows).toBe(2);
    expect(r.testRuns.results).toBe(2);
    expect(r.testRuns.kept).toMatchObject({ latestOfWorkflow: 1, referenced: 1 });
    expect(r.retiredPassages.rows).toBeGreaterThan(0);
    expect(r.retiredPassages.kept?.cited).toBeGreaterThan(0);
    expect(r.staleVectors).toMatchObject({ models: ['old-model'] });
    expect(r.orphanFiles.files).toEqual(['ABCD/att-orphan']);
    expect(r.orphanFiles.bytes).toBe('orphan bytes'.length);
    for (const c of [r.modelCalls, r.testRuns, r.retiredPassages, r.staleVectors]) expect(c.bytes).toBeGreaterThan(0);
    expect(r.modelCalls.byApp.ABCD.rows).toBe(2);
    expect(tables.map((t) => count(db, t))).toEqual(before);
  });

  it('apply removes only unreferenced rows and files, keeps usage totals and every referenced record', () => {
    const { db, repo, files, policy, runs, current } = fixture();
    const usage = db.usage('ABCD') as { allTime: Record<string, number>; byAgent: unknown[] };
    const kept = KEPT_TABLES.map((t) => count(db, t));
    const planned = runRetention(db, policy, { now: NOW });
    const r = runRetention(db, policy, { now: NOW, apply: true });
    expect(r.applied).toBe(true);
    expect([r.modelCalls.rows, r.testRuns.rows, r.retiredPassages.rows, r.staleVectors.rows, r.orphanFiles.rows]).toEqual([planned.modelCalls.rows, planned.testRuns.rows, planned.retiredPassages.rows, planned.staleVectors.rows, planned.orphanFiles.rows]);

    // Model calls: detail is gone, totals are the same (folded into daily rows).
    expect(count(db, 'model_calls')).toBe(1);
    expect(count(db, 'model_call_daily')).toBe(1);
    const after = db.usage('ABCD') as typeof usage;
    expect(after.allTime).toEqual(usage.allTime);
    expect(after.byAgent).toEqual(usage.byAgent);

    // Runs: target build, latest of a workflow, referenced and young runs stay.
    const runIds = (db.raw.prepare('SELECT id FROM test_runs').all() as { id: string }[]).map((x) => x.id);
    expect(runIds).not.toContain(runs.oldPlain);
    expect(runIds).toEqual(expect.arrayContaining([runs.onlyNightly, runs.noted, runs.fresh, db.targetBuild('ABCD', 'acme/shop')!.runId]));
    expect(count(db, 'test_results', `WHERE run_id = '${runs.oldPlain}'`)).toBe(0);

    // Passages: the cited version 1 still opens; the uncited version 2 is gone; current passages untouched.
    expect(listChunks(db, 'ABCD', repo.id, 1).length).toBeGreaterThan(0);
    expect(listChunks(db, 'ABCD', repo.id, 2)).toEqual([]);
    expect(listChunks(db, 'ABCD', repo.id).map((c) => c.id)).toEqual(current.map((c) => c.id));
    // The full-text index stayed in step with the deletes.
    expect(ensureFts(db)).toBe(false);

    // Vectors of the configured model stay.
    expect(count(db, 'chunk_embeddings', "WHERE model = 'old-model'")).toBe(0);
    expect(count(db, 'chunk_embeddings', "WHERE model = 'fake-embedder'")).toBe(current.length);

    // Files: the orphan is removed; the referenced file and the new one stay.
    expect(existsSync(join(files, 'ABCD', 'att-orphan'))).toBe(false);
    expect(existsSync(join(files, 'ABCD', 'att-kept'))).toBe(true);
    expect(existsSync(join(files, 'ABCD', 'att-new'))).toBe(true);

    // Nothing an answer, approval, artifact, citation, Huddle item or audit row is touched.
    expect(KEPT_TABLES.map((t) => count(db, t))).toEqual(kept);
    expect(db.raw.pragma('foreign_key_check')).toEqual([]);

    // Running again finds nothing more.
    const again = runRetention(db, policy, { now: NOW });
    expect([again.modelCalls.rows, again.testRuns.rows, again.retiredPassages.rows, again.staleVectors.rows, again.orphanFiles.rows]).toEqual([0, 0, 0, 0, 0]);
  });

  it('per-application limits, "off", an application filter, and no configured model', () => {
    const { db, policy } = fixture();
    const off = runRetention(db, { ...policy, apps: { ABCD: { runDays: null, modelCallDays: 365 } } }, { now: NOW });
    expect(off.testRuns.rows).toBe(0);
    expect(off.modelCalls.rows).toBe(0);
    const ibgmOnly = runRetention(db, { ...policy, only: ['IBGM'] }, { now: NOW });
    expect([ibgmOnly.modelCalls.rows, ibgmOnly.testRuns.rows, ibgmOnly.retiredPassages.rows, ibgmOnly.staleVectors.rows, ibgmOnly.orphanFiles.rows]).toEqual([0, 0, 0, 0, 0]);
    const noModel = runRetention(db, { ...policy, keepModels: null }, { now: NOW });
    expect(noModel.staleVectors.rows).toBe(0);
    expect(noModel.staleVectors.note).toMatch(/left alone/);

    const p = policyFromEnv({ HORIZON_RETAIN_RUNS_DAYS: '30', HORIZON_RETAIN_MODEL_CALLS_DAYS: 'off', HORIZON_RETAIN_RUNS_DAYS_IBGM: '7' });
    expect(p).toMatchObject({ runDays: 30, modelCallDays: null, apps: { IBGM: { runDays: 7 } } });
    expect(policyFromEnv({ HORIZON_RETAIN_RUNS_DAYS: 'nonsense' }).runDays).toBe(180);
  });
});
