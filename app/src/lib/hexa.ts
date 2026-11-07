/** Hexa API types and calls shared by the Hexa page and its panels. */
import { http } from './session';

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

export async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await http(url, init?.body ? { ...init, headers: { 'Content-Type': 'application/json', ...((init.headers as Record<string, string> | undefined) ?? {}) } } : init);
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
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
