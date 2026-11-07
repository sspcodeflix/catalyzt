/**
 * Consistent backup of a live Catalyzt database with SQLite's online backup API (safe while the
 * server is writing; copying the .db file alone while WAL is active is not).
 *
 *   npm run backup                      # data/horizon.db -> data/backups/horizon-<stamp>.db
 *   npm run backup -- <db> <out dir>
 *
 * Checks the copy's integrity and prints what it holds. Exit code 2 when the copy is not sound.
 * Attachments (HORIZON_FILES_DIR, default data/attachments) are plain files: back that folder up
 * alongside, after the database, so every attachment row has its file.
 */
import Database from 'better-sqlite3';
import { mkdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const src = resolve(process.argv[2] ?? process.env.HORIZON_DB_PATH ?? 'data/horizon.db');
const outDir = resolve(process.argv[3] ?? process.env.HORIZON_BACKUP_DIR ?? 'data/backups');
mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z').replace('T', '-');
const dest = join(outDir, `horizon-${stamp}.db`);

const live = new Database(src, { readonly: true, fileMustExist: true });
await live.backup(dest);
live.close();

const copy = new Database(dest, { readonly: true });
const integrity = copy.pragma('integrity_check', { simple: true }) as string;
const version = copy.pragma('user_version', { simple: true }) as number;
const count = (t: string) => (copy.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
const summary = {
  source: src,
  backup: dest,
  bytes: statSync(dest).size,
  schemaVersion: version,
  integrity,
  rows: Object.fromEntries(['applications', 'users', 'chats', 'messages', 'answer_revisions', 'approvals', 'stories', 'test_cases', 'test_runs', 'test_results', 'attachments', 'audit_log'].map((t) => [t, count(t)])),
};
copy.close();
console.log(JSON.stringify(summary, null, 2));
if (integrity !== 'ok') {
  console.error('The backup did not pass integrity_check; do not rely on it.');
  process.exit(2);
}
