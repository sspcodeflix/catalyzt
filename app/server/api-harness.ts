/**
 * Runs the /api middleware on a real HTTP server for tests, so routes are exercised exactly as the
 * browser and CI reach them: headers, status codes, JSON bodies and the SSE stream of /api/run.
 * Test helper only; not part of the server.
 */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { WorkflowEvent } from '../src/lib/workflow';
import { createApi, type ApiOptions } from './api';
import type { HorizonDb } from './db';
import type { DeepSeekConfig } from './deepseek';

export interface ApiClient {
  get(path: string): Promise<Response>;
  post(path: string, body?: unknown, headers?: Record<string, string>): Promise<Response>;
  put(path: string, body?: unknown): Promise<Response>;
  /** POST /api/run and collect every event. Throws with the status when the request itself is refused. */
  run(body: Record<string, unknown>): Promise<WorkflowEvent[]>;
}

export interface TestApi {
  url: string;
  /** A client that sends the x-horizon-user and x-horizon-app headers. */
  as(user: string, app?: string): ApiClient;
  /** A client with no session headers (CI webhooks, health). */
  anonymous(): ApiClient;
  close(): Promise<void>;
}

/** Parses "data: {json}\n\n" blocks from a fetch body. */
export async function readSse<E>(body: ReadableStream<Uint8Array>): Promise<E[]> {
  const out: E[] = [];
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let sep: number;
    while ((sep = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, sep);
      buf = buf.slice(sep + 2);
      for (const line of block.split('\n')) if (line.startsWith('data:')) out.push(JSON.parse(line.slice(5).trim()) as E);
    }
  }
  return out;
}

export class RunRefused extends Error {
  constructor(
    readonly status: number,
    readonly body: { error?: string } | null,
  ) {
    super(`run refused with ${status}: ${body?.error ?? ''}`);
  }
}

export async function startApi(db: HorizonDb, cfg: DeepSeekConfig | null = null, opts: ApiOptions = {}): Promise<TestApi> {
  const api = createApi(() => cfg, () => db, opts);
  const server = createServer((req, res) => {
    void api(req, res, () => {
      res.statusCode = 404;
      res.end('not an api route');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}`;

  const client = (session: Record<string, string>): ApiClient => {
    const call = (path: string, init: RequestInit = {}, headers: Record<string, string> = {}) =>
      fetch(url + path, { ...init, headers: { ...session, 'Content-Type': 'application/json', ...headers } });
    return {
      get: (path) => call(path),
      post: (path, body, headers) => call(path, { method: 'POST', body: JSON.stringify(body ?? {}) }, headers),
      put: (path, body) => call(path, { method: 'PUT', body: JSON.stringify(body ?? {}) }),
      async run(body) {
        const res = await call('/api/run', { method: 'POST', body: JSON.stringify(body) });
        if (!res.ok || !res.body) throw new RunRefused(res.status, (await res.json().catch(() => null)) as { error?: string } | null);
        return readSse<WorkflowEvent>(res.body);
      },
    };
  };

  return {
    url,
    as: (user, app) => client({ 'x-horizon-user': user, ...(app ? { 'x-horizon-app': app } : {}) }),
    anonymous: () => client({}),
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
