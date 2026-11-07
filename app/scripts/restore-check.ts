/**
 * Rehearses a restore: copies a backup to a scratch file, opens it the way the server does (which
 * applies any pending schema migrations), and checks integrity, foreign keys, row counts, scoped
 * ownership and (when HORIZON_FILES_DIR is given) that every attachment still has its file.
 *
 *   npm run restore-check -- data/backups/horizon-<stamp>.db [files dir]
 *
 * Exit 1 when anything is wrong. Nothing touches the live database.
 */
import { copyFileSync, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { openDb } from '../server/db';
import { MIGRATIONS } from '../server/schema';

const backup = process.argv[2] ? resolve(process.argv[2]) : null;
if (!backup || !existsSync(backup)) {
  console.error('Give the path of a backup file (see npm run backup).');
  process.exit(1);
}
const filesDir = process.argv[3] ? resolve(process.argv[3]) : process.env.HORIZON_FILES_DIR ? resolve(process.env.HORIZON_FILES_DIR) : null;

const scratch = join(mkdtempSync(join(tmpdir(), 'horizon-restore-')), 'restored.db');
copyFileSync(backup, scratch);
const db = openDb(scratch);
const raw = db.raw;
const problems: string[] = [];

const integrity = raw.pragma('integrity_check', { simple: true }) as string;
if (integrity !== 'ok') problems.push(`integrity_check: ${integrity}`);
const fk = raw.pragma('foreign_key_check') as unknown[];
if (fk.length) problems.push(`${fk.length} foreign key violations`);
const version = raw.pragma('user_version', { simple: true }) as number;
if (version !== MIGRATIONS.length) problems.push(`schema version ${version} after migration, expected ${MIGRATIONS.length}`);

const count = (sql: string, ...args: unknown[]) => (raw.prepare(sql).get(...args) as { n: number }).n;
const apps = (raw.prepare('SELECT id, name FROM applications ORDER BY id').all() as { id: string; name: string }[]).map((a) => ({
  ...a,
  members: count('SELECT COUNT(DISTINCT user_id) AS n FROM memberships WHERE application_id = ?', a.id),
  stories: count('SELECT COUNT(*) AS n FROM stories WHERE application_id = ?', a.id),
  chats: count('SELECT COUNT(*) AS n FROM chats WHERE application_id = ?', a.id),
  messages: count('SELECT COUNT(*) AS n FROM messages m JOIN chats c ON c.id = m.chat_id WHERE c.application_id = ?', a.id),
  revisions: count('SELECT COUNT(*) AS n FROM answer_revisions ar JOIN messages m ON m.id = ar.message_id JOIN chats c ON c.id = m.chat_id WHERE c.application_id = ?', a.id),
  approvals: count('SELECT COUNT(*) AS n FROM approvals a JOIN answer_revisions ar ON ar.id = a.revision_id JOIN messages m ON m.id = ar.message_id JOIN chats c ON c.id = m.chat_id WHERE c.application_id = ?', a.id),
  tests: count("SELECT COUNT(*) AS n FROM test_cases WHERE application_id = ? AND status = 'active'", a.id),
  runs: count('SELECT COUNT(*) AS n FROM test_runs WHERE application_id = ?', a.id),
  attachments: count('SELECT COUNT(*) AS n FROM attachments WHERE application_id = ?', a.id),
}));

// Scoped ownership: nothing may point across applications.
const cross = [
  ['story_components', count("SELECT COUNT(*) AS n FROM story_components sc JOIN stories s ON s.key = sc.story_key JOIN components c ON c.id = sc.component_id WHERE s.application_id != c.application_id")],
  ['attachments.chat', count('SELECT COUNT(*) AS n FROM attachments a JOIN chats c ON c.id = a.chat_id WHERE a.application_id != c.application_id')],
  ['test_case_links.story', count("SELECT COUNT(*) AS n FROM test_case_links l JOIN test_cases t ON t.id = l.test_case_id JOIN stories s ON s.key = l.entity_ref WHERE l.entity_type = 'story' AND s.application_id != t.application_id")],
  ['workflow_runs.chat', count('SELECT COUNT(*) AS n FROM workflow_runs w JOIN chats c ON c.id = w.chat_id WHERE w.application_id IS NOT NULL AND w.application_id != c.application_id')],
].filter(([, n]) => (n as number) > 0);
for (const [what, n] of cross) problems.push(`${n} ${what} rows cross an application boundary`);

let missingFiles: string[] = [];
if (filesDir) {
  const keys = (raw.prepare('SELECT storage_key FROM attachments').all() as { storage_key: string }[]).map((r) => r.storage_key);
  missingFiles = keys.filter((k) => !existsSync(join(filesDir, k)));
  if (missingFiles.length) problems.push(`${missingFiles.length} attachments have no file under ${filesDir}`);
}

const running = count("SELECT COUNT(*) AS n FROM workflow_runs WHERE status = 'running'");
db.raw.close();

console.log(
  JSON.stringify(
    {
      backup,
      restoredTo: scratch,
      schemaVersion: version,
      integrity,
      foreignKeyViolations: fk.length,
      runsStillMarkedRunning: running,
      note: running ? 'The server marks these stopped at start-up (stopOrphans).' : undefined,
      applications: apps,
      missingAttachmentFiles: missingFiles.slice(0, 20),
      problems,
    },
    null,
    2,
  ),
);
process.exit(problems.length ? 1 : 0);
