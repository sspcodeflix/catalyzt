/**
 * Server start-up: open the database, load the workspace, seed from it, and import each team's
 * manual tests once. Used by the Vite plugin in dev and preview; a production server calls the
 * same function.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { seedContext } from './context';
import { openDb, seedWorkspace, type HorizonDb } from './db';
import { parseCsv, readOctaneRows } from './octane';
import { loadWorkspace, WorkspaceError, type Workspace } from './workspace';

export interface Boot {
  db: HorizonDb;
  workspace: Workspace | null;
  summary: string;
}

function findWorkspace(env: Record<string, string | undefined>): string | null {
  if (env.HORIZON_WORKSPACE) return resolve(env.HORIZON_WORKSPACE);
  for (const candidate of ['.myworkspace', '../.myworkspace']) {
    const p = resolve(candidate);
    if (existsSync(p)) return p;
  }
  return null;
}

export function bootstrap(env: Record<string, string | undefined>, log: (line: string) => void = console.log): Boot {
  const db = openDb(env.HORIZON_DB_PATH || 'data/horizon.db');
  // Anything still marked running belongs to a server that stopped; close it.
  db.stopOrphans();

  const root = findWorkspace(env);
  if (!root) {
    return { db, workspace: null, summary: 'No workspace found (set HORIZON_WORKSPACE or create .myworkspace); Horizon starts empty.' };
  }
  let workspace: Workspace | null;
  try {
    workspace = loadWorkspace(root);
  } catch (e) {
    if (e instanceof WorkspaceError) {
      log(`[horizon] workspace error: ${e.message}`);
      return { db, workspace: null, summary: `Workspace at ${root} could not be loaded: ${e.message}` };
    }
    throw e;
  }
  if (!workspace) return { db, workspace: null, summary: `No workspace at ${root}; Horizon starts empty.` };

  const counts = seedWorkspace(db, workspace);
  for (const w of workspace.warnings) log(`[horizon] workspace: ${w}`);

  // Each team's manual tests are imported once, by the team's owner.
  let manual = 0;
  for (const team of workspace.teams) {
    if (!team.manualTestsCsv) continue;
    const filename = `workspace:${team.id}/manual-tests.csv`;
    if (db.hasUpload(team.id, filename)) continue;
    const { tests, problems } = readOctaneRows(parseCsv(readFileSync(team.manualTestsCsv, 'utf8')));
    if (tests.length === 0) {
      log(`[horizon] ${team.id}/manual-tests.csv has no tests${problems[0] ? `: ${problems[0].message}` : ''}`);
      continue;
    }
    const r = db.upsertManualTests(tests, { app: team.id, origin: 'upload', purposeDefault: null, filename, format: 'csv', problems, userId: team.owner });
    manual += r.created;
    for (const p of r.problems.slice(0, 5)) log(`[horizon] ${team.id}/manual-tests.csv: ${p.message}`);
  }

  // App Context: each repository's documentation from its clone, and the Jira feed, per application.
  const ctx = seedContext(db, workspace);
  const summary = `Workspace ${root}: ${counts.apps} applications, ${counts.people} people, ${counts.components} components, ${counts.stories} new stories, ${manual} new manual tests; App Context: ${ctx.indexed} of ${ctx.repos} repositories indexed (${ctx.chunks} passages).`;
  return { db, workspace, summary };
}
