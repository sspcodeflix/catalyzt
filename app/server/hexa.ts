/**
 * Hexa: the Repo scanner agent. Reads a public GitHub repo's test files at one commit and updates
 * the test case inventory. Runs in the background as a recorded agent (it shows on the Agents
 * page while it works). A scan that could not read everything says so and removes nothing it
 * did not see; a scan that read nothing fails instead of touching the inventory.
 */
import { randomUUID } from 'node:crypto';

import type { HorizonDb } from './db';
import { extractTests, fetchFile, GitHubError, listTestFiles, MAX_FILES, parseRepoRef, type FoundTest } from './github';

export class ScanError extends Error {}

/** Starts a scan and returns its id at once; the scan continues in the background. */
export function startRepoScan(db: HorizonDb, app: string, input: string, userId: string, token?: string): { scanId: string; repo: string } {
  const ref = parseRepoRef(input);
  if (!ref) throw new ScanError('Enter a GitHub repository as owner/repo or a github.com link.');
  const repo = `${ref.owner}/${ref.repo}`;
  if (db.runningScan(app, repo)) throw new ScanError(`${repo} is already being scanned.`);

  const scanId = randomUUID();
  const wf = randomUUID();
  const agentId = randomUUID();
  db.startWorkflow({ id: wf, app, chatId: null, messageId: null, revision: 1, userId });
  db.startAgent({ id: agentId, workflowRunId: wf, parentId: null, agent: 'Repo scanner', kind: 'tool_agent', task: `Find test cases in ${repo}${ref.ref ? `@${ref.ref}` : ''}`, model: null });
  db.startScan({ id: scanId, app, repo, ref: ref.ref ?? null, workflowRunId: wf, userId });

  const step = (label: string, tool: string) => {
    const id = randomUUID();
    db.addStep({ id, agentRunId: agentId, kind: 'tool', tool, label });
    return (status: 'done' | 'failed', detail?: string, done?: string) => db.finishStep(id, { status, detail, label: done });
  };

  void (async () => {
    let current: ((s: 'done' | 'failed', d?: string) => void) | null = null;
    try {
      current = step('Listing the repository tree', 'github.get_tree');
      const listing = await listTestFiles(ref, token);
      const toRead = listing.files.slice(0, MAX_FILES);
      // Files over the size limit stay in the inventory of listed paths (F12): a scan never treats "not read" as "gone".
      const truncated = listing.truncated || listing.files.length > MAX_FILES || listing.skipped.length > 0;
      current('done', `${listing.files.length + listing.skipped.length} test files at ${listing.sha.slice(0, 7)}${listing.files.length > MAX_FILES ? ` · reading the first ${toRead.length}` : ''}${listing.skipped.length ? ` · ${listing.skipped.length} over the size limit, not read (${listing.skipped[0].path})` : ''}${listing.truncated ? ' · the listing was cut short by GitHub' : ''}`);

      current = step(`Reading ${toRead.length} test files at ${listing.sha.slice(0, 7)}`, 'github.read_files');
      const found: (FoundTest & { path: string })[] = [];
      const readPaths: string[] = [];
      const failed: { path: string; error: string }[] = [];
      const queue = [...toRead];
      // Eight files at a time.
      await Promise.all(
        Array.from({ length: 8 }, async () => {
          for (let f = queue.shift(); f; f = queue.shift()) {
            try {
              const text = await fetchFile(ref, listing.sha, f.path, token);
              readPaths.push(f.path);
              for (const t of extractTests(f.path, text)) found.push({ ...t, path: f.path });
            } catch (e) {
              failed.push({ path: f.path, error: (e as Error).message });
            }
          }
        }),
      );
      if (toRead.length > 0 && readPaths.length === 0) {
        throw new ScanError(`None of the ${toRead.length} test files could be read (${failed[0]?.error ?? 'unknown error'}). The inventory was left as it was.`);
      }
      current('done', `${readPaths.length} of ${toRead.length} read${failed.length ? ` · ${failed.length} failed (${failed[0].path}: ${failed[0].error})` : ''}`);

      current = step('Extracting test cases', 'parse.extract_tests');
      const frameworks = [...new Set(found.map((t) => t.framework))];
      current('done', `${found.length} tests${frameworks.length ? ` · ${frameworks.join(', ')}` : ''}`);

      current = step('Updating the inventory', 'hexa.update_inventory');
      const r = db.completeScan({
        id: scanId,
        app,
        repo,
        ref: listing.ref,
        sha: listing.sha,
        htmlUrl: listing.htmlUrl,
        filesFound: listing.files.length + listing.skipped.length,
        filesScanned: readPaths.length,
        filesFailed: failed.length,
        truncated: truncated || failed.length > 0,
        readPaths,
        listedPaths: listing.truncated ? null : [...listing.files, ...listing.skipped].map((f) => f.path),
        tests: found,
        userId,
      });
      current('done', `${r.added} new · ${r.found - r.added} already known · ${r.removed} removed${r.complete ? '' : ' · partial scan: tests in files not read were kept'}`);
      current = null;

      db.finishAgent(agentId, { status: 'done', result: `${r.found} test cases in ${repo}${r.complete ? '' : ' (partial scan)'}` });
      db.finishWorkflow(wf, 'done', `Scanned ${repo}`);
    } catch (e) {
      const msg = e instanceof GitHubError || e instanceof ScanError ? e.message : `The scan failed: ${(e as Error).message}`;
      current?.('failed', msg);
      db.failScan(scanId, msg);
      db.finishAgent(agentId, { status: 'failed', error: msg });
      db.finishWorkflow(wf, 'failed', 'Scan failed');
      console.error(`[horizon hexa] scan of ${repo} failed:`, (e as Error).message);
    }
  })();

  return { scanId, repo };
}
