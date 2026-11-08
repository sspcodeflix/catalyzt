/**
 * F18: the standalone server's listener answers every request, including ones that are not valid
 * URL encoding or that make a handler fail, and keeps serving afterwards.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createApi } from './api';
import { fixtureDb } from './fixture';
import { requestListener } from './static';

const servers: Server[] = [];
afterEach(() => servers.splice(0).forEach((s) => s.close()));

async function listen(listener: Parameters<typeof createServer>[1]) {
  const server = createServer(listener);
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return (path: string, init?: RequestInit) => fetch(`http://127.0.0.1:${port}${path}`, init);
}

function build() {
  const dir = mkdtempSync(join(tmpdir(), 'catalyzt-static-'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>Catalyzt</title><div id="root"></div>');
  mkdirSync(join(dir, 'assets'));
  writeFileSync(join(dir, 'assets', 'app-abc123.js'), 'console.log("built")');
  return dir;
}

describe('F18: the request listener never lets a request take the process down', () => {
  it('answers a malformed path with 400 and the next requests normally', async () => {
    const dir = build();
    const api = createApi(() => null, () => fixtureDb(), { identity: { mode: 'dev-picker' } });
    const get = await listen(requestListener(api, dir, () => {}));
    // "%" alone is not valid percent-encoding: decodeURIComponent throws URIError.
    const bad = await get('/%');
    expect(bad.status).toBe(400);
    expect(await bad.text()).toContain('not valid');
    expect((await get('/%E0%A4%A')).status).toBe(400);
    // The process is still here and serves the API, the built file and the single-page fallback.
    expect((await get('/api/health')).status).toBe(200);
    const asset = await get('/assets/app-abc123.js');
    expect(asset.status).toBe(200);
    expect(asset.headers.get('cache-control')).toContain('immutable');
    expect(asset.headers.get('content-type')).toContain('javascript');
    const route = await get('/chat/c1');
    expect(route.status).toBe(200);
    expect(await route.text()).toContain('Catalyzt');
    expect(route.headers.get('cache-control')).toBe('no-cache');
    // Escaping the build directory is not possible; the single-page app answers instead.
    expect(await (await get('/..%2F..%2Fetc%2Fpasswd')).text()).toContain('Catalyzt');
    expect((await get('/x', { method: 'POST' })).status).toBe(404);
  });

  it('turns a failing handler into a 500 instead of an unhandled rejection, and a missing build into 404', async () => {
    const get = await listen(requestListener(async () => { throw new Error('boom'); }, build(), () => {}));
    expect((await get('/api/health')).status).toBe(500);
    expect((await get('/api/health')).status).toBe(500);
    const noBuild = await listen(requestListener(async (_req, _res, next) => next(), null, () => {}));
    expect((await noBuild('/anything')).status).toBe(404);
  });
});
