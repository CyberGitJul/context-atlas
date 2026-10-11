import Anthropic from '@anthropic-ai/sdk';
import { betaJSONSchemaOutputFormat } from '@anthropic-ai/sdk/helpers/beta/json-schema';
import { explainWith, RouterBusyError, RouterError, type AiClient, type ChatRequest, type JsonRequest, type NativeTurn, type RouterMessage, type ToolCall } from './router-client.js';
import { msg } from '../messages/index.js';

type MessageParam = Anthropic.Beta.Messages.BetaMessageParam;
type ContentBlockParam = Anthropic.Beta.Messages.BetaContentBlockParam;
type ToolResultBlockParam = Anthropic.Beta.Messages.BetaToolResultBlockParam;

/** Short names the app uses (as with the router) and the current model behind each. */
export const MODEL_IDS: Record<string, string> = { opus: 'claude-opus-5-5', sonnet: 'claude-sonnet-5-5', haiku: 'claude-haiku-5-5', fable: 'claude-fable-5-1' };
export const modelId = (model: string) => MODEL_IDS[model] ?? model;

/** A declined request is re-run on a fallback model chosen by the API (`fallbacks: 'default'`). */
const FALLBACK: { betas: Anthropic.Beta.AnthropicBeta[]; fallbacks: 'default' } = { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' };
const DEFAULT_RETRY_MS = 10_000;

function parseArgs(text: string): unknown {
  try {
    return JSON.parse(text || '{}');
  } catch {
    return {};
  }
}

/**
 * The app's chat history (router format) as Messages API turns: a tool round replays the provider's own content
 * blocks when it has them (thinking blocks must come back unchanged), and all results of a round go back in one
 * user message.
 */
export function toAnthropicMessages(history: RouterMessage[]): MessageParam[] {
  const out: MessageParam[] = [];
  for (const m of history) {
    if (m.role === 'tool') {
      const block: ToolResultBlockParam = { type: 'tool_result', tool_use_id: m.tool_call_id, content: m.content };
      const last = out.at(-1);
      if (last?.role === 'user' && Array.isArray(last.content) && last.content.every((b) => b.type === 'tool_result')) last.content.push(block);
      else out.push({ role: 'user', content: [block] });
    } else if ('tool_calls' in m) {
      const built: ContentBlockParam[] = [
        ...(m.content ? [{ type: 'text' as const, text: m.content }] : []),
        ...m.tool_calls.map((c) => ({ type: 'tool_use' as const, id: c.id, name: c.function.name, input: parseArgs(c.function.arguments) })),
      ];
      out.push({ role: 'assistant', content: (m.native as ContentBlockParam[] | undefined) ?? built });
    } else {
      out.push({ role: m.role, content: m.content });
    }
  }
  return out;
}

/** Busy and rate limits become RouterBusyError (the background queue waits); the rest a plain error without status. */
function asRouterError(e: unknown): Error {
  if (e instanceof RouterError || e instanceof RouterBusyError) return e;
  if (e instanceof Anthropic.APIError) {
    if (e.status === 429 || e.status === 529) {
      const secs = Number(e.headers?.get('retry-after'));
      return new RouterBusyError(Number.isFinite(secs) && secs > 0 ? secs * 1000 : DEFAULT_RETRY_MS);
    }
    // No status on purpose: a 403 here is not the router's "tools not allowed" (that path retries without tools).
    return new RouterError(`Anthropic-API ${e.status ?? ''}: ${e.message}`.trim());
  }
  return e instanceof Error ? e : new Error(String(e));
}

function refusal(stop: { category?: string | null } | null | undefined): RouterError {
  return new RouterError(msg.app.client.refused(stop?.category ?? null));
}

/** Direct Messages API with an API key (or the credentials the SDK finds: ANTHROPIC_AUTH_TOKEN, `ant auth login`). */
export function createAnthropicClient(opts: { client?: Anthropic; model?: string } = {}): AiClient {
  const client = opts.client ?? new Anthropic();
  const explainModel = opts.model ?? 'opus';

  async function json<T>(req: JsonRequest): Promise<{ result: T; model: string }> {
    try {
      const res = await client.beta.messages.parse({
        model: modelId(req.model),
        max_tokens: 16000,
        system: req.system,
        messages: [{ role: 'user', content: req.prompt }],
        // The helper drops schema keywords the API does not take (e.g. `pattern`) and checks them on the result.
        output_config: { effort: req.effort ?? 'high', format: betaJSONSchemaOutputFormat(req.schema as { type: 'object' }) },
        ...FALLBACK,
      });
      if (res.stop_reason === 'refusal') throw refusal(res.stop_details);
      if (res.parsed_output == null) throw new RouterError(msg.app.client.noValidJson(res.stop_reason === 'max_tokens'));
      return { result: res.parsed_output as T, model: res.model };
    } catch (e) {
      throw asRouterError(e);
    }
  }

  async function* chat(req: ChatRequest): AsyncGenerator<string | ToolCall | NativeTurn> {
    const tools = (req.tools ?? []).map((t) => ({
      name: t.function.name,
      description: t.function.description,
      input_schema: t.function.parameters as Anthropic.Beta.Messages.BetaTool.InputSchema,
      eager_input_streaming: true,
    }));
    let message: Anthropic.Beta.Messages.BetaMessage;
    try {
      const stream = client.beta.messages.stream(
        {
          model: modelId(req.model),
          max_tokens: 64000,
          system: req.system,
          messages: toAnthropicMessages(req.messages),
          ...(tools.length ? { tools, ...(req.toolChoice === 'none' ? { tool_choice: { type: 'none' as const } } : {}) } : {}),
          output_config: { effort: 'high' },
          // Rounds of one answer resend the same system prompt and history: cached after the first.
          cache_control: { type: 'ephemeral' },
          ...FALLBACK,
        },
        { signal: req.signal },
      );
      for await (const ev of stream) {
        if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') yield ev.delta.text;
      }
      message = await stream.finalMessage();
    } catch (e) {
      throw asRouterError(e);
    }
    if (message.stop_reason === 'refusal') throw refusal(message.stop_details);
    const uses = message.content.filter((b): b is Anthropic.Beta.Messages.BetaToolUseBlock => b.type === 'tool_use');
    if (!uses.length) return;
    // A tool input cut off at max_tokens may still parse; never run it.
    if (message.stop_reason === 'max_tokens') throw new RouterError(msg.app.client.toolCallCut);
    yield { native: message.content };
    for (const u of uses) yield { id: u.id, name: u.name, arguments: JSON.stringify(u.input ?? {}) };
  }

  return { json, chat, explain: explainWith(json, explainModel) };
}
