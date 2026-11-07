/**
 * Hexa: the Repo scanner agent. Reads a public GitHub repo's test files and updates the test case
 * inventory. Runs in the background as a recorded agent (it shows on the Agents page while it works).
 */
import { randomUUID } from 'node:crypto';

import type { HorizonDb } from './db';
import { extractTests, fetchFile, GitHubError, listTestFiles, parseRepoRef, type FoundTest } from './github';

export class ScanError extends Error {}

/** Starts a scan and returns its id at once; the scan continues in the background. */
export function startRepoScan(db: HorizonDb, input: string, userId: string, token?: string): { scanId: string; repo: string } {
  const ref = parseRepoRef(input);
  if (!ref) throw new ScanError('Enter a GitHub repository as owner/repo or a github.com link.');
  const repo = `${ref.owner}/${ref.repo}`;
  if (db.runningScan(repo)) throw new ScanError(`${repo} is already being scanned.`);

  const scanId = randomUUID();
  const wf = randomUUID();
  const agentId = randomUUID();
  db.startWorkflow({ id: wf, chatId: null, messageId: null, revision: 1, userId });
  db.startAgent({ id: agentId, workflowRunId: wf, parentId: null, agent: 'Repo scanner', kind: 'tool_agent', task: `Find test cases in ${repo}${ref.ref ? `@${ref.ref}` : ''}`, model: null });
  db.startScan({ id: scanId, repo, ref: ref.ref ?? null, workflowRunId: wf, userId });

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
      current('done', `${listing.totalFiles} test files at ${listing.sha.slice(0, 7)}${listing.truncated ? ` · reading the first ${listing.files.length}` : ''}`);

      current = step(`Reading ${listing.files.length} test files`, 'github.read_files');
      const found: (FoundTest & { path: string })[] = [];
      let read = 0;
      const queue = [...listing.files];
      // Eight files at a time.
      await Promise.all(
        Array.from({ length: 8 }, async () => {
          for (let f = queue.shift(); f; f = queue.shift()) {
            try {
              const text = await fetchFile(ref, listing.sha, f.path, token);
              read++;
              for (const t of extractTests(f.path, text)) found.push({ ...t, path: f.path });
            } catch {
              /* skip a file that cannot be read */
            }
          }
        }),
      );
      current('done', `${read} of ${listing.files.length} read`);

      current = step('Extracting test cases', 'parse.extract_tests');
      const frameworks = [...new Set(found.map((t) => t.framework))];
      current('done', `${found.length} tests${frameworks.length ? ` · ${frameworks.join(', ')}` : ''}`);

      current = step('Updating the inventory', 'hexa.update_inventory');
      const r = db.completeScan({ id: scanId, repo, ref: listing.ref, sha: listing.sha, htmlUrl: listing.htmlUrl, filesFound: listing.totalFiles, filesScanned: read, truncated: listing.truncated, tests: found, userId });
      current('done', `${r.added} new · ${r.found - r.added} already known · ${r.removed} removed`);
      current = null;

      db.finishAgent(agentId, { status: 'done', result: `${r.found} test cases in ${repo}` });
      db.finishWorkflow(wf, 'done', `Scanned ${repo}`);
    } catch (e) {
      const msg = e instanceof GitHubError ? e.message : `The scan failed: ${(e as Error).message}`;
      current?.('failed', msg);
      db.failScan(scanId, msg);
      db.finishAgent(agentId, { status: 'failed', error: msg });
      db.finishWorkflow(wf, 'failed', 'Scan failed');
      console.error(`[horizon hexa] scan of ${repo} failed:`, (e as Error).message);
    }
  })();

  return { scanId, repo };
}
