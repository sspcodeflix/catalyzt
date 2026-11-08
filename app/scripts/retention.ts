/**
 * Reference-aware retention for a Catalyzt database (see server/retention.ts for the rules).
 * Dry run by default: it reports what would be removed, with counts and bytes, and changes nothing.
 *
 *   npm run retention                                  # dry run against data/horizon.db
 *   npm run retention -- --apply                       # remove, in short batches
 *   npm run retention -- --apply --vacuum              # then VACUUM (stop the server first)
 *
 * Options (each also from the environment):
 *   --db=<path>                 HORIZON_DB_PATH (default data/horizon.db)
 *   --files=<dir>               HORIZON_FILES_DIR (default data/attachments); --no-files skips files
 *   --model-calls-days=<n|off>  HORIZON_RETAIN_MODEL_CALLS_DAYS (default 90)
 *   --runs-days=<n|off>         HORIZON_RETAIN_RUNS_DAYS (default 180)
 *   --model-calls-days=APP=<n>, --runs-days=APP=<n>   per application (HORIZON_RETAIN_*_DAYS_<APP>)
 *   --app=<id>                  only this application (repeatable)
 *   --keep-model=<id>           embedding models whose vectors stay (repeatable; default the configured
 *                               HORIZON_EMBED_MODEL, none when HORIZON_RETRIEVAL=keyword)
 *   --keep-retired              keep retired passage versions even when nobody cites them
 *   --file-grace-hours=<n>      files younger than this are never removed (default 24)
 *   --json                      print the report as JSON only
 *
 * Never removed: answers, revisions, citations, ratings, artifacts, approvals, Huddle items, the
 * audit log, and anything they reference. Back up first (npm run backup).
 */
import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

import { openDb } from '../server/db';
import { DEFAULT_EMBED_MODEL } from '../server/retrieval';
import { policyFromEnv, runRetention, type RetentionReport } from '../server/retention';

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const values = (name: string) => args.filter((a) => a.startsWith(`--${name}=`)).map((a) => a.slice(name.length + 3));
const env = process.env as Record<string, string | undefined>;

const unknown = args.filter((a) => !/^--(apply|vacuum|json|no-files|keep-retired|dry-run)$/.test(a) && !/^--(db|files|model-calls-days|runs-days|app|keep-model|file-grace-hours)=/.test(a));
if (unknown.length) {
  console.error(`Unknown option${unknown.length > 1 ? 's' : ''}: ${unknown.join(' ')}`);
  process.exit(2);
}
const apply = flag('apply');
if (flag('vacuum') && !apply) {
  console.error('--vacuum only runs with --apply.');
  process.exit(2);
}

const dbPath = resolve(values('db')[0] ?? env.HORIZON_DB_PATH ?? 'data/horizon.db');
if (!existsSync(dbPath)) {
  console.error(`No database at ${dbPath}.`);
  process.exit(2);
}
const policy = policyFromEnv(env);
const days = (v: string) => (/^(off|never|keep)$/i.test(v) ? null : Number.isInteger(Number(v)) && Number(v) >= 1 ? Number(v) : NaN);
for (const [opt, key] of [
  ['model-calls-days', 'modelCallDays'],
  ['runs-days', 'runDays'],
] as const)
  for (const v of values(opt)) {
    const m = /^([A-Za-z0-9_-]+)=(.+)$/.exec(v);
    const n = days(m ? m[2] : v);
    if (Number.isNaN(n)) {
      console.error(`--${opt} takes a whole number of days or "off", optionally as APP=<days>; got "${v}".`);
      process.exit(2);
    }
    if (m) (policy.apps![m[1]] ??= {})[key] = n;
    else policy[key] = n;
  }
policy.only = values('app');
policy.retiredPassages = !flag('keep-retired');
const kept = values('keep-model');
const retrievalOff = /^(keyword|off)$/i.test((env.HORIZON_RETRIEVAL ?? 'hybrid').trim());
policy.keepModels = kept.length ? kept : retrievalOff ? null : [env.HORIZON_EMBED_MODEL?.trim() || DEFAULT_EMBED_MODEL];
policy.filesDir = flag('no-files') ? null : resolve(values('files')[0] ?? env.HORIZON_FILES_DIR ?? 'data/attachments');
if (policy.filesDir && !existsSync(policy.filesDir)) policy.filesDir = null;
const grace = values('file-grace-hours')[0];
if (grace) policy.fileGraceHours = Math.max(0, Number(grace) || 24);

const db = openDb(dbPath);
const size = () => ['', '-wal'].reduce((n, s) => n + (existsSync(dbPath + s) ? statSync(dbPath + s).size : 0), 0);
const before = size();
const report: RetentionReport & { vacuum?: { before: number; after: number } } = runRetention(db, policy, { apply, log: flag('json') ? undefined : console.log });
if (apply && flag('vacuum')) {
  db.raw.pragma('wal_checkpoint(TRUNCATE)');
  db.raw.exec('VACUUM');
  db.raw.pragma('wal_checkpoint(TRUNCATE)');
  report.vacuum = { before, after: size() };
}
db.raw.close();

if (flag('json')) {
  console.log(JSON.stringify({ policy, ...report }, null, 2));
} else {
  const mb = (b: number) => `${(b / 1_048_576).toFixed(2)} MB`;
  const line = (label: string, c: { rows: number; bytes: number; byApp: Record<string, { rows: number }> }, unit: string, extra = '') =>
    console.log(`  ${label.padEnd(26)} ${String(c.rows).padStart(8)} ${unit.padEnd(9)} ${mb(c.bytes).padStart(10)}${Object.keys(c.byApp).length ? `   (${Object.entries(c.byApp).map(([a, x]) => `${a} ${x.rows}`).join(', ')})` : ''}${extra}`);
  console.log(`${apply ? 'Removed' : 'Would remove (dry run; --apply to remove)'} from ${dbPath}:`);
  line('Model-call detail', report.modelCalls, 'rows', policy.modelCallDays == null ? '   kept: off' : `   older than ${policy.modelCallDays} days, folded into daily totals`);
  line('Test runs', report.testRuns, 'runs', `   + ${report.testRuns.results} results; kept although old: ${Object.entries(report.testRuns.kept ?? {}).map(([k, n]) => `${k} ${n}`).join(', ')}`);
  line('Retired passage versions', report.retiredPassages, 'passages', `   + ${report.retiredPassages.vectors} vectors; kept because cited: ${report.retiredPassages.kept?.cited ?? 0}`);
  line('Vectors of other models', report.staleVectors, 'vectors', report.staleVectors.note ? `   ${report.staleVectors.note}` : report.staleVectors.models.length ? `   ${report.staleVectors.models.join(', ')}` : '');
  line('Orphan files', report.orphanFiles, 'files', report.orphanFiles.note ? `   ${report.orphanFiles.note}` : '');
  console.log(`  Database ${mb(report.database.bytes)}, ${mb(report.database.freeBytes)} free inside the file${apply && !report.vacuum ? ' (VACUUM with --vacuum, in a maintenance window, to give it back)' : ''}.`);
  if (report.vacuum) console.log(`  VACUUM: ${mb(report.vacuum.before)} -> ${mb(report.vacuum.after)} (database and WAL).`);
  console.log('  Never removed: answers, revisions, citations, ratings, artifacts, approvals, Huddle items, the audit log, and what they reference.');
}
