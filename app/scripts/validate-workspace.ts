/**
 * Checks a workspace the way the server will load it: team.json files, personas, stories and
 * manual-tests.csv files. Prints what it found and every warning or problem; exits 1 on a fatal error.
 *
 *   cd app && npx vite-node scripts/validate-workspace.ts [path to .myworkspace]
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { parseCsv, readOctaneRows } from '../server/octane';
import { loadWorkspace, WorkspaceError } from '../server/workspace';

const root = resolve(process.argv[2] ?? '../.myworkspace');
try {
  const ws = loadWorkspace(root);
  if (!ws) {
    console.error(`No workspace at ${root}`);
    process.exit(1);
  }
  console.log(`Workspace ${root}: ${ws.teams.length} applications, ${ws.people.length} people`);
  for (const t of ws.teams) {
    const keys = new Set<string>();
    let dup = 0;
    for (const s of t.stories) if (s.key) (keys.has(s.key) ? dup++ : keys.add(s.key));
    console.log(`  ${t.id} (${t.name}): ${t.components.length} components, ${t.stories.length} stories${dup ? ` (${dup} duplicate keys!)` : ''}, manual tests: ${t.manualTestsCsv ? 'yes' : 'no'}`);
    const wrongKey = t.stories.filter((s) => s.key && !s.key.startsWith(`${t.jiraProject}-`));
    for (const s of wrongKey) console.log(`    WARNING story key "${s.key}" does not start with ${t.jiraProject}-`);
    if (t.manualTestsCsv) {
      const { tests, problems } = readOctaneRows(parseCsv(readFileSync(t.manualTestsCsv, 'utf8')));
      console.log(`    manual-tests.csv: ${tests.length} tests, ${tests.reduce((a, x) => a + x.steps.length, 0)} steps, purposes ${JSON.stringify(Object.fromEntries(['uat', 'regression', 'none'].map((k) => [k, tests.filter((x) => (x.purpose ?? 'none') === k).length])))}`);
      for (const p of problems) console.log(`    PROBLEM row ${p.row}: ${p.message}`);
      for (const x of tests) for (const c of x.covers) {
        const key = c.split('#')[0];
        if (/^[A-Z][A-Z0-9]+-\d+$/.test(key) && !keys.has(key)) console.log(`    WARNING "${x.name}" covers ${c}, but no story ${key} is in stories.json`);
        if (!/^[A-Z][A-Z0-9]+-\d+(#AC\d+)?$/.test(c) && !/^N?FR-\d+$/.test(c) && !t.components.some((k) => k.name === c)) console.log(`    WARNING "${x.name}" covers "${c}", which is not a story, criterion, requirement or component`);
      }
    }
  }
  for (const w of ws.warnings) console.log(`  WARNING ${w}`);
  console.log(ws.warnings.length ? `${ws.warnings.length} warnings` : 'No warnings');
} catch (e) {
  console.error(e instanceof WorkspaceError ? `Workspace error: ${e.message}` : e);
  process.exit(1);
}
