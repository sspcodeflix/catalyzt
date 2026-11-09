/**
 * Minimal DeepSeek client (OpenAI-compatible Chat Completions). Runs only on the server, where the
 * API key lives. The base URL is configurable, so the same code works with a self-hosted
 * OpenAI-compatible endpoint (for example DeepSeek weights served by vLLM).
 */

export interface DeepSeekConfig {
  apiKey: string;
  baseUrl: string;
  intentModel: string;
  chatModel: string;
  /** Thinking mode for answers. Intent classification never uses it. */
  thinking: boolean;
  timeoutMs: number;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export class DeepSeekError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** Safe to show to the user. */
    readonly userMessage: string,
  ) {
    super(message);
  }
}

export function configFromEnv(env: Record<string, string | undefined>): DeepSeekConfig | null {
  const apiKey = env.DEEPSEEK_API_KEY?.trim();
  if (!apiKey) return null;
  return {
    apiKey,
    baseUrl: (env.DEEPSEEK_BASE_URL?.trim() || 'https://api.deepseek.com').replace(/\/+$/, ''),
    // DEEPSEEK_MODEL sets both; the two specific variables override it.
    intentModel: env.DEEPSEEK_INTENT_MODEL?.trim() || env.DEEPSEEK_MODEL?.trim() || 'deepseek-flash',
    chatModel: env.DEEPSEEK_CHAT_MODEL?.trim() || env.DEEPSEEK_MODEL?.trim() || 'deepseek-flash',
    thinking: env.DEEPSEEK_THINKING?.trim() === 'on',
    timeoutMs: Number(env.DEEPSEEK_TIMEOUT_MS) || 60_000,
  };
}

const userMessageFor = (status: number) =>
  status === 401 || status === 403
    ? 'The DeepSeek API key was rejected. Check DEEPSEEK_API_KEY on the server.'
    : status === 402
      ? 'The DeepSeek account has no balance left.'
      : status === 429
        ? 'DeepSeek is rate limiting requests. Try again in a moment.'
        : status >= 500
          ? 'DeepSeek is unavailable right now. Try again in a moment.'
          : 'DeepSeek could not handle this request.';

async function post(cfg: DeepSeekConfig, body: object, signal?: AbortSignal): Promise<Response> {
  const timeout = AbortSignal.timeout(cfg.timeoutMs);
  let res: Response;
  try {
    res = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  } catch (e) {
    if (signal?.aborted) throw e;
    throw new DeepSeekError(`DeepSeek request failed: ${(e as Error).message}`, 504, 'Could not reach DeepSeek.');
  }
  if (!res.ok) {
    // Log the body server-side only; it can contain account details.
    const detail = await res.text().catch(() => '');
    throw new DeepSeekError(`DeepSeek ${res.status}: ${detail.slice(0, 500)}`, res.status, userMessageFor(res.status));
  }
  return res;
}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
}

/**
 * One JSON-mode completion with thinking off. Returns the parsed object, or null if the model
 * gave no valid JSON. `onUsage` receives the token counts, for the usage ledger.
 */
export async function completeJson(cfg: DeepSeekConfig, messages: ChatMessage[], signal?: AbortSignal, onUsage?: (u: Usage) => void, maxTokens = 600): Promise<unknown> {
  const res = await post(
    cfg,
    {
      model: cfg.intentModel,
      messages,
      response_format: { type: 'json_object' },
      thinking: { type: 'disabled' },
      temperature: 0,
      // Short answers by default (intent, refinement); a caller that expects a long document says so.
      max_tokens: maxTokens,
    },
    signal,
  );
  const data = (await res.json()) as { choices?: { message?: { content?: string } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } };
  // Only report usage the provider gave; missing usage is recorded as unknown, not zero.
  if (data.usage) onUsage?.({ promptTokens: data.usage.prompt_tokens ?? 0, completionTokens: data.usage.completion_tokens ?? 0 });
  const content = data.choices?.[0]?.message?.content?.trim();
  // In JSON mode, invalid output comes back as whitespace.
  if (!content) return null;
  try {
    return JSON.parse(content);
  } catch {
    return null;
  }
}

export type StreamEvent =
  | { type: 'reasoning'; text: string }
  | { type: 'text'; text: string }
  | { type: 'usage'; promptTokens: number; completionTokens: number };

/** Parses one SSE "data:" payload from the Chat Completions stream. */
export function parseChunk(payload: string): StreamEvent[] {
  if (payload === '[DONE]') return [];
  let chunk: {
    choices?: { delta?: { content?: string | null; reasoning_content?: string | null } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
  };
  try {
    chunk = JSON.parse(payload);
  } catch {
    return [];
  }
  const out: StreamEvent[] = [];
  const delta = chunk.choices?.[0]?.delta;
  if (delta?.reasoning_content) out.push({ type: 'reasoning', text: delta.reasoning_content });
  if (delta?.content) out.push({ type: 'text', text: delta.content });
  if (chunk.usage) {
    out.push({ type: 'usage', promptTokens: chunk.usage.prompt_tokens ?? 0, completionTokens: chunk.usage.completion_tokens ?? 0 });
  }
  return out;
}

/** Splits a text stream into SSE data payloads, handling lines split across reads. */
export async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, '');
        buf = buf.slice(nl + 1);
        if (line.startsWith('data:')) yield line.slice(5).trim();
      }
    }
    if (buf.startsWith('data:')) yield buf.slice(5).trim();
  } finally {
    reader.releaseLock();
  }
}

/** Streams an answer. Yields reasoning (thinking mode only), text and, at the end, usage. */
export async function* streamChat(cfg: DeepSeekConfig, messages: ChatMessage[], signal?: AbortSignal): AsyncGenerator<StreamEvent> {
  const res = await post(
    cfg,
    {
      model: cfg.chatModel,
      messages,
      stream: true,
      stream_options: { include_usage: true },
      thinking: { type: cfg.thinking ? 'enabled' : 'disabled' },
      ...(cfg.thinking ? {} : { temperature: 0.3 }),
      max_tokens: 2000,
    },
    signal,
  );
  if (!res.body) throw new DeepSeekError('DeepSeek returned no body', 502, 'DeepSeek returned an empty response.');
  for await (const payload of sseData(res.body)) {
    if (payload === '[DONE]') return;
    yield* parseChunk(payload);
  }
}
