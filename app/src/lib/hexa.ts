/** Hexa API types and calls shared by the Hexa page and its panels. */
import { http, sessionEpoch, StaleScopeError } from './session';

export interface TestRow {
  id: string;
  title: string;
  suite: string | null;
  kind: 'automated' | 'manual' | 'proposed';
  framework: string | null;
  origin: 'repo_scan' | 'uat_analyst' | 'authoring' | 'manual' | 'upload' | 'ci_results';
  repo: string | null;
  path: string | null;
  line: number | null;
  url: string | null;
  lastResult: 'passed' | 'failed' | 'skipped' | 'not_run' | null;
  lastRunAt: string | null;
  purpose: 'uat' | 'regression' | null;
  externalId: string | null;
  phase: string | null;
  owner: string | null;
  steps: number;
  updatedAt: string;
  links: { type: string; ref: string }[];
}

export interface ScanRow {
  id: string;
  repo: string;
  ref: string | null;
  status: 'running' | 'done' | 'failed';
  filesScanned: number | null;
  testsFound: number | null;
  testsNew: number | null;
  testsRemoved: number | null;
  truncated: boolean;
  filesFailed: number | null;
  /** False for a partial scan (unread files, or a listing GitHub cut short): nothing unread was removed. */
  complete: boolean | null;
  error: string | null;
  startedBy: string;
  startedAt: string;
}

export interface UploadRow {
  id: string;
  kind: string;
  filename: string;
  created: number;
  updated: number;
  problems: { row: number; message: string }[];
  by: string;
  at: string;
}

export interface HexaStats {
  total: number;
  byKind: { key: string; n: number }[];
  byResult: { key: string; n: number }[];
  byPurpose: { key: string; n: number }[];
  runs: number;
  storiesWithoutTests: number;
}

export interface TestsResponse {
  rows: TestRow[];
  total: number;
  stats: HexaStats;
  scans: ScanRow[];
  uploads: UploadRow[];
}

export interface RunRow {
  id: string;
  source: 'github_actions' | 'webhook' | 'upload';
  repo: string | null;
  workflow: string | null;
  runUrl: string | null;
  branch: string | null;
  sha: string | null;
  prNumber: number | null;
  attempt: number;
  isMerge: boolean;
  status: 'passed' | 'failed';
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  durationMs: number | null;
  at: string;
  by: string | null;
  failures: { id: string; title: string; message: string | null }[];
}

/** A test's link to a story, criterion ("IBGM-1005#AC1"), requirement or component ("IBGM/account-service"). */
export type TestLink = { type: string; ref: string };

/** A link as people read it: "IBGM-1005 AC1", "IBGM-1005", "account-service". */
export const linkLabel = (l: TestLink) => (l.type === 'criterion' ? l.ref.replace('#', ' ') : l.type === 'component' ? l.ref.replace(/^[^/]+\//, '') : l.ref);

/** The links in `after` that were not in `before`: what one press of Link added (a criterion brings its story), so undo removes exactly that (R08). */
export const addedLinks = (before: TestLink[], after: TestLink[]) => after.filter((a) => !before.some((b) => b.type === a.type && b.ref === a.ref));

/**
 * The line under "Pipeline runs" that says where the listed runs came from (R11): pushed by CI,
 * collected from GitHub Actions merge-commit runs, uploaded. Only the sources present are named, so
 * a list of locally pushed runs is never described as GitHub Actions merges.
 */
export function runSources(runs: Pick<RunRow, 'source'>[]): string {
  if (!runs.length) return 'No runs yet';
  const n = (s: RunRow['source']) => runs.filter((r) => r.source === s).length;
  const parts = [
    [n('webhook'), 'pushed by CI'],
    [n('github_actions'), 'collected from GitHub Actions (merge-commit runs on the default branch)'],
    [n('upload'), 'uploaded'],
  ]
    .filter(([k]) => Number(k) > 0)
    .map(([k, w]) => `${k} ${w}`);
  return `${runs.length} run${runs.length === 1 ? '' : 's'}: ${parts.join(', ')}`;
}

export interface TestDetail {
  id: string;
  title: string;
  kind: string;
  purpose: 'uat' | 'regression' | null;
  origin: string;
  status: string;
  suite: string | null;
  codeName: string | null;
  framework: string | null;
  repo: string | null;
  path: string | null;
  line: number | null;
  url: string | null;
  lastResult: string | null;
  lastRunAt: string | null;
  externalId: string | null;
  description: string | null;
  testType: string | null;
  phase: string | null;
  owner: string | null;
  designer: string | null;
  productAreas: string | null;
  applicationModules: string | null;
  userTags: string | null;
  estimatedMinutes: number | null;
  createdAt: string;
  updatedAt: string;
  steps: { seq: number; type: 'simple' | 'validation' | 'call'; description: string }[];
  links: { type: string; ref: string }[];
  history: {
    status: 'passed' | 'failed' | 'skipped';
    durationMs: number | null;
    message: string | null;
    runId: string;
    source: string;
    workflow: string | null;
    runUrl: string | null;
    branch: string | null;
    sha: string | null;
    prNumber: number | null;
    isMerge: boolean;
    at: string;
  }[];
}

/** Calls the API for the current person and application; a response for an earlier one is a StaleScopeError, which pages ignore. */
export async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const epoch = sessionEpoch();
  const res = await http(url, init?.body ? { ...init, headers: { 'Content-Type': 'application/json', ...((init.headers as Record<string, string> | undefined) ?? {}) } } : init);
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (epoch !== sessionEpoch()) throw new StaleScopeError();
  if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status}).`);
  return body;
}

/** Tells the Hexa page to reload after an upload or sync in a panel. */
export const hexaChanged = () => window.dispatchEvent(new Event('hexa:changed'));

export const fileToBase64 = (f: File) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] ?? '');
    r.onerror = () => reject(r.error ?? new Error('Could not read the file.'));
    r.readAsDataURL(f);
  });

export const RESULT: Record<string, { cls: string; label: string }> = {
  passed: { cls: 'pass', label: 'Passed' },
  failed: { cls: 'crit', label: 'Failed' },
  skipped: { cls: '', label: 'Skipped' },
  not_run: { cls: 'info', label: 'Not run' },
};

export const ORIGIN: Record<string, string> = {
  repo_scan: 'Repo scan',
  uat_analyst: 'UAT analyst',
  authoring: 'Authoring agent',
  manual: 'Added by hand',
  upload: 'Uploaded',
  ci_results: 'First seen in CI',
};

export const PURPOSE: Record<string, string> = { uat: 'UAT', regression: 'Regression' };
