/**
 * Concurrency caps for work that holds the process for long (scalability criterion 2). A workflow
 * run streams for seconds to minutes and may call a model; without a cap one person (or a stuck
 * client) can tie up the event loop and the database writer for everyone.
 *
 *   HORIZON_MAX_RUNS             concurrent /api/run workflows in this process (default 8)
 *   HORIZON_MAX_RUNS_PER_PERSON  concurrent /api/run workflows per person (default 2)
 *   HORIZON_MAX_SCANS            concurrent repository scans in this process (default 2)
 *
 * A request over a limit is refused before anything is written, with 429 and Retry-After.
 */
export interface RunLimits {
  perProcess: number;
  perPerson: number;
}

export const DEFAULT_RUN_LIMITS: RunLimits = { perProcess: 8, perPerson: 2 };
export const DEFAULT_MAX_SCANS = 2;

const positive = (v: string | undefined, def: number) => {
  const n = Number(v);
  return v != null && v.trim() !== '' && Number.isInteger(n) && n >= 1 ? Math.min(n, 1000) : def;
};

export function runLimitsFromEnv(env: Record<string, string | undefined>): RunLimits {
  return { perProcess: positive(env.HORIZON_MAX_RUNS, DEFAULT_RUN_LIMITS.perProcess), perPerson: positive(env.HORIZON_MAX_RUNS_PER_PERSON, DEFAULT_RUN_LIMITS.perPerson) };
}

export const maxScansFromEnv = (env: Record<string, string | undefined>) => positive(env.HORIZON_MAX_SCANS, DEFAULT_MAX_SCANS);

export type Slot = { ok: true; release: () => void } | { ok: false; scope: 'process' | 'person'; message: string; retryAfterSeconds: number };

/** Counts running workflows per process and per person. `acquire` never blocks: a slot or a refusal. */
export class RunLimiter {
  private total = 0;
  private readonly perPerson = new Map<string, number>();

  constructor(readonly limits: RunLimits = DEFAULT_RUN_LIMITS) {}

  acquire(personId: string): Slot {
    const mine = this.perPerson.get(personId) ?? 0;
    if (mine >= this.limits.perPerson)
      return {
        ok: false,
        scope: 'person',
        message: `You already have ${mine} answer${mine === 1 ? '' : 's'} running (the limit is ${this.limits.perPerson}). Wait for one to finish or stop it, then send again.`,
        retryAfterSeconds: 5,
      };
    if (this.total >= this.limits.perProcess)
      return { ok: false, scope: 'process', message: `Catalyzt is answering ${this.total} requests right now, its limit. Nothing was sent or saved; try again in a few seconds.`, retryAfterSeconds: 10 };
    this.total++;
    this.perPerson.set(personId, mine + 1);
    let released = false;
    return {
      ok: true,
      release: () => {
        if (released) return;
        released = true;
        this.total--;
        const n = (this.perPerson.get(personId) ?? 1) - 1;
        if (n <= 0) this.perPerson.delete(personId);
        else this.perPerson.set(personId, n);
      },
    };
  }

  /** Running workflows: in total and for one person. */
  running(personId?: string) {
    return personId ? (this.perPerson.get(personId) ?? 0) : this.total;
  }
}
