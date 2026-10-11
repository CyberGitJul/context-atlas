import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { createAnthropicClient, modelId, toAnthropicMessages } from '../../src/server/ai/anthropic-client.js';
import { RouterBusyError, RouterError, type NativeTurn, type RouterMessage, type ToolCall, type ToolDef } from '../../src/server/ai/router-client.js';

type Message = Anthropic.Beta.Messages.BetaMessage;
const message = (over: Partial<Message>): Message => ({ id: 'm', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: 'end_turn', ...over }) as Message;

/** A stand-in for the SDK client: stream() plays the given events and final message, parse() returns `parsed`. */
function fakeSdk(opts: { events?: unknown[]; final?: Message; parsed?: Partial<Message> & { parsed_output?: unknown }; fail?: Error }) {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const client = {
    beta: {
      messages: {
        stream(params: Record<string, unknown>) {
          calls.push({ method: 'stream', params });
          return {
            async *[Symbol.asyncIterator]() {
              if (opts.fail) throw opts.fail;
              yield* opts.events ?? [];
            },
            finalMessage: async () => opts.final ?? message({}),
          };
        },
        async parse(params: Record<string, unknown>) {
          calls.push({ method: 'parse', params });
          if (opts.fail) throw opts.fail;
          return { ...message({}), ...opts.parsed };
        },
      },
    },
  };
  return { client: client as unknown as Anthropic, calls };
}
const text = (t: string) => ({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: t } });
const collect = async (it: AsyncIterable<string | ToolCall | NativeTurn>) => {
  const out: (string | ToolCall | NativeTurn)[] = [];
  for await (const ev of it) out.push(ev);
  return out;
};
const tools: ToolDef[] = [{ type: 'function', function: { name: 'read_component', description: 'liest', parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } } }];

