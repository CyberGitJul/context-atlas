import { createSdkMcpServer, query as sdkQuery, tool, type Options, type SDKMessage, type SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { modelId } from './anthropic-client.js';
import { msg } from '../messages/index.js';
import { explainWith, RouterError, type AiClient, type ChatRequest, type JsonRequest, type RouterMessage, type ToolCall, type ToolDef } from './router-client.js';

export type QueryFn = (params: { prompt: string; options?: Options }) => AsyncIterable<SDKMessage>;

/** Name of the in-process MCP server that carries the app's tools; Claude Code calls them `mcp__atlas__<tool>`. */
const SERVER = 'atlas';
/** A limit on silence, not on length (as with the router). */
const IDLE_MS = 300_000;

/**
 * Options of every call: a bare Claude Code that uses the login (or ANTHROPIC_API_KEY) of the machine, but none of
 * its configuration. Without `settingSources: []` the SDK would load the user's settings, hooks, CLAUDE.md and
 * plugins into each request; without `persistSession: false` every request would leave a session file.
 */
export function isolatedOptions(model: string, system: string, abortController: AbortController): Options {
  return {
    model: modelId(model),
    systemPrompt: system,
    tools: [],
    settingSources: [],
    strictMcpConfig: true,
    persistSession: false,
    abortController,
    env: { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: 'context-atlas' },
  };
}

/** Zod shape of a flat JSON schema (string, number, boolean, enum properties), as the SDK's tool() takes it. */
export function zodShape(schema: object): Record<string, z.ZodType> {
  const s = schema as { properties?: Record<string, { type?: string; enum?: string[]; description?: string }>; required?: string[] };
  return Object.fromEntries(
    Object.entries(s.properties ?? {}).map(([key, p]) => {
      let t: z.ZodType = p.enum?.length ? z.enum(p.enum as [string, ...string[]]) : p.type === 'number' ? z.number() : p.type === 'boolean' ? z.boolean() : z.string();
      if (p.description) t = t.describe(p.description);
      return [key, s.required?.includes(key) ? t : t.optional()];
    }),
  );
}

/** The app's tools as SDK tools; each call goes to `execute` (the app reads, Claude Code never touches files). */
export function sdkTools(defs: ToolDef[], execute: ChatRequest['execute']): SdkMcpToolDefinition[] {
  return defs.map((d) =>
    tool(d.function.name, d.function.description, zodShape(d.function.parameters), async (args) => {
      const call: ToolCall = { id: '', name: d.function.name, arguments: JSON.stringify(args) };
      return { content: [{ type: 'text' as const, text: execute ? await execute(call) : 'Tool not available.' }] };
    }),
  );
}

/** The SDK takes one prompt, not a history: earlier turns of the conversation go in front of the new message. */
export function transcript(messages: RouterMessage[]): string {
  const turns = messages.filter((m): m is { role: 'user' | 'assistant'; content: string } => (m.role === 'user' || m.role === 'assistant') && !('tool_calls' in m) && typeof m.content === 'string');
  const last = turns.at(-1);
  if (!last) return '';
  if (turns.length === 1) return last.content;
  const earlier = turns.slice(0, -1).map((m) => `${m.role === 'user' ? 'User' : 'You'}:\n${m.content}`);
  return ['Earlier history of this conversation:', '', earlier.join('\n\n'), '', 'New message from the user:', last.content].join('\n');
}

function failure(m: Extract<SDKMessage, { type: 'result' }>): RouterError {
  const detail = m.subtype === 'success' ? m.result : [m.subtype, ...m.errors].join(': ');
  return new RouterError(`Agent SDK: ${detail || msg.app.client.noDescription}`.slice(0, 400));
}

/** Runs one query with an idle timeout; the caller's signal (page closed, "Stopp") aborts it too. */
async function* run(q: QueryFn, prompt: string, options: (abort: AbortController) => Options, signal?: AbortSignal): AsyncGenerator<SDKMessage> {
  const abort = new AbortController();
  const stop = () => abort.abort();
  signal?.addEventListener('abort', stop, { once: true });
  let timer = setTimeout(stop, IDLE_MS);
  try {
    for await (const m of q({ prompt, options: options(abort) })) {
      clearTimeout(timer);
      timer = setTimeout(stop, IDLE_MS);
      yield m;
    }
  } catch (e) {
    throw e instanceof RouterError ? e : new RouterError(`Agent SDK: ${(e as Error).message}`.slice(0, 400));
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', stop);
  }
}

/** Claude Agent SDK with the Claude Code login of this machine: no API key needed, counts against the plan's limits. */
export function createAgentSdkClient(opts: { query?: QueryFn; model?: string } = {}): AiClient {
  const q = opts.query ?? (sdkQuery as QueryFn);
  const explainModel = opts.model ?? 'opus';

  async function json<T>(req: JsonRequest): Promise<{ result: T; model: string }> {
    const options = (abort: AbortController): Options => ({
      ...isolatedOptions(req.model, req.system, abort),
      outputFormat: { type: 'json_schema', schema: req.schema as Record<string, unknown> },
      // The structured answer comes through an internal tool call; a few turns leave room for a retry.
      maxTurns: 4,
      ...(req.effort ? { effort: req.effort } : {}),
    });
    for await (const m of run(q, req.prompt, options, req.signal)) {
      if (m.type !== 'result') continue;
      if (m.subtype !== 'success' || m.is_error) throw failure(m);
      if (m.structured_output == null) throw new RouterError(`Agent SDK: ${msg.app.client.noStructured}`);
      // Claude Code also makes small helper calls (e.g. Haiku); the answer came from the requested model.
      const used = Object.keys(m.modelUsage ?? {});
      return { result: m.structured_output as T, model: used.includes(modelId(req.model)) ? modelId(req.model) : (used[0] ?? modelId(req.model)) };
    }
    throw new RouterError(`Agent SDK: ${msg.app.client.noResult}`);
  }

  async function* chat(req: ChatRequest): AsyncGenerator<string> {
    const tools = req.toolChoice === 'none' ? [] : sdkTools(req.tools ?? [], req.execute);
    const options = (abort: AbortController): Options => ({
      ...isolatedOptions(req.model, req.system, abort),
      includePartialMessages: true,
      effort: 'high',
      // One turn per reading round plus the answer, as the app's own loop allows.
      maxTurns: (req.maxToolRounds ?? 4) + 1,
      ...(tools.length
        ? { mcpServers: { [SERVER]: createSdkMcpServer({ name: SERVER, tools }) }, allowedTools: tools.map((t) => `mcp__${SERVER}__${t.name}`) }
        : {}),
    });
    let wrote = false;
    let gap = false;
    for await (const m of run(q, transcript(req.messages), options, req.signal)) {
      if (m.type === 'stream_event' && m.parent_tool_use_id === null) {
        const ev = m.event;
        // Text of a later turn (after reading) starts a new paragraph, as in the app's own loop.
        if (ev.type === 'message_start' && wrote) gap = true;
        if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta' && ev.delta.text) {
          if (gap) yield '\n\n';
          gap = false;
          wrote = true;
          yield ev.delta.text;
        }
      } else if (m.type === 'result') {
        if (m.subtype !== 'success' || m.is_error) throw failure(m);
        return;
      }
    }
    throw new RouterError(`Agent SDK: ${msg.app.client.noResultMaybeIncomplete}`);
  }

  return { json, chat, explain: explainWith(json, explainModel) };
}
