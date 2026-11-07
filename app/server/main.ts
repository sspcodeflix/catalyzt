/**
 * The standalone API server: Node's http, the same /api middleware the Vite dev server mounts,
 * and the built front end from dist/. No Vite at runtime.
 *
 *   npm run build && npm run build:api && npm start
 *
 * Environment (also read from ./.env when present, without overriding real environment variables):
 *   HORIZON_PORT             default 8787
 *   HORIZON_HOST             default 127.0.0.1 (put a TLS/sign-in proxy in front; do not expose directly)
 *   HORIZON_DB_PATH          default data/horizon.db        persistent local disk, same host, never a network share
 *   HORIZON_FILES_DIR        default data/attachments       original uploads
 *   HORIZON_WORKSPACE        default .myworkspace or ../.myworkspace
 *   HORIZON_STATIC           default dist                   the built front end; set to "" to serve the API only
 *   HORIZON_IDENTITY_HEADER  the header the sign-in proxy sets with the signed-in email (e.g. x-forwarded-email)
 *   HORIZON_DEV_IDENTITY=1   instead of a header: trust the browser's "Sign in as" picker (development only)
 *   DEEPSEEK_API_KEY, DEEPSEEK_MODEL, GITHUB_TOKEN, HEXA_INGEST_TOKEN, HEXA_INGEST_TOKEN_<APP>
 *
 * One process, one SQLite file: this is a single-host deployment. Run one instance per database.
 */
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';

import { createApi, ingestTokensFromEnv, type Identity } from './api';
import { bootstrap } from './bootstrap';
import { configFromEnv } from './deepseek';
import { LocalBlobStore } from './storage';

/** KEY=VALUE lines from ./.env, for values not already in the environment. */
function loadDotEnv(env: NodeJS.ProcessEnv) {
  const p = resolve('.env');
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (env[m[1]] === undefined) env[m[1]] = v;
  }
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json',
};

export function startServer(env: NodeJS.ProcessEnv = process.env) {
  loadDotEnv(env);
  const port = Number(env.HORIZON_PORT ?? 8787);
  const host = env.HORIZON_HOST ?? '127.0.0.1';
  const staticDir = env.HORIZON_STATIC === undefined ? resolve('dist') : env.HORIZON_STATIC.trim() ? resolve(env.HORIZON_STATIC) : null;

  let identity: Identity;
  if (env.HORIZON_IDENTITY_HEADER?.trim()) identity = { mode: 'proxy-header', header: env.HORIZON_IDENTITY_HEADER.trim() };
  else if (env.HORIZON_DEV_IDENTITY === '1') identity = { mode: 'dev-picker' };
  else {
    console.error('Refusing to start without an identity source. Set HORIZON_IDENTITY_HEADER to the header your sign-in proxy sets (for example x-forwarded-email), or HORIZON_DEV_IDENTITY=1 for the development picker.');
    process.exit(2);
  }

  const boot = bootstrap(env as Record<string, string | undefined>);
  console.log(`Horizon: ${boot.summary}`);
  const cfg = configFromEnv(env as Record<string, string>);
  const api = createApi(() => cfg, () => boot.db, {
    identity,
    githubToken: env.GITHUB_TOKEN?.trim() || undefined,
    ingestToken: env.HEXA_INGEST_TOKEN?.trim() || undefined,
    ingestTokens: ingestTokensFromEnv(env as Record<string, string | undefined>),
    files: new LocalBlobStore(env.HORIZON_FILES_DIR?.trim() || 'data/attachments'),
    getWorkspace: () => boot.workspace,
  });

  const index = staticDir && existsSync(join(staticDir, 'index.html')) ? join(staticDir, 'index.html') : null;
  if (staticDir && !index) console.warn(`No built front end at ${staticDir} (run "npm run build"); serving the API only.`);

  const server = createServer((req, res) => {
    void api(req, res, () => {
      // Not an API route: a built file, or the single-page app for any other GET.
      if (!index || !staticDir || (req.method !== 'GET' && req.method !== 'HEAD')) {
        res.statusCode = 404;
        res.end('Not found');
        return;
      }
      const url = new URL(req.url ?? '/', 'http://x');
      const rel = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
      const file = join(staticDir, rel);
      const inside = file.startsWith(staticDir);
      const isFile = inside && existsSync(file) && statSync(file).isFile();
      const target = isFile ? file : index;
      const type = TYPES[extname(target).toLowerCase()] ?? 'application/octet-stream';
      res.statusCode = 200;
      res.setHeader('Content-Type', type);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      // Hashed assets never change; index.html must always be revalidated.
      res.setHeader('Cache-Control', isFile && rel.includes('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache');
      if (req.method === 'HEAD') return res.end();
      createReadStream(target).pipe(res);
    });
  });

  server.listen(port, host, () => {
    console.log(`Horizon API listening on http://${host}:${port} (identity: ${identity.mode}${identity.mode === 'proxy-header' ? ` via ${identity.header}` : ''}; database ${env.HORIZON_DB_PATH || 'data/horizon.db'})`);
  });

  // Stop taking requests, checkpoint the WAL into the main file, close.
  const shutdown = (signal: string) => {
    console.log(`${signal}: shutting down`);
    server.close(() => {
      try {
        boot.db.raw.pragma('wal_checkpoint(TRUNCATE)');
        boot.db.raw.close();
      } finally {
        process.exit(0);
      }
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  return server;
}

startServer();
