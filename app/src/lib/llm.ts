/**
 * Browser client for the server-side /api layer. The browser never sees the DeepSeek key, and
 * every request goes through the server's guards, so the browser cannot skip them.
 */
import type { RunRequest, WorkflowEvent } from './workflow';

export interface ModelHealth {
  configured: boolean;
  intentModel?: string;
  chatModel?: string;
  thinking?: boolean;
  host?: string;
}

let health: Promise<ModelHealth> | null = null;

/** Cached for the session; the server reads its config at start-up. */
export function getModelHealth(): Promise<ModelHealth> {
  health ??= fetch('/api/health')
    .then((r) => (r.ok ? r.json() : { model: { configured: false } }))
    .then((b: { model: ModelHealth }) => b.model)
    .catch(() => ({ configured: false }));
  return health;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function errorFrom(res: Response): Promise<ApiError> {
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  return new ApiError(body?.error ?? `Request failed (${res.status}).`, res.status);
}

/** Parses an SSE byte stream ("data: {json}" blocks) into events. Exported for tests. */
export async function* readEvents<E>(body: ReadableStream<Uint8Array>): AsyncGenerator<E> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let sep: number;
      while ((sep = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, sep);
        buf = buf.slice(sep + 2);
        for (const line of block.split('\n')) {
          if (!line.startsWith('data:')) continue;
          try {
            yield JSON.parse(line.slice(5).trim()) as E;
          } catch {
            /* ignore a malformed event */
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/** Runs one request through the server's agent workflow and yields its events. */
export async function* runWorkflow(req: RunRequest, signal?: AbortSignal): AsyncGenerator<WorkflowEvent> {
  const res = await fetch('/api/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
    signal,
  });
  if (!res.ok || !res.body) throw await errorFrom(res);
  yield* readEvents<WorkflowEvent>(res.body);
}
