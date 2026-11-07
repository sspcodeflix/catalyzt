/**
 * Local CI runner: stands in for the repositories' CI. For each target in .myworkspace/<APP>/ci.json
 * it runs the test suite inside a Docker container for that toolchain, collects JUnit XML, works out
 * the PR number from the merge-commit subject, and delivers the results to Hexa the way CI does
 * (POST /api/hexa/results with the application, repository, commit, branch, run id and attempt).
 *
 *   cd app && ./node_modules/.bin/vite-node scripts/ci-runner.ts [options]
 *     --app IBGM           one application (default: all with a ci.json)
 *     --repo petclinic     one repository
 *     --target go          one target by name
 *     --heavy              include targets marked heavy (long installs)
 *     --attempt 2          deliver as a rerun of the same commit (default 1)
 *     --direct             write into the database directly instead of posting to the server
 *     --dry-run            print what would run, run nothing
 *     --list               list targets and exit
 *
 * Environment: HORIZON_URL (default http://127.0.0.1:5173) and HEXA_INGEST_TOKEN from app/.env for
 * delivery; HORIZON_DB_PATH for --direct. Results and logs: .myworkspace/<APP>/results/<repo>/<run>/
 * (git-ignored) and .myworkspace/<APP>/log/ci-runs.md. Caches: .myworkspace/.ci-cache/ (git-ignored).
 *
 * Containers run as the current user with the clone mounted read-write (build output lands in the
 * clone, which is git-ignored) and the results directory mounted at /out. Nothing here runs on the
 * host except git and docker.
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, appendFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

type Kind = 'go' | 'maven' | 'node-jest' | 'node-mocha' | 'python';

interface Target {
  name: string;
  kind: Kind;
  /** Path inside the clone. */
  path: string;
  /** Extra command run before the tests (inside the container, in the target path). */
  setup?: string;
  /** Override the default test command (must write JUnit XML into /out). */
  run?: string;
  image?: string;
  timeoutMinutes?: number;
  heavy?: boolean;
  env?: Record<string, string>;
  note?: string;
}
interface CiConfig {
  [repo: string]: { targets: Target[] };
}

const argv = process.argv.slice(2);
const opt = (name: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? (argv[i + 1]?.startsWith('--') ? 'true' : (argv[i + 1] ?? 'true')) : undefined;
};
const flag = (name: string) => argv.includes(`--${name}`);
const onlyApp = opt('app');
const onlyRepo = opt('repo');
const onlyTarget = opt('target');
const heavy = flag('heavy');
const direct = flag('direct');
const dryRun = flag('dry-run');
const list = flag('list');
const attempt = Math.max(1, Number(opt('attempt') ?? 1) || 1);

const root = resolve('..');
const wsRoot = process.env.HORIZON_WORKSPACE ? resolve(process.env.HORIZON_WORKSPACE) : join(root, '.myworkspace');
const cacheRoot = join(wsRoot, '.ci-cache');
mkdirSync(cacheRoot, { recursive: true });

