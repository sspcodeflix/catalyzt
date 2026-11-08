/**
 * App Context (F11): real passages from repository documentation and text uploads, honest states
 * for what cannot be read or is not connected, retrieval that respects scope and exclusions, and
 * conflicts that stay excluded until an owner decides in Huddle.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { addConfluence, addUploads, chunkDocs, collectDocs, getSource, listChunks, listSources, raiseConflict, resolveConflictForItem, retrieveContext, seedContext, syncSource, testQuestion } from './context';
import { fixtureWithDocs, REFUNDS_DOC, SHOP_README } from './fixture';
import { decide, getItem, listItems } from './huddle';
import { embedPending, embeddingCounts, fakeModels, RetrievalService, type RetrievalModels } from './retrieval';
import { MemoryBlobStore } from './storage';

const app = (db: ReturnType<typeof fixtureWithDocs>['db'], id: string) => db.getApp(id)!;
const user = (db: ReturnType<typeof fixtureWithDocs>['db'], id: string) => db.getUser(id)!;

describe('passages', () => {
  it('splits documents into paragraphs with locators and merges short ones', () => {
    const chunks = chunkDocs([{ path: 'README.md', text: SHOP_README }, { path: 'docs/refunds.md', text: REFUNDS_DOC }]);
    expect(chunks.map((c) => c.locator)).toEqual(['README.md ¶1', 'docs/refunds.md ¶1']);
    expect(chunks[0].text).toContain('Partial refunds are allowed for 45 days');
    expect(chunkDocs([{ path: 'a.md', text: 'tiny' }])).toEqual([]);
  });

  it('collects documentation files from a clone and skips code and binaries', () => {
    const { cloneDir } = fixtureWithDocs();
    writeFileSync(join(cloneDir, 'main.go'), 'package main');
    writeFileSync(join(cloneDir, 'docs', 'logo.md'), Buffer.from([0x23, 0x00, 0x01, 0x02]));
    expect(collectDocs(cloneDir).map((d) => d.path).sort()).toEqual(['README.md', 'docs/refunds.md']);
  });
});

describe('seeding from the workspace', () => {
  it('indexes a cloned repository, marks scan-only ones and the Jira feed honestly, and is idempotent', () => {
    const { db, ws } = fixtureWithDocs();
    const sources = listSources(db, 'ABCD');
    expect(sources.map((s) => [s.type, s.status, s.chunks])).toEqual([
      ['Jira', 'ready', 0],
      ['Repository', 'indexed', 2],
    ]);
    const repo = sources.find((s) => s.type === 'Repository')!;
    expect(repo).toMatchObject({ title: 'shop', trust: 'Code', version: 1, content: '2 passages from 2 documentation files' });
    expect(listChunks(db, 'ABCD', repo.id).map((c) => c.locator)).toEqual(['README.md ¶1', 'docs/refunds.md ¶1']);
    // IBGM has no repositories: only its Jira feed.
    expect(listSources(db, 'IBGM').map((s) => s.type)).toEqual(['Jira']);
    expect(seedContext(db, ws)).toMatchObject({ repos: 1, indexed: 1, chunks: 2, jira: 2 });
    expect(listSources(db, 'ABCD')).toHaveLength(2);
  });

  it('a sync re-reads the clone and bumps the version only when the text changed', () => {
    const { db, cloneDir } = fixtureWithDocs();
    const id = listSources(db, 'ABCD').find((s) => s.type === 'Repository')!.id;
    expect(syncSource(db, 'ABCD', id).notice).toMatch(/unchanged/);
    writeFileSync(join(cloneDir, 'docs', 'refunds.md'), `${REFUNDS_DOC}\nRefunds over 500 need a second approver.\n`);
    const r = syncSource(db, 'ABCD', id);
    expect(r.notice).toMatch(/version 2/);
    expect(r.source.version).toBe(2);
    expect(listChunks(db, 'ABCD', id).some((c) => c.text.includes('second approver'))).toBe(true);
  });
});

describe('uploads and connectors', () => {
  it('reads text formats into passages, keeps other formats as stored with the reason, refuses chat scope here', async () => {
    const { db } = fixtureWithDocs();
    const store = new MemoryBlobStore();
    const r = await addUploads(
      db,
      store,
      app(db, 'ABCD'),
      user(db, 'u-sourav'),
      [
        { filename: 'runbook.md', data: Buffer.from('# Runbook\n\nRestart the checkout service with kubectl rollout restart deployment/checkoutservice when it crashloops.\n') },
        { filename: 'design.pdf', data: Buffer.from('%PDF-1.4 x') },
        { filename: 'repo.zip', data: Buffer.from('PK\u0003\u0004') },
      ],
      'workspace',
      'payments',
    );
    expect(r.errors).toEqual([]);
    expect(r.sources.map((s) => [s.type, s.status, s.chunks, s.scope])).toEqual([
      ['Text', 'ready', 1, 'payments'],
      ['PDF', 'stored', 0, 'payments'],
      ['ZIP', 'stored', 0, 'payments'],
    ]);
    expect(r.sources[1].note).toMatch(/not available in this build/);
    expect(r.sources[2].note).toMatch(/Archives are kept but not read/);
    expect(store.blobs.size).toBe(3);
    await expect(addUploads(db, store, app(db, 'ABCD'), user(db, 'u-sourav'), [{ filename: 'x.md', data: Buffer.from('hello world, long enough to be a passage of text') }], 'chat', undefined)).rejects.toThrow(/attach button/);
    await expect(addUploads(db, store, app(db, 'ABCD'), user(db, 'u-sourav'), [{ filename: 'x.md', data: Buffer.from('hello') }], 'workspace', 'nope')).rejects.toThrow(/workspaces: storefront, payments/);
  });

  it('says Confluence is not connected instead of pretending', () => {
    expect(() => addConfluence()).toThrow(/not connected in this build/);
  });
});

describe('retrieval', () => {
  it('returns relevant, usable passages for the application and workspace, with a place to open them', async () => {
    const { db } = fixtureWithDocs();
    const hits = (await retrieveContext(db, 'ABCD', 'What is the refund window for partial refunds?')).passages;
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]).toMatchObject({ sourceTitle: 'shop', locator: 'docs/refunds.md ¶1', version: 1 });
    expect(hits[0].href).toMatch(/^\/context\/source\/ABCD-repo-shop#chunk-\d+$/);
    expect(hits[0].text).toContain('45 days');
    // Another application sees nothing of it; an unrelated question clears nothing.
    expect((await retrieveContext(db, 'IBGM', 'refund window')).passages).toEqual([]);
    expect((await retrieveContext(db, 'ABCD', 'kubernetes ingress certificate')).passages).toEqual([]);
    // A workspace upload is used for its workspace and for the whole-app question, not for another workspace.
    await addUploads(db, new MemoryBlobStore(), app(db, 'ABCD'), user(db, 'u-sourav'), [{ filename: 'runbook.md', data: Buffer.from('Restart the checkout service with kubectl rollout restart when it crashloops in payments.') }], 'workspace', 'payments');
    expect((await retrieveContext(db, 'ABCD', 'checkout crashloops restart', { workspace: 'payments' })).passages.map((p) => p.sourceTitle)).toEqual(['runbook.md']);
    expect((await retrieveContext(db, 'ABCD', 'checkout crashloops restart', { workspace: 'storefront' })).passages).toEqual([]);
    expect((await retrieveContext(db, 'ABCD', 'checkout crashloops restart')).passages.map((p) => p.sourceTitle)).toEqual(['runbook.md']);
  });

  it('"test a question" shows what would and would not be used, and why', async () => {
    const { db } = fixtureWithDocs();
    const { results, considered } = await testQuestion(db, app(db, 'ABCD'), 'partial refunds 45 days');
    expect(considered).toMatchObject({ passages: 2, stories: 3 });
    expect(results[0]).toMatchObject({ used: true, reason: null });
    expect(results.some((r) => r.where.startsWith('Jira · ABCD-1001'))).toBe(true);
  });
});

describe('conflicts and decisions', () => {
  const setup = async () => {
    const { db } = fixtureWithDocs();
    const store = new MemoryBlobStore();
    const up = await addUploads(db, store, app(db, 'ABCD'), user(db, 'u-sourav'), [{ filename: 'team-notes.md', data: Buffer.from('Partial refunds are allowed for 60 days from settlement according to the team.') }], 'app', undefined);
    const upload = up.sources[0];
    const repo = listSources(db, 'ABCD').find((s) => s.type === 'Repository')!;
    return { db, upload, repo };
  };

  it('a conflict excludes the upload until an owner decides; keeping the higher-trust source keeps it excluded', async () => {
    const { db, upload, repo } = await setup();
    expect((await retrieveContext(db, 'ABCD', 'partial refunds allowed days settlement')).passages.map((p) => p.sourceTitle)).toContain('team-notes.md');
    const { conflict, huddleItemId } = raiseConflict(db, app(db, 'ABCD'), user(db, 'u-sourav'), {
      sourceId: upload.id,
      otherSourceId: repo.id,
      title: 'Refund window: 60 or 45 days?',
      detail: 'The team notes say 60 days; the repository README says 45.',
      compare: [
        { value: '60 days', where: 'team-notes.md ¶1' },
        { value: '45 days', where: 'README.md ¶1' },
      ],
    });
    expect(conflict.status).toBe('open');
    // The upload's passage plus the disputed claim added for it, both excluded while the conflict is open.
    expect(getSource(db, 'ABCD', upload.id)).toMatchObject({ status: 'review', excludedChunks: 2, conflictId: conflict.id });
    expect((await retrieveContext(db, 'ABCD', 'partial refunds allowed days settlement')).passages.map((p) => p.sourceTitle)).not.toContain('team-notes.md');
    const item = getItem(db, 'ABCD', huddleItemId)!;
    expect(item).toMatchObject({ kind: 'conflict', sourceId: upload.id, raisedBy: 'Sourav' });
    expect(item.options.map((o) => o.keepsUpload)).toEqual([false, true]);
    expect(item.citations.map((c) => c.href)).toEqual([`/context/source/${upload.id}`, `/context/source/${repo.id}`]);
    expect(listItems(db, 'IBGM')).toEqual([]);
    // A second conflict on the same source waits for the first.
    expect(() => raiseConflict(db, app(db, 'ABCD'), user(db, 'u-sourav'), { sourceId: upload.id, otherSourceId: repo.id, title: 'again', detail: '', compare: [{ value: 'a' }, { value: 'b' }] })).toThrow(/already has an open conflict/);
    // A lower-trust "other" is refused: conflicts are always with a higher-trust source.
    expect(() => raiseConflict(db, app(db, 'ABCD'), user(db, 'u-sourav'), { sourceId: repo.id, otherSourceId: upload.id, title: 'x', detail: '', compare: [{ value: 'a' }, { value: 'b' }] })).toThrow(/does not rank above/);

    const d = decide(db, 'ABCD', huddleItemId, 'u-ram', item.options[0].id, 'The README is the contract until the team notes are reviewed.');
    expect(d.keepsUpload).toBe(false);
    const resolved = resolveConflictForItem(db, huddleItemId, d.keepsUpload)!;
    expect(resolved).toMatchObject({ status: 'resolved', resolution: 'keep_higher' });
    expect(getSource(db, 'ABCD', upload.id)).toMatchObject({ status: 'ready', excludedChunks: 2, conflictId: null });
    expect((await retrieveContext(db, 'ABCD', 'partial refunds allowed days settlement')).passages.map((p) => p.sourceTitle)).not.toContain('team-notes.md');
    expect(getItem(db, 'ABCD', huddleItemId)?.decision).toMatchObject({ by: 'Ram Kumar', reason: expect.stringContaining('README') });
  });

  it('deciding for the upload makes its passages usable again', async () => {
    const { db, upload, repo } = await setup();
    const { huddleItemId } = raiseConflict(db, app(db, 'ABCD'), user(db, 'u-sourav'), { sourceId: upload.id, otherSourceId: repo.id, title: 'Refund window', detail: '', compare: [{ value: '60 days' }, { value: '45 days' }] });
    const item = getItem(db, 'ABCD', huddleItemId)!;
    const d = decide(db, 'ABCD', huddleItemId, 'u-ram', item.options[1].id, 'Product confirmed the window moved to 60 days.');
    resolveConflictForItem(db, huddleItemId, d.keepsUpload);
    expect(getSource(db, 'ABCD', upload.id)).toMatchObject({ status: 'ready', excludedChunks: 0 });
    expect((await retrieveContext(db, 'ABCD', 'partial refunds allowed days settlement')).passages.map((p) => p.sourceTitle)).toContain('team-notes.md');
  });
});

describe('hybrid retrieval (embeddings and reranking)', () => {
  // "money back" and "period" are not in the documents; the fake embedder maps them to "refund" and "window".
  const models = () => fakeModels({ money: 'refund', back: 'refund', period: 'window', returned: 'refund' });

  it('embeds every passage once, reports what is embedded, and retrieves by meaning without keyword overlap', async () => {
    const { db } = fixtureWithDocs();
    const m = models();
    const before = embeddingCounts(db, m.embedder!.id);
    expect(before).toMatchObject({ embedded: 0 });
    expect(before.pending).toBeGreaterThan(0);
    // Before the job runs, retrieval is honest about being keyword-only, even with models configured.
    const kw = await retrieveContext(db, 'ABCD', 'money back period', { models: m });
    expect(kw).toMatchObject({ mode: 'keyword', passages: [] });

    expect(await embedPending(db, m.embedder!)).toEqual({ embedded: before.pending, failed: 0 });
    expect(embeddingCounts(db, m.embedder!.id)).toEqual({ embedded: before.pending, pending: 0 });
    expect(await embedPending(db, m.embedder!)).toEqual({ embedded: 0, failed: 0 });

    const hits = await retrieveContext(db, 'ABCD', 'money back period', { models: m });
    expect(hits.mode).toBe('hybrid');
    expect(hits.reranked).toBe(true);
    expect(hits.passages.map((p) => p.locator)).toContain('docs/refunds.md ¶1');
    expect(hits.embedded).toBe(hits.total);
    // Another application still sees nothing; vectors are joined per application.
    expect((await retrieveContext(db, 'IBGM', 'money back period', { models: m })).passages).toEqual([]);
  });

  it('keeps excluded and foreign-workspace passages out of hybrid results too', async () => {
    const { db } = fixtureWithDocs();
    const m = models();
    const store = new MemoryBlobStore();
    const up = await addUploads(db, store, app(db, 'ABCD'), user(db, 'u-sourav'), [{ filename: 'team-notes.md', data: Buffer.from('The team says the refund window is 60 days from settlement, not 45.') }], 'workspace', 'payments');
    await embedPending(db, m.embedder!);
    const inPayments = await retrieveContext(db, 'ABCD', 'money back period', { models: m, workspace: 'payments' });
    expect(inPayments.passages.map((p) => p.sourceTitle)).toContain('team-notes.md');
    const inStorefront = await retrieveContext(db, 'ABCD', 'money back period', { models: m, workspace: 'storefront' });
    expect(inStorefront.passages.map((p) => p.sourceTitle)).not.toContain('team-notes.md');
    const repo = listSources(db, 'ABCD').find((s) => s.type === 'Repository')!;
    raiseConflict(db, app(db, 'ABCD'), user(db, 'u-ram'), { sourceId: up.sources[0].id, otherSourceId: repo.id, title: 'Refund window', detail: '', compare: [{ value: '60 days' }, { value: '45 days' }] });
    const afterConflict = await retrieveContext(db, 'ABCD', 'money back period', { models: m, workspace: 'payments' });
    expect(afterConflict.mode).toBe('hybrid');
    expect(afterConflict.passages.map((p) => p.sourceTitle)).not.toContain('team-notes.md');
  });

  it('a re-index keeps the vectors of unchanged passages and leaves only new text pending', async () => {
    const { db, ws, cloneDir } = fixtureWithDocs();
    const m = models();
    await embedPending(db, m.embedder!);
    const repo = listSources(db, 'ABCD').find((s) => s.type === 'Repository')!;
    // Seeding again with unchanged documents touches nothing.
    seedContext(db, ws);
    expect(embeddingCounts(db, m.embedder!.id, 'ABCD').pending).toBe(0);
    // One document changes: its passages are re-created, the other document's vectors are carried over.
    writeFileSync(join(cloneDir, 'docs', 'refunds.md'), `${REFUNDS_DOC}\n\nRefund reports are produced nightly for finance.`);
    syncSource(db, 'ABCD', repo.id);
    const counts = embeddingCounts(db, m.embedder!.id, 'ABCD');
    expect(counts.pending).toBeGreaterThanOrEqual(1);
    expect(counts.embedded).toBeGreaterThanOrEqual(1);
    const calls = m.calls.embed;
    await embedPending(db, m.embedder!);
    expect(m.calls.embed).toBe(calls + 1);
    expect(embeddingCounts(db, m.embedder!.id, 'ABCD').pending).toBe(0);
  });

  it('the service runs one job at a time, reports its state, and falls back to keyword when a model fails', async () => {
    const { db } = fixtureWithDocs();
    const m = models();
    const service = new RetrievalService(m, () => db);
    expect(service.status(db, 'ABCD')).toMatchObject({ mode: 'keyword', embedder: 'fake-embedder', reranker: 'fake-reranker' });
    const a = service.schedule();
    const b = service.schedule();
    expect(b).toBe(a);
    await a;
    await service.whenIdle();
    expect(service.status(db, 'ABCD')).toMatchObject({ mode: 'hybrid', state: 'ready', pending: 0 });
    expect(m.calls.embed).toBeLessThanOrEqual(2);

    const broken: RetrievalModels = {
      embedder: { id: 'broken', dims: 4, embed: async () => { throw new Error('no model'); } },
      reranker: null,
    };
    const r = await retrieveContext(db, 'ABCD', 'What is the refund window for partial refunds?', { models: broken });
    expect(r.mode).toBe('keyword');
    expect(r.passages[0]?.locator).toBe('docs/refunds.md ¶1');
  });

  it('"test a question" ranks Jira stories and Hexa tests with the passages and says how', async () => {
    const { db } = fixtureWithDocs();
    const m = models();
    await embedPending(db, m.embedder!);
    const r = await testQuestion(db, app(db, 'ABCD'), 'money back period', m);
    expect(r.mode).toBe('hybrid');
    expect(r.how).toMatch(/^hybrid: keyword and meaning, reranked/);
    expect(r.results.some((x) => x.where.startsWith('shop · docs/refunds.md'))).toBe(true);
    const plain = await testQuestion(db, app(db, 'ABCD'), 'partial refunds 45 days');
    expect(plain.how).toBe('keyword match');
    expect(plain.results.some((x) => x.where.startsWith('Jira · ABCD-1001'))).toBe(true);
  });
});

describe('vectors follow the text they were computed from (F25)', () => {
  it('a passage that changes while it is being embedded never keeps the old vector, and is embedded again', async () => {
    const { db, cloneDir } = fixtureWithDocs();
    const inner = fakeModels();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow: RetrievalModels = {
      embedder: {
        id: 'slow',
        dims: 64,
        embed: async (texts) => {
          await gate;
          return inner.embedder!.embed(texts);
        },
      },
      reranker: null,
    };
    // The job reads the old refund text and waits in the model; meanwhile the document changes and is re-indexed.
    const job = embedPending(db, slow.embedder!);
    await new Promise((r) => setTimeout(r, 5));
    writeFileSync(join(cloneDir, 'docs', 'refunds.md'), REFUNDS_DOC.replace('45 days', '365 days'));
    const repo = listSources(db, 'ABCD').find((s) => s.type === 'Repository')!;
    expect(syncSource(db, 'ABCD', repo.id).source.version).toBe(2);
    release();
    await job;
    // No vector row disagrees with its passage's text, and nothing is left pending.
    expect(db.raw.prepare('SELECT COUNT(*) AS n FROM chunk_embeddings e JOIN source_chunks c ON c.id = e.chunk_id WHERE e.text_sha != c.text_sha').get()).toEqual({ n: 0 });
    expect(embeddingCounts(db, 'slow', 'ABCD').pending).toBe(0);
    expect(inner.calls.embed).toBeGreaterThanOrEqual(2);
    const hits = await retrieveContext(db, 'ABCD', 'refund window', { models: slow });
    expect(hits.mode).toBe('hybrid');
    expect(hits.passages.some((p) => p.text.includes('365 days'))).toBe(true);
  });

  it('a vector with the wrong dimensions is ignored, so a model change never ranks with foreign vectors', async () => {
    const { db } = fixtureWithDocs();
    const m = fakeModels();
    await embedPending(db, m.embedder!);
    const other: RetrievalModels = { embedder: { id: m.embedder!.id, dims: 8, embed: async (t) => t.map(() => new Float32Array(8).fill(0.35)) }, reranker: null };
    const r = await retrieveContext(db, 'ABCD', 'What is the refund window for partial refunds?', { models: other });
    expect(r.mode).toBe('keyword');
  });
});

describe('secrets never become context (F05)', () => {
  const SECRET = 'AKIAABCDEFGHIJKLMNOP';

  it('refuses an upload that holds a secret, and excludes a repository passage that does', async () => {
    const { db, cloneDir } = fixtureWithDocs();
    const r = await addUploads(db, new MemoryBlobStore(), app(db, 'ABCD'), user(db, 'u-sourav'), [{ filename: 'creds.md', data: Buffer.from(`token ${SECRET} is used for refunds in the refund window`) }], 'app', undefined);
    expect(r.sources).toEqual([]);
    expect(r.errors[0]).toMatch(/creds\.md.*not kept/);
    writeFileSync(join(cloneDir, 'docs', 'ops.md'), `# Ops\n\nThe refund window service uses key ${SECRET} to call the bank, and partial refunds take 45 days to settle.\n`);
    const repo = listSources(db, 'ABCD').find((s) => s.type === 'Repository')!;
    syncSource(db, 'ABCD', repo.id);
    const chunk = listChunks(db, 'ABCD', repo.id).find((c) => c.text.includes(SECRET))!;
    expect(chunk.excludedReason).toMatch(/password, key or token/);
    const hits = await retrieveContext(db, 'ABCD', 'refund window bank key');
    expect(hits.passages.some((p) => p.text.includes(SECRET))).toBe(false);
    const shown = await testQuestion(db, app(db, 'ABCD'), 'refund window bank key');
    expect(shown.results.find((x) => x.text.includes(SECRET))?.used ?? false).toBe(false);
  });
});
