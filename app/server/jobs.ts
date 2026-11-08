/**
 * Durable jobs: a SQLite-backed job/outbox record (scalability criterion 6). Background work and
 * any future external side effect is written here first, under an operation identity (`key`, the
 * idempotency key), then claimed by a worker with a lease, and completed or failed with backoff.
 *
 *   enqueue   idempotent by key: the same key never makes a second row. `rearm` turns a finished
 *             job back to pending (repeatable work such as embedding); a running job is marked to run
 *             once more (`rerun`) instead of starting a second copy.
 *   claim     takes the oldest due pending job of the given kinds and leases it to one owner.
 *   complete  done, unless a rerun was requested meanwhile (then pending again, due now).
 *   fail      pending again with exponential backoff, or `failed` after max_attempts.
 *   recover   a running job whose lease expired (the process died) goes back to pending; at start,
 *             every lease of an earlier process is expired.
 *
 * All writes are single short statements or transactions; nothing here awaits while holding one.
 */
import { randomUUID } from 'node:crypto';

import type { HorizonDb } from './db';

export type JobStatus = 'pending' | 'running' | 'done' | 'failed';

export interface Job<P = Record<string, unknown>> {
  id: string;
  key: string;
  kind: string;
  applicationId: string | null;
  payload: P;
  status: JobStatus;
  attempts: number;
  maxAttempts: number;
  nextAttemptAt: string;
  leaseOwner: string | null;
  leaseUntil: string | null;
  rerun: boolean;
  lastError: string | null;
  result: unknown;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

type Row = Record<string, unknown>;
const iso = (ms: number) => new Date(ms).toISOString();
const parse = (v: unknown) => {
  try {
    return typeof v === 'string' ? JSON.parse(v) : null;
  } catch {
    return null;
  }
};

function toJob<P>(r: Row): Job<P> {
  return {
    id: String(r.id),
    key: String(r.key),
    kind: String(r.kind),
    applicationId: (r.application_id as string) ?? null,
    payload: (parse(r.payload) ?? {}) as P,
    status: r.status as JobStatus,
    attempts: Number(r.attempts),
    maxAttempts: Number(r.max_attempts),
    nextAttemptAt: String(r.next_attempt_at),
    leaseOwner: (r.lease_owner as string) ?? null,
    leaseUntil: (r.lease_until as string) ?? null,
    rerun: Number(r.rerun) === 1,
    lastError: (r.last_error as string) ?? null,
    result: parse(r.result),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
    completedAt: (r.completed_at as string) ?? null,
  };
}

export interface EnqueueInput {
  /** Operation identity. Enqueueing the same key again returns the existing job. */
  key: string;
  kind: string;
  app?: string | null;
  payload?: object;
  maxAttempts?: number;
  /** When it may first run (default now). */
  runAt?: number;
  /** A finished job of this key becomes pending again; a running one runs once more after it finishes. */
  rearm?: boolean;
}

/** Enqueues a job, or returns the existing one with the same key. `created` says which. */
export function enqueue<P = Record<string, unknown>>(db: HorizonDb, input: EnqueueInput, at = Date.now()): { job: Job<P>; created: boolean } {
  const key = input.key.slice(0, 300);
  if (!key) throw new Error('A job needs a key.');
  return db.raw.transaction(() => {
    const t = iso(at);
    const due = iso(input.runAt ?? at);
    const r = db.raw
      .prepare(
        `INSERT INTO jobs (id, key, kind, application_id, payload, status, attempts, max_attempts, next_attempt_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?, ?) ON CONFLICT(key) DO NOTHING`,
      )
      .run(`job-${randomUUID()}`, key, input.kind, input.app ?? null, JSON.stringify(input.payload ?? {}), Math.max(1, input.maxAttempts ?? 5), due, t, t);
    const created = r.changes === 1;
    if (!created && input.rearm) {
      // Pending: due no later than asked. Running: once more afterwards. Done or failed: pending again, with fresh attempts.
      db.raw.prepare("UPDATE jobs SET next_attempt_at = MIN(next_attempt_at, ?), updated_at = ? WHERE key = ? AND status = 'pending'").run(due, t, key);
      db.raw.prepare("UPDATE jobs SET rerun = 1, updated_at = ? WHERE key = ? AND status = 'running'").run(t, key);
      db.raw
        .prepare("UPDATE jobs SET status = 'pending', attempts = 0, rerun = 0, next_attempt_at = ?, last_error = NULL, payload = ?, updated_at = ? WHERE key = ? AND status IN ('done', 'failed')")
        .run(due, JSON.stringify(input.payload ?? {}), t, key);
    }
    return { job: toJob<P>(db.raw.prepare('SELECT * FROM jobs WHERE key = ?').get(key) as Row), created };
  })();
}

/** Leases the oldest due pending job of these kinds to `owner` for `leaseMs`, or returns null. */
export function claim<P = Record<string, unknown>>(db: HorizonDb, opts: { kinds: string[]; keys?: string[]; owner: string; leaseMs?: number }, at = Date.now()): Job<P> | null {
  if (opts.kinds.length === 0 || opts.keys?.length === 0) return null;
  return db.raw.transaction(() => {
    const marks = (xs: string[]) => xs.map(() => '?').join(', ');
    const byKey = opts.keys ? ` AND key IN (${marks(opts.keys)})` : '';
    const r = db.raw
      .prepare(`SELECT id FROM jobs WHERE status = 'pending' AND next_attempt_at <= ? AND kind IN (${marks(opts.kinds)})${byKey} ORDER BY next_attempt_at, created_at, id LIMIT 1`)
      .get(iso(at), ...opts.kinds, ...(opts.keys ?? [])) as { id: string } | undefined;
    if (!r) return null;
    db.raw
      .prepare("UPDATE jobs SET status = 'running', attempts = attempts + 1, rerun = 0, lease_owner = ?, lease_until = ?, updated_at = ? WHERE id = ? AND status = 'pending'")
      .run(opts.owner, iso(at + (opts.leaseMs ?? 5 * 60_000)), iso(at), r.id);
    return toJob<P>(db.raw.prepare('SELECT * FROM jobs WHERE id = ?').get(r.id) as Row);
  })();
}

/** Extends a lease the owner still holds. False when it no longer holds it. */
export function heartbeat(db: HorizonDb, id: string, owner: string, leaseMs = 5 * 60_000, at = Date.now()) {
  return db.raw.prepare("UPDATE jobs SET lease_until = ?, updated_at = ? WHERE id = ? AND status = 'running' AND lease_owner = ?").run(iso(at + leaseMs), iso(at), id, owner).changes === 1;
}

/**
 * Marks the owner's job done (or pending again when a rerun was asked for meanwhile). False when the
 * owner no longer holds the lease: the job was recovered and may be running elsewhere, so the caller
 * must not report its result as the job's.
 */
export function complete(db: HorizonDb, id: string, owner: string, result: unknown = null, at = Date.now()) {
  const t = iso(at);
  return (
    db.raw
      .prepare(
        `UPDATE jobs SET status = CASE WHEN rerun = 1 THEN 'pending' ELSE 'done' END,
                         attempts = CASE WHEN rerun = 1 THEN 0 ELSE attempts END,
                         next_attempt_at = CASE WHEN rerun = 1 THEN ? ELSE next_attempt_at END,
                         completed_at = CASE WHEN rerun = 1 THEN completed_at ELSE ? END,
                         rerun = 0, lease_owner = NULL, lease_until = NULL, last_error = NULL, result = ?, updated_at = ?
         WHERE id = ? AND status = 'running' AND lease_owner = ?`,
      )
      .run(t, t, JSON.stringify(result ?? null), t, id, owner).changes === 1
  );
}

/** Exponential backoff: base × 2^(attempts − 1), capped. */
export const backoffMs = (attempts: number, baseMs = 30_000, capMs = 60 * 60_000) => Math.min(capMs, baseMs * 2 ** Math.max(0, attempts - 1));

/** Records a failure: pending again after a backoff, or `failed` once max_attempts is reached. Returns the new status, or null when the owner lost the lease. */
export function fail(db: HorizonDb, id: string, owner: string, error: string, opts: { baseMs?: number; capMs?: number } = {}, at = Date.now()): JobStatus | null {
  return db.raw.transaction(() => {
    const r = db.raw.prepare("SELECT attempts, max_attempts, rerun FROM jobs WHERE id = ? AND status = 'running' AND lease_owner = ?").get(id, owner) as { attempts: number; max_attempts: number; rerun: number } | undefined;
    if (!r) return null;
    const exhausted = r.attempts >= r.max_attempts;
    const status: JobStatus = exhausted ? 'failed' : 'pending';
    db.raw
      .prepare('UPDATE jobs SET status = ?, next_attempt_at = ?, lease_owner = NULL, lease_until = NULL, last_error = ?, updated_at = ? WHERE id = ?')
      .run(status, iso(at + (exhausted ? 0 : backoffMs(r.attempts, opts.baseMs, opts.capMs))), error.slice(0, 2000), iso(at), id);
    return status;
  })();
}

/**
 * Returns running jobs whose lease has expired to pending (due now), so another worker picks them up.
 * `all` treats every lease as expired: at start, any running job belongs to a process that is gone.
 * Each recovery counts as an attempt already spent; a job out of attempts becomes `failed`.
 */
export function recoverExpired(db: HorizonDb, opts: { all?: boolean } = {}, at = Date.now()): number {
  const t = iso(at);
  const where = opts.all ? "status = 'running'" : "status = 'running' AND lease_until < ?";
  const args = opts.all ? [] : [t];
  return db.raw.transaction(() => {
    const failed = db.raw.prepare(`UPDATE jobs SET status = 'failed', lease_owner = NULL, lease_until = NULL, last_error = 'The worker stopped (lease expired) and no attempts are left.', updated_at = ? WHERE ${where} AND attempts >= max_attempts`).run(t, ...args).changes;
    const back = db.raw.prepare(`UPDATE jobs SET status = 'pending', next_attempt_at = ?, lease_owner = NULL, lease_until = NULL, last_error = 'The worker stopped before finishing (lease expired); retried.', updated_at = ? WHERE ${where}`).run(t, t, ...args).changes;
    return failed + back;
  })();
}

export function getJob<P = Record<string, unknown>>(db: HorizonDb, key: string): Job<P> | null {
  const r = db.raw.prepare('SELECT * FROM jobs WHERE key = ?').get(key) as Row | undefined;
  return r ? toJob<P>(r) : null;
}

/** Jobs for the status views and operators, newest first. */
export function listJobs(db: HorizonDb, f: { kind?: string; status?: JobStatus; app?: string; limit?: number } = {}): Job[] {
  const where: string[] = [];
  const args: unknown[] = [];
  if (f.kind) where.push('kind = ?'), args.push(f.kind);
  if (f.status) where.push('status = ?'), args.push(f.status);
  if (f.app) where.push('application_id = ?'), args.push(f.app);
  const limit = Math.max(1, Math.min(200, Math.trunc(f.limit ?? 50)));
  return (db.raw.prepare(`SELECT * FROM jobs ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY updated_at DESC, id DESC LIMIT ?`).all(...args, limit) as Row[]).map((r) => toJob(r));
}

/** Queue backlog per kind and status, for the load profile and status lines. */
export function jobCounts(db: HorizonDb): Record<string, Partial<Record<JobStatus, number>>> {
  const out: Record<string, Partial<Record<JobStatus, number>>> = {};
  for (const r of db.raw.prepare('SELECT kind, status, COUNT(*) AS n FROM jobs GROUP BY kind, status').all() as { kind: string; status: JobStatus; n: number }[]) (out[r.kind] ??= {})[r.status] = r.n;
  return out;
}