/** KEY=VALUE from app/.env for what the environment does not set. */
function loadDotEnv() {
  const p = resolve('.env');
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !line.trim().startsWith('#') && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
loadDotEnv();

const uid = execFileSync('id', ['-u']).toString().trim();
const gid = execFileSync('id', ['-g']).toString().trim();
const git = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();

const IMAGES: Record<Kind, string> = {
  go: 'golang:1.23-bookworm',
  maven: 'maven:3.9-eclipse-temurin-17',
  'node-jest': 'node:22-bookworm',
  'node-mocha': 'node:22-bookworm',
  python: 'python:3.12-slim',
};

/** Default commands: every recipe ends with JUnit XML under /out, and never fails the container on test failures. */
function command(t: Target): string {
  const cd = `cd "/work/${t.path}"`;
  const setup = t.setup ? `${t.setup} && ` : '';
  if (t.run) return `${cd} && ${setup}${t.run}`;
  switch (t.kind) {
    case 'go':
      return `${cd} && ${setup}export GOFLAGS=-buildvcs=false && go install github.com/jstemmer/go-junit-report/v2@latest && (go test -v -count=1 ./... 2>&1 | tee /out/go-test.log | "$(go env GOPATH)/bin/go-junit-report" -set-exit-code -out /out/go.xml; echo "go test exit $?")`;
    case 'maven':
      return `${cd} && ${setup}(mvn -B -ntp -fae test -Dsurefire.printSummary=true 2>&1 | tee /out/mvn.log; echo "mvn exit $?") && find . -path '*/surefire-reports/TEST-*.xml' -exec cp {} /out/ \\;`;
    case 'node-jest':
      return `${cd} && ${setup}(npm ci --no-audit --no-fund --loglevel=error || npm install --no-audit --no-fund --loglevel=error) && npm install --no-save --no-audit --no-fund --loglevel=error jest-junit && (JEST_JUNIT_OUTPUT_DIR=/out JEST_JUNIT_OUTPUT_NAME=jest.xml npx jest --ci --reporters=default --reporters=jest-junit 2>&1 | tee /out/jest.log; echo "jest exit $?")`;
    case 'node-mocha':
      return `${cd} && ${setup}(npm ci --no-audit --no-fund --loglevel=error || npm install --no-audit --no-fund --loglevel=error) && npm install --no-save --no-audit --no-fund --loglevel=error mocha mocha-junit-reporter && (npx mocha --reporter mocha-junit-reporter --reporter-options mochaFile=/out/mocha.xml 2>&1 | tee /out/mocha.log; echo "mocha exit $?")`;
    case 'python':
      return `${cd} && ${setup}pip install --quiet --disable-pip-version-check --root-user-action=ignore -r requirements.txt pytest && (python -m pytest -q --junitxml=/out/pytest.xml 2>&1 | tee /out/pytest.log; echo "pytest exit $?")`;
  }
}

/** The PR a merge commit belongs to: squash merges "(#123)" or merge commits "Merge pull request #123". */
function prNumber(subject: string, body: string): number | null {
  const m = /\(#(\d+)\)\s*$/.exec(subject) ?? /Merge pull request #(\d+)/.exec(`${subject}\n${body}`);
  return m ? Number(m[1]) : null;
}

interface RunOutcome {
  app: string;
  repo: string;
  target: string;
  status: 'delivered' | 'no-results' | 'failed' | 'skipped' | 'dry-run';
  seconds: number;
  files: number;
  detail: string;
  ingest?: unknown;
}

async function runTarget(app: string, repo: string, github: string, cloneDir: string, t: Target): Promise<RunOutcome> {
  const started = Date.now();
  const sha = git(cloneDir, 'rev-parse', 'HEAD');
  const branch = git(cloneDir, 'rev-parse', '--abbrev-ref', 'HEAD');
  const subject = git(cloneDir, 'log', '-1', '--format=%s');
  const body = git(cloneDir, 'log', '-1', '--format=%b');
  const pr = prNumber(subject, body);
  const runId = `local-${sha.slice(0, 7)}-${t.name}`;
  const outDir = join(wsRoot, app, 'results', repo, `${runId}-a${attempt}-${new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '')}`);
  const image = t.image ?? IMAGES[t.kind];
  const cmd = command(t);
  const home = join(cacheRoot, 'home');
  mkdirSync(home, { recursive: true });
  const dockerArgs = [
    'run', '--rm', '--network', 'host',
    '--user', `${uid}:${gid}`,
    '-e', 'HOME=/tmp/home', '-e', 'GOPATH=/tmp/home/go', '-e', 'GOCACHE=/tmp/home/.cache/go-build', '-e', 'GOMODCACHE=/tmp/home/go/pkg/mod',
    '-e', 'npm_config_cache=/tmp/home/.npm', '-e', 'MAVEN_OPTS=-Dmaven.repo.local=/tmp/home/.m2/repository', '-e', 'PIP_CACHE_DIR=/tmp/home/.cache/pip', '-e', 'CI=true',
    ...Object.entries(t.env ?? {}).flatMap(([k, v]) => ['-e', `${k}=${v}`]),
    '-v', `${home}:/tmp/home`, '-v', `${cloneDir}:/work`, '-v', `${outDir}:/out`,
    '-w', '/work', image, 'bash', '-c', cmd,
  ];
  console.log(`\n== ${app}/${repo} · ${t.name} (${t.kind}, ${image}) at ${sha.slice(0, 7)} on ${branch}${pr ? `, PR #${pr}` : ', no PR in the commit subject'}`);
  if (t.note) console.log(`   note: ${t.note}`);
  if (dryRun || list) {
    console.log(`   would run: docker ${dockerArgs.slice(0, -1).join(' ')} '<command>'`);
    return { app, repo, target: t.name, status: 'dry-run', seconds: 0, files: 0, detail: cmd };
  }
  mkdirSync(outDir, { recursive: true });
  const timeoutMs = (t.timeoutMinutes ?? 20) * 60_000;
  const exit = await new Promise<number | null>((resolveExit) => {
    const child = spawn('docker', dockerArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
    const log = (chunk: Buffer) => process.stdout.write(chunk.toString().split('\n').filter(Boolean).slice(-3).map((l) => `   | ${l.slice(0, 160)}\n`).join(''));
    child.stdout.on('data', log);
    child.stderr.on('data', log);
    const timer = setTimeout(() => {
      console.log(`   timed out after ${t.timeoutMinutes ?? 20} min; stopping`);
      child.kill('SIGTERM');
    }, timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolveExit(code);
    });
  });
  const seconds = Math.round((Date.now() - started) / 1000);
  const xml = existsSync(outDir) ? readdirSync(outDir).filter((f) => f.endsWith('.xml')) : [];
  writeFileSync(join(outDir, 'run.json'), JSON.stringify({ app, repo, github, target: t, sha, branch, subject, pr, runId, attempt, image, exit, seconds, files: xml }, null, 2));
  if (xml.length === 0) {
    const detail = `container exit ${exit}, no JUnit XML produced (see ${outDir})`;
    console.log(`   ${detail}`);
    return { app, repo, target: t.name, status: exit === 0 ? 'no-results' : 'failed', seconds, files: 0, detail };
  }
  const junit = xml.map((f) => readFileSync(join(outDir, f), 'utf8'));
  const payload = { app, repo: github, sha, branch, event: 'push', runId, attempt, workflow: `local ci · ${t.name}`, runUrl: null, prNumber: pr, mergeCommit: pr !== null, junit };
  const ingest = await deliver(payload);
  console.log(`   ${xml.length} JUnit file(s) in ${seconds}s → ${JSON.stringify(ingest).slice(0, 200)}`);
  return { app, repo, target: t.name, status: 'delivered', seconds, files: xml.length, detail: `${xml.length} files`, ingest };
}

/** POSTs to the running server like CI does, or writes straight into the database with --direct. */
async function deliver(payload: Record<string, unknown>): Promise<unknown> {
  if (direct) {
    const { bootstrap } = await import('../server/bootstrap');
    const { ingestJUnit } = await import('../server/ingest');
    const boot = bootstrap(process.env as Record<string, string | undefined>, () => undefined);
    const owner = (boot.db.raw.prepare("SELECT user_id FROM memberships WHERE application_id = ? AND role = 'app_owner' LIMIT 1").get(payload.app) as { user_id: string } | undefined)?.user_id ?? boot.db.defaultUser()!.id;
    const runId = String(payload.runId);
    if (boot.db.runExists(String(payload.app), 'webhook', String(payload.repo), runId, Number(payload.attempt))) return { duplicate: true };
    const r = await ingestJUnit(
      boot.db,
      (payload.junit as string[]).map((xml, i) => ({ filename: `results-${i + 1}.xml`, xml })),
      { app: String(payload.app), source: 'webhook', repo: String(payload.repo), workflow: String(payload.workflow), externalRunId: runId, attempt: Number(payload.attempt), runUrl: null, event: 'push', branch: String(payload.branch), sha: String(payload.sha), prNumber: (payload.prNumber as number | null) ?? null, isMerge: payload.mergeCommit === true, startedAt: null },
      owner,
    );
    boot.db.raw.close();
    return r;
  }
  const url = (process.env.HORIZON_URL ?? 'http://127.0.0.1:5173').replace(/\/$/, '');
  const token = process.env.HEXA_INGEST_TOKEN;
  if (!token) throw new Error('HEXA_INGEST_TOKEN is not set (app/.env); the server would refuse the delivery.');
  const res = await fetch(`${url}/api/hexa/results`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(payload) });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error(`delivery failed: ${res.status} ${body.error ?? ''}`);
  return body;
}

async function main() {
  const apps = readdirSync(wsRoot).filter((d) => existsSync(join(wsRoot, d, 'ci.json')) && (!onlyApp || d === onlyApp));
  if (apps.length === 0) {
    console.error(`No ci.json found under ${wsRoot}${onlyApp ? ` for ${onlyApp}` : ''}.`);
    process.exit(1);
  }
  const outcomes: RunOutcome[] = [];
  for (const app of apps) {
    const team = JSON.parse(readFileSync(join(wsRoot, app, 'team.json'), 'utf8')) as { repos: { name: string; github: string }[] };
    const ci = JSON.parse(readFileSync(join(wsRoot, app, 'ci.json'), 'utf8')) as CiConfig;
    for (const [repo, cfg] of Object.entries(ci)) {
      if (repo.startsWith('_') || !Array.isArray(cfg?.targets)) continue; // "_notes" and the like
      if (onlyRepo && repo !== onlyRepo) continue;
      const github = team.repos.find((r) => r.name === repo)?.github ?? repo;
      const cloneDir = join(wsRoot, app, 'repos', repo);
      if (!existsSync(cloneDir) || !statSync(cloneDir).isDirectory()) {
        console.log(`\n== ${app}/${repo}: no clone at ${cloneDir}; skipped`);
        continue;
      }
      for (const t of cfg.targets) {
        if (onlyTarget && t.name !== onlyTarget) continue;
        if (t.heavy && !heavy && !onlyTarget) {
          console.log(`\n== ${app}/${repo} · ${t.name}: heavy, skipped (use --heavy or --target ${t.name})`);
          outcomes.push({ app, repo, target: t.name, status: 'skipped', seconds: 0, files: 0, detail: 'heavy' });
          continue;
        }
        try {
          outcomes.push(await runTarget(app, repo, github, cloneDir, t));
        } catch (e) {
          console.log(`   failed: ${(e as Error).message}`);
          outcomes.push({ app, repo, target: t.name, status: 'failed', seconds: 0, files: 0, detail: (e as Error).message });
        }
      }
    }
    if (!dryRun && !list) {
      const logPath = join(wsRoot, app, 'log', 'ci-runs.md');
      mkdirSync(join(wsRoot, app, 'log'), { recursive: true });
      if (!existsSync(logPath)) writeFileSync(logPath, '# Local CI runs\n\n| When | Repository | Target | Status | Seconds | Files | Detail |\n|---|---|---|---|---|---|---|\n');
      for (const o of outcomes.filter((x) => x.app === app)) {
        const detail = o.ingest ? JSON.stringify(o.ingest).replace(/\|/g, '/') : o.detail.replace(/\|/g, '/').slice(0, 160);
        appendFileSync(logPath, `| ${new Date().toISOString()} | ${o.repo} | ${o.target} | ${o.status} | ${o.seconds} | ${o.files} | ${detail} |\n`);
      }
    }
  }
  console.log('\nSummary');
  for (const o of outcomes) console.log(`  ${o.app}/${o.repo} · ${o.target}: ${o.status}${o.files ? ` (${o.files} files, ${o.seconds}s)` : ''}`);
  process.exit(outcomes.some((o) => o.status === 'failed') ? 1 : 0);
}

void main();
