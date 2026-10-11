import type { Explanation, Kind } from '../../shared/model.js';
import { redact } from '../redact.js';

export const INPUT_LIMIT = 12_000;
export const DEFAULT_MODEL = 'opus';
const DEFAULT_RETRY_MS = 10_000;
const TIMEOUT_MS = 300_000;

export interface ExplainJob {
  hash: string;
  kind: Kind;
  name: string;
  event?: string;
  matcher?: string;
  /** Text the explanation is based on (already redacted once by the scanner). */
  input: string;
}

export interface ExplainClient {
  explain(job: ExplainJob): Promise<Explanation>;
}

export interface JsonRequest {
  prompt: string;
  system: string;
  schema: object;
  model: string;
  /** How hard the model works on it; providers without the setting ignore it. */
  effort?: 'low' | 'medium' | 'high';
}

/** Structured call against /v1/json; the model is chosen per request. */
export interface RouterJsonClient {
  json<T>(req: JsonRequest): Promise<{ result: T; model: string }>;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

/** A tool the app offers the model; the app runs it, the router never does (OpenAI format). */
export interface ToolDef {
  type: 'function';
  function: { name: string; description: string; parameters: object };
}

/** A call the model asked for; `arguments` is JSON text as the model wrote it. */
export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

/**
 * The provider's own record of an assistant round with tool calls (e.g. Anthropic content blocks with thinking),
 * replayed unchanged in the next round. Opaque to everything but the provider that produced it.
 */
export interface NativeTurn {
  native: unknown;
}

/** Chat history as the router takes it: plain turns plus the tool rounds of the current answer. */
export type RouterMessage =
  | ChatMessage
  | { role: 'assistant'; content: string | null; tool_calls: { id: string; type: 'function'; function: { name: string; arguments: string } }[]; native?: unknown }
  | { role: 'tool'; tool_call_id: string; content: string };

export interface ChatRequest {
  system: string;
  messages: RouterMessage[];
  model: string;
  tools?: ToolDef[];
  /** `none` keeps the tools in the request but lets the model only answer (last round). */
  toolChoice?: 'auto' | 'none';
  /** Aborts the router call, e.g. when the user stops the answer or closes the page. */
  signal?: AbortSignal;
  /**
   * For providers that run the tool loop themselves (Agent SDK): carries out a call and returns its result.
   * Providers that hand tool calls back (router, Anthropic API) leave the loop to the caller and ignore it.
   */
  execute?: (call: ToolCall) => Promise<string>;
  /** Tool rounds a self-running provider may use before it must answer. */
  maxToolRounds?: number;
}

/**
 * Streamed chat; yields the text as it arrives, then (for a round with tool calls) optionally the provider's own
 * record of the round, then the tool calls.
 */
export interface RouterChatClient {
  chat(req: ChatRequest): AsyncIterable<string | ToolCall | NativeTurn>;
}

/** What the app needs from a model provider (router, Anthropic API, Agent SDK). */
export type AiClient = ExplainClient & RouterJsonClient & RouterChatClient;

/** Router slot busy (503) or rate limited (429). */
export class RouterBusyError extends Error {
  constructor(public readonly retryAfterMs: number) {
    super(`router busy, retry in ${retryAfterMs} ms`);
  }
}

export class RouterError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message);
  }
}

const SYSTEM =
  'You explain one component of their Claude Code configuration to an experienced user. ' +
  '`title`: a short name, at most 40 characters. ' +
  '`summary`: exactly one sentence on what it does (at most 200 characters). ' +
  '`injects`: what it adds to Claude’s context (one sentence), or null if nothing. ' +
  'Write title, summary and injects in English.';

export const EXPLAIN_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    summary: { type: 'string' },
    injects: { type: ['string', 'null'] },
  },
  required: ['title', 'summary', 'injects'],
  additionalProperties: false,
};

function prompt(job: ExplainJob): string {
  const head = [`Component: ${job.kind} “${job.name}”`, job.event && `Event: ${job.event}`, job.matcher && `Matcher: ${job.matcher}`];
  return [...head.filter(Boolean), '', redact(job.input).slice(0, INPUT_LIMIT)].join('\n');
}

/** Background explanations, the same for every provider: one structured call with low effort. */
export function explainWith(json: RouterJsonClient['json'], model: string): ExplainClient['explain'] {
  return async (job) => {
    const { result: r, model: used } = await json<{ title?: string; summary?: string; injects?: string | null }>({ prompt: prompt(job), schema: EXPLAIN_SCHEMA, model, system: SYSTEM, effort: 'low' });
    if (typeof r.summary !== 'string') throw new RouterError('result without summary');
    return { hash: job.hash, title: r.title ?? job.name, summary: r.summary, injects: r.injects ?? null, at: new Date().toISOString(), model: used };
  };
}

