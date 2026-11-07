/**
 * Reads public GitHub repositories for Hexa: finds test files and extracts test cases from them.
 * Read only: Catalyzt fetches and parses text with rules, and never runs a repository's code.
 * Uses 2 GitHub API calls per scan (repo, tree); file contents come from raw.githubusercontent.com.
 * GITHUB_TOKEN, if set, raises the rate limit and allows private repos the token can read.
 */

export interface RepoRef {
  owner: string;
  repo: string;
  ref?: string;
}

export interface FoundTest {
  title: string;
  /** The function or method name in code (or the test's own title, for Jest-style tests). */
  name: string;
  /** Class, describe block or file the test sits in. */
  suite: string | null;
  framework: string;
  line: number;
}

const NAME = /^[A-Za-z0-9_.-]{1,100}$/;

/** Accepts "owner/repo", "owner/repo@branch" or a github.com URL (with /tree/branch). */
export function parseRepoRef(input: string): RepoRef | null {
  const s = input.trim().replace(/\.git$/, '');
  const url = /^https?:\/\/(?:www\.)?github\.com\/([^/\s]+)\/([^/\s#?]+)(?:\/tree\/([^\s#?]+))?\/?$/.exec(s);
  const short = /^([^/\s@]+)\/([^/\s@]+)(?:@(\S+))?$/.exec(s);
  const m = url ?? short;
  if (!m) return null;
  const [, owner, repo, ref] = m;
  if (!NAME.test(owner) || !NAME.test(repo)) return null;
  if (ref && !/^[A-Za-z0-9_./-]{1,200}$/.test(ref)) return null;
  return { owner, repo, ref: ref || undefined };
}

const SKIP_DIRS = /(^|\/)(node_modules|vendor|third_party|dist|build|out|target|\.git|\.venv|venv|site-packages|bower_components)\//;

/** Test file naming conventions across common languages and frameworks. */
export function isTestFile(path: string): boolean {
  if (SKIP_DIRS.test(path)) return false;
  const file = path.split('/').pop() ?? '';
  return (
    /\.(test|spec|e2e|cy)\.(js|jsx|ts|tsx|mjs|cjs)$/.test(file) ||
    /^test_.+\.py$/.test(file) ||
    /.+_test\.py$/.test(file) ||
    /.+_test\.go$/.test(file) ||
    /.+Tests?\.(java|kt)$/.test(file) ||
    /.+IT\.java$/.test(file) ||
    /.+Tests?\.cs$/.test(file) ||
    /.+_spec\.rb$/.test(file) ||
    (/(^|\/)(__tests__|tests?|specs?)\//.test(path) && /\.(js|jsx|ts|tsx|py|java|kt|cs|rb)$/.test(file) && !/(conftest|__init__|setup|helpers?|utils?|fixtures?)\./.test(file))
  );
}

/** "partialRefundAboveOriginalIsRejected" or "test_refund_needs_reason" -> plain words. */
export function humanize(name: string): string {
  const words = name
    .replace(/^(test_?|Test)(?=[A-Z_a-z0-9])/, '')
    .replace(/_/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .trim()
    .toLowerCase();
  return words ? words[0].toUpperCase() + words.slice(1) : name;
}

function jsFramework(content: string): string {
  if (/@playwright\/test/.test(content)) return 'Playwright';
  if (/\bcy\.(visit|get|request)\(/.test(content)) return 'Cypress';
  if (/from ['"]vitest['"]/.test(content)) return 'Vitest';
  return 'Jest/Mocha';
}

/** Extracts test cases from one file with simple rules. Good enough for an inventory, not a compiler. */
export function extractTests(path: string, content: string): FoundTest[] {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  const lines = content.split(/\r?\n/);
  const out: FoundTest[] = [];
  const file = path.split('/').pop() ?? path;

  if (['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs'].includes(ext)) {
    const fw = jsFramework(content);
    let suite: string | null = null;
    lines.forEach((l, i) => {
      const d = /\b(?:describe|context|test\.describe)(?:\.\w+)?\s*\(\s*(['"`])((?:\\.|(?!\1).)+)\1/.exec(l);
      if (d) suite = d[2];
      const t = /(?:^|[^.\w])(?:it|test)(?:\.(?:only|skip|todo|concurrent|fixme))?\s*\(\s*(['"`])((?:\\.|(?!\1).)+)\1/.exec(l);
      if (t) {
        const title = t[2].replace(/\\(['"`])/g, '$1');
        out.push({ title, name: title, suite, framework: fw, line: i + 1 });
      }
    });
  } else if (ext === 'py') {
    let suite: string | null = null;
    lines.forEach((l, i) => {
      const c = /^class\s+(Test\w*)/.exec(l);
      if (c) suite = c[1];
      else if (/^\S/.test(l)) suite = /^class\s/.test(l) ? null : suite && /^(def|async def)\s/.test(l) ? null : suite;
      const f = /^(\s*)(?:async\s+)?def\s+(test_\w+)\s*\(/.exec(l);
      if (f) out.push({ title: humanize(f[2]), name: f[2], suite: f[1] ? suite : null, framework: 'pytest', line: i + 1 });
    });
  } else if (ext === 'go') {
    lines.forEach((l, i) => {
      const f = /^func\s+(Test\w+)\s*\(\s*\w+\s+\*testing\.T\s*\)/.exec(l);
      if (f) out.push({ title: humanize(f[1]), name: f[1], suite: file, framework: 'go test', line: i + 1 });
    });
  } else if (ext === 'java' || ext === 'kt') {
    let suite: string | null = null;
    let pending: number | null = null;
    let display: string | null = null;
    lines.forEach((l, i) => {
      const c = /\bclass\s+(\w+)/.exec(l);
      if (c && pending === null) suite = c[1];
      if (/@(Test|ParameterizedTest|RepeatedTest|TestFactory)\b/.test(l)) pending = i;
      const dn = /@DisplayName\(\s*"((?:\\.|[^"])*)"\s*\)/.exec(l);
      if (dn) display = dn[1];
      if (pending !== null) {
        const m = /\b(?:void|fun|Unit)\s+`?([\w ]+?)`?\s*\(/.exec(l) ?? /\bfun\s+`([^`]+)`\s*\(/.exec(l);
        if (m) {
          out.push({ title: display ?? (m[1].includes(' ') ? m[1] : humanize(m[1])), name: m[1], suite, framework: ext === 'kt' ? 'JUnit (Kotlin)' : 'JUnit', line: i + 1 });
          pending = null;
          display = null;
        } else if (i - pending > 6) {
          pending = null;
          display = null;
        }
      }
    });
  } else if (ext === 'cs') {
    let suite: string | null = null;
    let pending = false;
    lines.forEach((l, i) => {
      const c = /\bclass\s+(\w+)/.exec(l);
      if (c) suite = c[1];
      if (/\[(Fact|Theory|Test|TestMethod|TestCase)\b/.test(l)) pending = true;
      const m = pending && /\b(?:public|private|internal)\s+(?:async\s+)?[\w<>]+\s+(\w+)\s*\(/.exec(l);
      if (m) {
        out.push({ title: humanize(m[1]), name: m[1], suite, framework: '.NET', line: i + 1 });
        pending = false;
      }
    });
  } else if (ext === 'rb') {
    let suite: string | null = null;
    lines.forEach((l, i) => {
      const d = /^\s*(?:RSpec\.)?(?:describe|context)\s+['"]?([^'"]+?)['"]?\s+do/.exec(l);
      if (d) suite = d[1];
      const t = /^\s*it\s+(['"])(.+?)\1/.exec(l);
      if (t) out.push({ title: t[2], name: t[2], suite, framework: 'RSpec', line: i + 1 });
    });
  }
  return out;
}

export class GitHubError extends Error {}

/** A scan reads at most this many test files; the listing says how many there are. */
export const MAX_FILES = 200;
const MAX_BYTES = 256 * 1024;

function headers(token?: string): Record<string, string> {
  return {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'horizon-hexa',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

async function gh<T>(url: string, token: string | undefined, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, { headers: headers(token), signal: signal ?? AbortSignal.timeout(20_000) });
  if (res.status === 404) throw new GitHubError('Repository or branch not found, or it is private.');
  if (res.status === 403 || res.status === 429) {
    const reset = res.headers.get('x-ratelimit-reset');
    const when = reset ? ` Try again after ${new Date(Number(reset) * 1000).toLocaleTimeString()}.` : '';
    throw new GitHubError(`GitHub rate limit reached.${when} Set GITHUB_TOKEN on the server to raise it.`);
  }
  if (!res.ok) throw new GitHubError(`GitHub returned ${res.status}.`);
  return (await res.json()) as T;
}

export interface RepoTestFiles {
  ref: string;
  /** The commit the scan is pinned to. Files are read at this commit, and links point at it. */
  sha: string;
  treeSha: string;
  htmlUrl: string;
  /** Every test file in the tree (the caller decides how many to read). */
  files: { path: string; size: number }[];
  /** True when GitHub cut the tree listing short, so `files` is not the whole repository. */
  truncated: boolean;
}

/**
 * Lists a repo's test files at one commit (3 API calls: repository, commit, tree). The ref is
 * resolved to a commit first: the trees API answers with a tree SHA, which raw.githubusercontent.com
 * cannot serve, so reads and links must use the commit SHA.
 */
export async function listTestFiles(r: RepoRef, token?: string, signal?: AbortSignal): Promise<RepoTestFiles> {
  const meta = await gh<{ default_branch: string; html_url: string; private: boolean }>(`https://api.github.com/repos/${r.owner}/${r.repo}`, token, signal);
  const ref = r.ref ?? meta.default_branch;
  const commit = await gh<{ sha: string; commit: { tree: { sha: string } } }>(`https://api.github.com/repos/${r.owner}/${r.repo}/commits/${encodeURIComponent(ref)}`, token, signal);
  if (!/^[0-9a-f]{40}$/i.test(commit.sha) || !commit.commit?.tree?.sha) throw new GitHubError(`GitHub did not return a commit for ${ref}.`);
  const tree = await gh<{ sha: string; truncated: boolean; tree: { path: string; type: string; size?: number }[] }>(
    `https://api.github.com/repos/${r.owner}/${r.repo}/git/trees/${commit.commit.tree.sha}?recursive=1`,
    token,
    signal,
  );
  const files = tree.tree.filter((t) => t.type === 'blob' && isTestFile(t.path) && (t.size ?? 0) <= MAX_BYTES).map((t) => ({ path: t.path, size: t.size ?? 0 }));
  return { ref, sha: commit.sha, treeSha: tree.sha, htmlUrl: meta.html_url, files, truncated: !!tree.truncated };
}

/** Fetches one file's text at a commit. */
export async function fetchFile(r: RepoRef, sha: string, path: string, token?: string, signal?: AbortSignal): Promise<string> {
  const url = `https://raw.githubusercontent.com/${r.owner}/${r.repo}/${sha}/${path.split('/').map(encodeURIComponent).join('/')}`;
  const res = await fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : {}, signal: signal ?? AbortSignal.timeout(20_000) });
  if (!res.ok) throw new GitHubError(`Could not read ${path} (${res.status}).`);
  const text = await res.text();
  return text.length > MAX_BYTES ? text.slice(0, MAX_BYTES) : text;
}
