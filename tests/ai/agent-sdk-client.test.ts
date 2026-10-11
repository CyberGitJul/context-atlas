import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';
import { createAgentSdkClient, sdkTools, transcript, zodShape, type QueryFn } from '../../src/server/ai/agent-sdk-client.js';
import { CHAT_TOOLS } from '../../src/server/ai/chat-tools.js';
import { RouterError, type ToolCall } from '../../src/server/ai/router-client.js';

/** A stand-in for query(): records each call and plays the given messages. */
function fakeQuery(messages: unknown[]) {
  const calls: { prompt: string; options?: Options }[] = [];
  const query: QueryFn = async function* (params) {
    calls.push(params);
    yield* messages as SDKMessage[];
  };
  return { query, calls };
}
const streamText = (text: string) => ({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } });
const messageStart = { type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_start', message: {} } };
const success = (over: object = {}) => ({ type: 'result', subtype: 'success', is_error: false, result: 'ok', modelUsage: { 'claude-opus-5-5': {} }, ...over });
const collect = async (it: AsyncIterable<unknown>) => {
  const out: unknown[] = [];
  for await (const ev of it) out.push(ev);
  return out;
};

describe('agent sdk client', () => {
  it('runs isolated from the own Claude Code setup: no settings, hooks, built-in tools, foreign MCP servers or session file', async () => {
    const { query, calls } = fakeQuery([success({ structured_output: { kind: 'Stil' }, modelUsage: { 'claude-haiku-5-5': {}, 'claude-opus-5-5': {} } })]);
    const res = await createAgentSdkClient({ query }).json({ prompt: 'P', system: 'S', schema: { type: 'object' }, model: 'opus', effort: 'low' });
    expect(res).toEqual({ result: { kind: 'Stil' }, model: 'claude-opus-5-5' });
    expect(calls[0].prompt).toBe('P');
    expect(calls[0].options).toMatchObject({
      model: 'claude-opus-5-5', systemPrompt: 'S', tools: [], settingSources: [], strictMcpConfig: true, persistSession: false,
      outputFormat: { type: 'json_schema', schema: { type: 'object' } }, effort: 'low',
    });
  });

  it('streams the text of all turns, a paragraph between them, and offers only the app tools', async () => {
    const { query, calls } = fakeQuery([messageStart, streamText('Let me read.'), messageStart, streamText('Already covered in A.'), success()]);
    const out = await collect(createAgentSdkClient({ query }).chat({ system: 'S', messages: [{ role: 'user', content: 'Doppelt?' }], model: 'opus', tools: CHAT_TOOLS, execute: async () => 'x' }));
    expect(out).toEqual(['Let me read.', '\n\n', 'Already covered in A.']);
    expect(calls[0].options).toMatchObject({ includePartialMessages: true, maxTurns: 5, allowedTools: ['mcp__atlas__read_component'], settingSources: [], tools: [] });
    expect(Object.keys(calls[0].options?.mcpServers ?? {})).toEqual(['atlas']);
  });

  it('offers no tools in a round that may only answer', async () => {
    const { query, calls } = fakeQuery([streamText('Answer'), success()]);
    await collect(createAgentSdkClient({ query }).chat({ system: 'S', messages: [{ role: 'user', content: 'x' }], model: 'opus', tools: CHAT_TOOLS, toolChoice: 'none' }));
    expect(calls[0].options?.mcpServers).toBeUndefined();
    expect(calls[0].options?.allowedTools).toBeUndefined();
  });

  it('reads through the app: the tool handler hands the call to execute', async () => {
    const seen: ToolCall[] = [];
    const [read] = sdkTools(CHAT_TOOLS, async (call) => (seen.push(call), 'Text A'));
    const res = await read.handler({ name: 'A', kind: 'skill' }, undefined);
    expect(res).toEqual({ content: [{ type: 'text', text: 'Text A' }] });
    expect(seen).toEqual([{ id: '', name: 'read_component', arguments: '{"name":"A","kind":"skill"}' }]);
    // The kind is optional and limited to the known kinds, as in the JSON schema.
    const shape = zodShape(CHAT_TOOLS[0].function.parameters);
    expect(shape.kind.safeParse(undefined).success).toBe(true);
    expect(shape.kind.safeParse('nonsense').success).toBe(false);
    expect(shape.name.safeParse(undefined).success).toBe(false);
  });

  it('puts earlier turns of the conversation in front of the new message', () => {
    expect(transcript([{ role: 'user', content: 'Only this' }])).toBe('Only this');
    const text = transcript([{ role: 'user', content: 'Question 1' }, { role: 'assistant', content: 'Answer 1' }, { role: 'user', content: 'Question 2' }]);
    expect(text).toContain('User:\nQuestion 1');
    expect(text).toContain('You:\nAnswer 1');
    expect(text.endsWith('New message from the user:\nQuestion 2')).toBe(true);
  });

  it('reports a failed run with its reason instead of an empty answer', async () => {
    const { query } = fakeQuery([streamText('Half'), { type: 'result', subtype: 'error_max_turns', is_error: true, errors: ['too many rounds'], modelUsage: {} }]);
    const err = await collect(createAgentSdkClient({ query }).chat({ system: 'S', messages: [{ role: 'user', content: 'x' }], model: 'opus' })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RouterError);
    expect((err as Error).message).toContain('error_max_turns: too many rounds');
    const { query: silent } = fakeQuery([success({ structured_output: undefined })]);
    await expect(createAgentSdkClient({ query: silent }).json({ prompt: 'p', system: 's', schema: {}, model: 'opus' })).rejects.toThrow('response without a structured result');
  });
});