function busyOrError(res: Response): Error | null {
  if (res.status === 503 || res.status === 429) {
    const secs = Number(res.headers.get('Retry-After'));
    return new RouterBusyError(Number.isFinite(secs) && secs > 0 ? secs * 1000 : DEFAULT_RETRY_MS);
  }
  return res.ok ? null : new RouterError(`router answered ${res.status}`, res.status);
}

/** A tool call as the router sends it, whole or as one piece of a streamed call. */
interface StreamedCall {
  index?: number;
  id?: string;
  function?: { name?: string; arguments?: string };
}

/** Data payloads of an SSE body, buffered across reads (an event may arrive in pieces). */
async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const events = buffer.split(/\r?\n\r?\n/);
      buffer = done ? '' : events.pop()!;
      for (const event of events) {
        const data = event
          .split(/\r?\n/)
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trimStart())
          .join('\n');
        if (data) yield data;
      }
      if (done) return;
    }
  } finally {
    reader.releaseLock();
  }
}

export function createRouterClient(opts: { url: string; apiKey: string; model?: string; fetch?: typeof fetch }): AiClient {
  const doFetch = opts.fetch ?? fetch;
  const model = opts.model ?? DEFAULT_MODEL;
  const base = opts.url.replace(/\/$/, '');

  async function json<T>(req: JsonRequest): Promise<{ result: T; model: string }> {
    const res = await doFetch(`${base}/v1/json`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${opts.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: req.prompt, schema: req.schema, model: req.model, system: req.system }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const failed = busyOrError(res);
    if (failed) throw failed;
    const body = (await res.json()) as { model?: string; result?: T };
    if (body.result === undefined || body.result === null) throw new RouterError('router answered without result');
    return { result: body.result, model: body.model ?? req.model };
  }

  async function* chat(req: ChatRequest): AsyncGenerator<string | ToolCall> {
    // A limit on silence, not on length: a long answer may stream for minutes, a stalled one stops.
    const idle = new AbortController();
    let timer = setTimeout(() => idle.abort(new RouterError('router silent too long')), TIMEOUT_MS);
    const alive = () => {
      clearTimeout(timer);
      timer = setTimeout(() => idle.abort(new RouterError('router silent too long')), TIMEOUT_MS);
    };
    const tools = req.tools?.length ? { tools: req.tools, ...(req.toolChoice ? { tool_choice: req.toolChoice } : {}) } : {};
    try {
      const res = await doFetch(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${opts.apiKey}`, 'Content-Type': 'application/json' },
        // `native` belongs to other providers; the router speaks plain OpenAI messages.
        body: JSON.stringify({ model: req.model, stream: true, messages: [{ role: 'system', content: req.system }, ...req.messages.map(({ native: _, ...m }: RouterMessage & { native?: unknown }) => m)], ...tools }),
        signal: req.signal ? AbortSignal.any([req.signal, idle.signal]) : idle.signal,
      });
      const failed = busyOrError(res);
      if (failed) throw failed;
      if (!res.body) throw new RouterError('router answered without body');
      // A router that ignores stream:true answers once, as plain JSON.
      if ((res.headers.get('content-type') ?? '').includes('application/json')) {
        const body = (await res.json()) as { error?: { message?: string }; choices?: { message?: { content?: string | null; tool_calls?: StreamedCall[] } }[] };
        const message = body.choices?.[0]?.message;
        const calls = (message?.tool_calls ?? []).map((c) => ({ id: c.id ?? '', name: c.function?.name ?? '', arguments: c.function?.arguments ?? '' }));
        if (body.error || (typeof message?.content !== 'string' && !calls.length)) throw new RouterError(body.error?.message ?? 'router answered without content');
        if (message?.content) yield message.content;
        yield* calls;
        return;
      }
      // Tool calls may arrive in pieces (OpenAI streams the arguments); they are complete only at the end.
      const calls: ToolCall[] = [];
      for await (const data of sseData(res.body)) {
        alive();
        if (data === '[DONE]') return yield* calls;
        const event = JSON.parse(data) as { error?: { message?: string }; choices?: { delta?: { content?: string; tool_calls?: StreamedCall[] } }[] };
        // A run that fails after the first token ends with an error object instead of [DONE].
        if (event.error) throw new RouterError(event.error.message ?? 'router stream failed');
        const delta = event.choices?.[0]?.delta;
        if (delta?.content) yield delta.content;
        for (const part of delta?.tool_calls ?? []) {
          const i = part.index ?? calls.length;
          const call = (calls[i] ??= { id: '', name: '', arguments: '' });
          if (part.id) call.id = part.id;
          if (part.function?.name) call.name += part.function.name;
          if (part.function?.arguments) call.arguments += part.function.arguments;
        }
      }
      // Without [DONE] the answer may be cut off; it must not look complete.
      throw new RouterError('stream ended without [DONE], answer may be incomplete');
    } finally {
      clearTimeout(timer);
    }
  }

  return { json, chat, explain: explainWith(json, model) };
}
