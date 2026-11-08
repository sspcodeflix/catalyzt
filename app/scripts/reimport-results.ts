/**
 * Gives tests that CI imported before the full-suite change their package and path back, from the JUnit
 * reports the local CI runner kept under .myworkspace/<APP>/results/<repo>/<run>/. Nothing else changes:
 * no runs or results are added, ids stay the same (they hash the class and test name), and only tests
 * that came from CI are touched.
 *
 *   cd app && ./node_modules/.bin/vite-node scripts/reimport-results.ts [--apply] [--workspace ../.myworkspace]
 *
 * Without --apply it reports what it would change.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import { openDb } from '../server/db';
import { moduleOf } from '../server/ingest';
import { parseJUnit } from '../server/junit';
import { ciSuite, ciTestId } from '../server/results';

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const apply = process.argv.includes('--apply');
const ws = resolve(arg('workspace') ?? '../.myworkspace');
const db = openDb(process.env.HORIZON_DB_PATH || 'data/horizon.db');

const FRAMEWORK: Record<string, string> = { go: 'go test', maven: 'JUnit (Maven)', 'node-jest': 'Jest', 'node-mocha': 'Mocha', python: 'pytest' };
const xmlFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? xmlFiles(join(dir, e.name)) : e.name.endsWith('.xml') ? [join(dir, e.name)] : []));

const update = db.raw.prepare(
  `UPDATE test_cases SET suite = CASE WHEN ? IS NOT NULL AND (suite IS NULL OR instr(?, suite) > 0) THEN ? ELSE suite END, path = COALESCE(path, ?),
     framework = CASE WHEN framework IS NULL OR framework = 'JUnit XML' THEN COALESCE(?, framework) ELSE framework END
   WHERE id = ? AND origin = 'ci_results' AND (suite IS NOT ? OR path IS NULL OR framework IS NULL OR framework = 'JUnit XML')`,
);

let seen = 0;
let changed = 0;
const perRepo: Record<string, { cases: number; changed: number }> = {};
for (const app of readdirSync(ws)) {
  const results = join(ws, app, 'results');
  if (!existsSync(results) || !statSync(results).isDirectory()) continue;
  for (const repo of readdirSync(results)) {
    // Oldest first, so the newest report's view of a test wins.
    const runs = readdirSync(join(results, repo))
      .map((r) => join(results, repo, r))
      .filter((p) => statSync(p).isDirectory() && existsSync(join(p, 'run.json')))
      .sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs);
    for (const run of runs) {
      const meta = JSON.parse(readFileSync(join(run, 'run.json'), 'utf8')) as { github?: string; target?: { kind?: string } };
      if (!meta.github) continue;
      const framework = FRAMEWORK[meta.target?.kind ?? ''] ?? null;
      const key = `${app}/${repo}`;
      perRepo[key] ??= { cases: 0, changed: 0 };
      const tx = db.raw.transaction(() => {
        for (const file of xmlFiles(run)) {
          const module = moduleOf(relative(run, file));
          let cases;
          try {
            cases = parseJUnit(readFileSync(file, 'utf8'));
          } catch {
            continue;
          }
          for (const c of cases) {
            const id = ciTestId(app, meta.github!, c);
            const suite = ciSuite(c);
            const path = c.file ?? module;
            seen++;
            perRepo[key].cases++;
            if (!apply) {
              const row = db.raw.prepare("SELECT suite, path, framework FROM test_cases WHERE id = ? AND origin = 'ci_results'").get(id) as { suite: string | null; path: string | null; framework: string | null } | undefined;
              if (row && (row.suite !== suite || (!row.path && path) || !row.framework || row.framework === 'JUnit XML')) (changed++, perRepo[key].changed++);
              continue;
            }
            const r = update.run(suite, suite, suite, path, framework, id, suite);
            if (r.changes) (changed++, perRepo[key].changed++);
          }
        }
      });
      tx();
    }
  }
}
console.log(`${apply ? 'Updated' : 'Would update'} ${changed} test rows from ${seen} stored results.`);
for (const [k, v] of Object.entries(perRepo)) console.log(`  ${k}: ${v.cases} results, ${v.changed} ${apply ? 'updated' : 'to update'}`);
db.raw.close();