describe('anthropic client', () => {
  it('maps the short model names to current models and leaves full ids alone', () => {
    expect(modelId('opus')).toBe('claude-opus-5-5');
    expect(modelId('sonnet')).toBe('claude-sonnet-5-5');
    expect(modelId('claude-opus-5')).toBe('claude-opus-5');
  });

  it('streams the text and asks with the system prompt, the tools and a server-side fallback', async () => {
    const { client, calls } = fakeSdk({ events: [text('Hal'), text('lo')] });
    const out = await collect(createAnthropicClient({ client }).chat({ system: 'SYS', messages: [{ role: 'user', content: 'hi' }], model: 'opus', tools, toolChoice: 'none' }));
    expect(out).toEqual(['Hal', 'lo']);
    expect(calls[0].params).toMatchObject({
      model: 'claude-opus-5-5',
      system: 'SYS',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ name: 'read_component', description: 'liest', input_schema: tools[0].function.parameters, eager_input_streaming: true }],
      tool_choice: { type: 'none' },
      fallbacks: 'default',
      betas: ['server-side-fallback-2026-07-01'],
    });
  });

  it('hands back tool calls together with its own content blocks for the next round', async () => {
    const content = [
      { type: 'thinking', thinking: '', signature: 'sig' },
      { type: 'tool_use', id: 'tu1', name: 'read_component', input: { name: 'A' } },
    ];
    const { client } = fakeSdk({ final: message({ content: content as Message['content'], stop_reason: 'tool_use' }) });
    const out = await collect(createAnthropicClient({ client }).chat({ system: 's', messages: [{ role: 'user', content: 'lies' }], model: 'opus', tools }));
    expect(out).toEqual([{ native: content }, { id: 'tu1', name: 'read_component', arguments: '{"name":"A"}' }]);
  });

  it('replays the native round unchanged and sends all results of a round in one user message', () => {
    const native = [{ type: 'thinking', thinking: '', signature: 'sig' }, { type: 'tool_use', id: 'a', name: 'read_component', input: { name: 'A' } }];
    const history: RouterMessage[] = [
      { role: 'user', content: 'lies' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'a', type: 'function', function: { name: 'read_component', arguments: '{"name":"A"}' } }], native },
      { role: 'tool', tool_call_id: 'a', content: 'Text A' },
      { role: 'tool', tool_call_id: 'b', content: 'Text B' },
    ];
    expect(toAnthropicMessages(history)).toEqual([
      { role: 'user', content: 'lies' },
      { role: 'assistant', content: native },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: 'Text A' }, { type: 'tool_result', tool_use_id: 'b', content: 'Text B' }] },
    ]);
    // Without a native record (e.g. history from another provider) the round is rebuilt from text and calls.
    const { native: _, ...plain } = history[1] as RouterMessage & { native?: unknown };
    expect(toAnthropicMessages([plain as RouterMessage])).toEqual([{ role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 'read_component', input: { name: 'A' } }] }]);
  });

  it('stops on a refusal instead of running tools', async () => {
    const { client } = fakeSdk({ final: message({ stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber', explanation: null } } as Partial<Message>) });
    await expect(collect(createAnthropicClient({ client }).chat({ system: 's', messages: [{ role: 'user', content: 'x' }], model: 'opus' }))).rejects.toThrow('refused the request (cyber)');
  });

  it('answers structured calls from the parsed output with the requested effort', async () => {
    const { client, calls } = fakeSdk({ parsed: { parsed_output: { kind: 'Stil' }, model: 'claude-opus-5-5' } });
    const schema = { type: 'object', properties: { kind: { type: 'string' } }, required: ['kind'], additionalProperties: false };
    const res = await createAnthropicClient({ client }).json({ prompt: 'P', system: 'S', schema, model: 'opus', effort: 'low' });
    expect(res).toEqual({ result: { kind: 'Stil' }, model: 'claude-opus-5-5' });
    expect(calls[0].params).toMatchObject({ model: 'claude-opus-5-5', system: 'S', messages: [{ role: 'user', content: 'P' }], output_config: { effort: 'low' } });
  });

  it('turns a rate limit into a busy error the background queue waits for, other API errors into plain errors', async () => {
    const limited = new Anthropic.RateLimitError(429, { error: { message: 'slow down' } }, 'slow down', new Headers({ 'retry-after': '7' }));
    await expect(createAnthropicClient({ client: fakeSdk({ fail: limited }).client }).json({ prompt: 'p', system: 's', schema: { type: 'object', properties: {}, additionalProperties: false }, model: 'opus' })).rejects.toEqual(new RouterBusyError(7000));
    const denied = new Anthropic.PermissionDeniedError(403, { error: { message: 'no' } }, 'no', new Headers());
    const err = await createAnthropicClient({ client: fakeSdk({ fail: denied }).client }).json({ prompt: 'p', system: 's', schema: { type: 'object', properties: {}, additionalProperties: false }, model: 'opus' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RouterError);
    expect((err as RouterError).status).toBeUndefined();
  });
});

describe('schemas the app sends', () => {
  it('are all accepted by the structured-output helper', async () => {
    const { SCHEMAS } = await import('../../src/server/ai/actions.js');
    const { EXPLAIN_SCHEMA } = await import('../../src/server/ai/router-client.js');
    const { PROPOSE_SCHEMA, REPAIR_SCHEMA, TEST_SCHEMA } = await import('../../src/server/ai/condense.js');
    for (const [id, schema] of Object.entries({ explain: EXPLAIN_SCHEMA, condense: PROPOSE_SCHEMA, condenseTest: TEST_SCHEMA, condenseRepair: REPAIR_SCHEMA, ...SCHEMAS })) {
      const { client, calls } = fakeSdk({ parsed: { parsed_output: {} } });
      await createAnthropicClient({ client }).json({ prompt: 'p', system: 's', schema: schema as object, model: 'opus' }).catch((e: Error) => {
        throw new Error(`${id}: ${e.message}`);
      });
      expect(calls).toHaveLength(1);
    }
  });
});
