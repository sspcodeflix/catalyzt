/**
 * Durable jobs (criterion 6): idempotent enqueue, leases, backoff, recovery after a crash, and the
 * App Context embedding job running through them.
 */
import { describe, expect, it } from 'vitest';

import { fixtureDb, fixtureWithDocs } from './fixture';
import { backoffMs, claim, complete, enqueue, fail, getJob, heartbeat, jobCounts, listJobs, recoverExpired } from './jobs';
import { embedJobKey, embeddingCounts, fakeModels, RetrievalService } from './retrieval';

const T0 = Date.parse('2026-11-08T10:00:00Z');

describe('jobs', () => {
  it('enqueueing the same key twice keeps one job and returns it', () => {
    const db = fixtureDb();
    const a = enqueue(db, { key: 'push:ABCD:run-1', kind: 'push', app: 'ABCD', payload: { n: 1 } }, T0);
    const b = enqueue(db, { key: 'push:ABCD:run-1', kind: 'push', app: 'ABCD', payload: { n: 2 } }, T0 + 1000);
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.job.id).toBe(a.job.id);
    expect(b.job.payload).toEqual({ n: 1 });
    expect((db.raw.prepare('SELECT COUNT(*) AS n FROM jobs').get() as { n: number }).n).toBe(1);
    // A finished job is not run again by a duplicate delivery, unless the caller asks for a re-arm.
    const owner = 'w1';
    const job = claim(db, { kinds: ['push'], owner }, T0 + 2000)!;
    expect(complete(db, job.id, owner, { ok: true }, T0 + 3000)).toBe(true);
    expect(enqueue(db, { key: 'push:ABCD:run-1', kind: 'push' }, T0 + 4000).job.status).toBe('done');
    expect(claim(db, { kinds: ['push'], owner }, T0 + 5000)).toBeNull();
    expect(enqueue(db, { key: 'push:ABCD:run-1', kind: 'push', rearm: true }, T0 + 6000).job.status).toBe('pending');
  });

  it('a claim leases one job to one owner; a second claim gets nothing', () => {
    const db = fixtureDb();
    enqueue(db, { key: 'k1', kind: 'embed' }, T0);
    const first = claim(db, { kinds: ['embed'], owner: 'a', leaseMs: 60_000 }, T0);
    const second = claim(db, { kinds: ['embed'], owner: 'b', leaseMs: 60_000 }, T0);
    expect(first).toMatchObject({ status: 'running', attempts: 1, leaseOwner: 'a' });
    expect(second).toBeNull();
    // Only the owner can finish it.
    expect(complete(db, first!.id, 'b', null, T0 + 10)).toBe(false);
    expect(heartbeat(db, first!.id, 'b', 60_000, T0 + 10)).toBe(false);
    expect(heartbeat(db, first!.id, 'a', 60_000, T0 + 10)).toBe(true);
    expect(complete(db, first!.id, 'a', { embedded: 3 }, T0 + 20)).toBe(true);
    expect(getJob(db, 'k1')).toMatchObject({ status: 'done', result: { embedded: 3 }, leaseOwner: null });
  });

  it('a failure is retried with exponential backoff, then marked failed after max attempts', () => {
    const db = fixtureDb();
    enqueue(db, { key: 'k', kind: 'push', maxAttempts: 3 }, T0);
    let at = T0;
    const statuses: string[] = [];
    for (let i = 1; i <= 3; i++) {
      const job = claim(db, { kinds: ['push'], owner: 'w' }, at)!;
      expect(job.attempts).toBe(i);
      statuses.push(fail(db, job.id, 'w', `boom ${i}`, { baseMs: 1000 }, at)!);
      const j = getJob(db, 'k')!;
      if (i < 3) {
        expect(Date.parse(j.nextAttemptAt) - at).toBe(backoffMs(i, 1000));
        // Not due before the backoff.
        expect(claim(db, { kinds: ['push'], owner: 'w' }, at + backoffMs(i, 1000) - 1)).toBeNull();
      }
      at += backoffMs(i, 1000);
    }
    expect(statuses).toEqual(['pending', 'pending', 'failed']);
    expect(getJob(db, 'k')).toMatchObject({ status: 'failed', attempts: 3, lastError: 'boom 3' });
    expect(backoffMs(1, 1000)).toBe(1000);
    expect(backoffMs(3, 1000)).toBe(4000);
  });

  it('a crashed worker leaves an expired lease, which is recovered and run once more', () => {
    const db = fixtureDb();
    enqueue(db, { key: 'k', kind: 'push' }, T0);
    const crashed = claim(db, { kinds: ['push'], owner: 'dead', leaseMs: 1000 }, T0)!;
    // Before the lease expires nothing is recovered.
    expect(recoverExpired(db, {}, T0 + 500)).toBe(0);
    expect(recoverExpired(db, {}, T0 + 1001)).toBe(1);
    expect(getJob(db, 'k')).toMatchObject({ status: 'pending', leaseOwner: null });
    const again = claim(db, { kinds: ['push'], owner: 'alive' }, T0 + 1002)!;
    expect(again.id).toBe(crashed.id);
    expect(again.attempts).toBe(2);
    // The dead owner's late completion is refused; only the live owner's counts.
    expect(complete(db, crashed.id, 'dead', null, T0 + 1003)).toBe(false);
    expect(complete(db, again.id, 'alive', null, T0 + 1004)).toBe(true);
    expect(jobCounts(db)).toEqual({ push: { done: 1 } });
  });

  it('at start every running lease belongs to a stopped process; one out of attempts is failed', () => {
    const db = fixtureDb();
    enqueue(db, { key: 'a', kind: 'push' }, T0);
    enqueue(db, { key: 'b', kind: 'push', maxAttempts: 1 }, T0);
    claim(db, { kinds: ['push'], owner: 'old', leaseMs: 3_600_000 }, T0);
    claim(db, { kinds: ['push'], owner: 'old', leaseMs: 3_600_000 }, T0);
    expect(recoverExpired(db, { all: true }, T0 + 10)).toBe(2);
    expect(getJob(db, 'a')!.status).toBe('pending');
    expect(getJob(db, 'b')!.status).toBe('failed');
    expect(listJobs(db, { kind: 'push' }).map((j) => j.key).sort()).toEqual(['a', 'b']);
  });

  it('a re-arm while running runs the job exactly once more', () => {
    const db = fixtureDb();
    enqueue(db, { key: 'k', kind: 'embed' }, T0);
    const job = claim(db, { kinds: ['embed'], owner: 'w' }, T0)!;
    enqueue(db, { key: 'k', kind: 'embed', rearm: true }, T0 + 1);
    enqueue(db, { key: 'k', kind: 'embed', rearm: true }, T0 + 2);
    expect(complete(db, job.id, 'w', null, T0 + 3)).toBe(true);
    expect(getJob(db, 'k')!.status).toBe('pending');
    const second = claim(db, { kinds: ['embed'], owner: 'w' }, T0 + 4)!;
    expect(complete(db, second.id, 'w', null, T0 + 5)).toBe(true);
    expect(getJob(db, 'k')!.status).toBe('done');
    expect(claim(db, { kinds: ['embed'], owner: 'w' }, T0 + 6)).toBeNull();
  });
});

