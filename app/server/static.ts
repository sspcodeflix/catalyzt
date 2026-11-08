/**
 * The standalone server's request listener: the /api middleware first, then the built front end
 * (a file under dist/, or index.html for any other GET so the single-page app routes it).
 *
 * F18: nothing a client sends may take the process down. A path that is not valid URL encoding
 * ("/%") gets 400, a rejected handler promise gets 500 (or a closed socket when headers are out),
 * and a file that disappears between stat and read gets 404. The listener never throws.
 */
import { createReadStream, existsSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, normalize } from 'node:path';

export const TYPES: Record<string, string> = {
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

type Api = (req: IncomingMessage, res: ServerResponse, next: () => void) => Promise<unknown> | unknown;

function plain(res: ServerResponse, status: number, text: string) {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.statusCode = status;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(text);
}

/** Serves one request from the built front end. `index` is the SPA entry, or null when there is no build. */
export function serveStatic(req: IncomingMessage, res: ServerResponse, staticDir: string | null, index: string | null) {
  if (!index || !staticDir || (req.method !== 'GET' && req.method !== 'HEAD')) return plain(res, 404, 'Not found');
  let pathname: string;
  try {
    pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
  } catch {
    return plain(res, 400, 'Bad request: the URL is not valid');
  }
  if (pathname.includes('\0')) return plain(res, 400, 'Bad request: the URL is not valid');
  const rel = normalize(pathname).replace(/^(\.\.[/\\])+/, '');
  const file = join(staticDir, rel);
  let isFile = false;
  try {
    isFile = file.startsWith(staticDir) && existsSync(file) && statSync(file).isFile();
  } catch {
    isFile = false;
  }
  const target = isFile ? file : index;
  const type = TYPES[extname(target).toLowerCase()] ?? 'application/octet-stream';
  res.statusCode = 200;
  res.setHeader('Content-Type', type);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // Hashed assets never change; index.html must always be revalidated.
  res.setHeader('Cache-Control', isFile && rel.includes('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache');
  if (req.method === 'HEAD') return res.end();
  const stream = createReadStream(target);
  stream.on('error', (e: NodeJS.ErrnoException) => plain(res, e.code === 'ENOENT' ? 404 : 500, e.code === 'ENOENT' ? 'Not found' : 'Internal error'));
  stream.pipe(res);
}

/**
 * Builds the listener for Node's http server: API first, the front end for the rest, and every
 * failure turned into a response instead of an exception.
 */
export function requestListener(api: Api, staticDir: string | null, log: (line: string) => void = console.error) {
  const index = staticDir && existsSync(join(staticDir, 'index.html')) ? join(staticDir, 'index.html') : null;
  return (req: IncomingMessage, res: ServerResponse) => {
    try {
      Promise.resolve(api(req, res, () => serveStatic(req, res, staticDir, index))).catch((e: unknown) => {
        log(`[catalyzt] request failed: ${e instanceof Error ? e.message : String(e)}`);
        plain(res, 500, 'Internal error');
      });
    } catch (e) {
      log(`[catalyzt] request failed: ${e instanceof Error ? e.message : String(e)}`);
      plain(res, 500, 'Internal error');
    }
  };
}

/** For the start-up warning: is there a built front end at all? */
export const hasIndex = (staticDir: string | null) => !!staticDir && existsSync(join(staticDir, 'index.html'));