describe('the App Context embedding job', () => {
  it('runs through a durable job, is visible in the status, and resumes after a crash', async () => {
    const { db } = fixtureWithDocs();
    const m = fakeModels();
    const key = embedJobKey(m.embedder!.id);
    // A previous process claimed the job and died mid-way.
    enqueue(db, { key, kind: 'embed', payload: { model: m.embedder!.id } });
    claim(db, { kinds: ['embed'], owner: 'dead-process', leaseMs: 3_600_000 });
    expect(recoverExpired(db, { all: true })).toBe(1);

    const service = new RetrievalService(m, () => db);
    await service.schedule();
    await service.whenIdle();
    expect(getJob(db, key)).toMatchObject({ status: 'done', attempts: 2 });
    expect(embeddingCounts(db, m.embedder!.id, 'ABCD').embedded).toBeGreaterThan(0);
    expect(service.status(db, 'ABCD').job).toMatchObject({ status: 'done' });
    expect(embeddingCounts(db, m.embedder!.id, 'ABCD').pending).toBe(0);
    // Scheduling again is one job, not a second row.
    await service.schedule();
    await service.whenIdle();
    expect((db.raw.prepare('SELECT COUNT(*) AS n FROM jobs').get() as { n: number }).n).toBe(1);
  });

  it('a failing model leaves the job pending with the error and backoff, retrieval stays keyword', async () => {
    const { db } = fixtureWithDocs();
    const service = new RetrievalService({ embedder: { id: 'broken', dims: 4, embed: async () => { throw new Error('no model'); } }, reranker: null }, () => db);
    await service.schedule();
    await service.whenIdle();
    const job = getJob(db, embedJobKey('broken'))!;
    expect(job.status).toBe('pending');
    expect(job.attempts).toBe(1);
    expect(job.lastError).toContain('could not run');
    expect(Date.parse(job.nextAttemptAt)).toBeGreaterThan(Date.now());
    expect(service.status(db, 'ABCD').mode).toBe('keyword');
  });
});
