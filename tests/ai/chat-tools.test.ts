import { describe, expect, it } from 'vitest';
import type { Component } from '../../src/shared/model.js';
import { CHAT_TOOLS, createReader, MAX_TOOL_ROUNDS, READ_BUDGET, READ_TOOL, runChat } from '../../src/server/ai/chat-tools.js';
import { RouterError, type ChatRequest, type ToolCall } from '../../src/server/ai/router-client.js';

const comp = (kind: Component['kind'], name: string, extra: Partial<Component> = {}): Component => ({
  id: `${kind}:${name}`, kind, name, origin: { type: 'user' }, phases: ['always'], sourcePath: `/home/u/.claude/${name}.md`, enabled: true, summary: null, contextWords: 0, hash: name, detail: {}, ...extra,
});
const call = (args: object | string, id = 'c1'): ToolCall => ({ id, name: READ_TOOL, arguments: typeof args === 'string' ? args : JSON.stringify(args) });

describe('read tool', () => {
  const components = [
    comp('instruction', 'Apps never change each other directly — only via feature request'),
    comp('instruction', 'Project index `~/projects`'),
    comp('skill', 'project-index-upkeep'),
    comp('skill', 'brainstorming', { origin: { type: 'plugin', plugin: 'superpowers' } }),
    comp('skill', 'brainstorming', { id: 'skill:own-brainstorming' }),
    comp('rule', 'antipatterns', { enabled: false }),
  ];
  const texts: Record<string, string> = { 'skill:own-brainstorming': 'own text' };
  const load = async (c: Component) => ({ text: texts[c.id] ?? `Full text of ${c.name}, api_key=abcdef1234567890abcdef`, file: c.sourcePath });

  it('offers one tool with a required name', () => {
    expect(CHAT_TOOLS.map((t) => t.function.name)).toEqual([READ_TOOL]);
    expect(CHAT_TOOLS[0].function.parameters).toMatchObject({ required: ['name'] });
  });

  it('reads a component by its exact name, in full and masked', async () => {
    const read = createReader(components, load);
    const r = await read(call({ name: 'Apps never change each other directly — only via feature request', kind: 'instruction' }));
    expect(r.label).toBe('Instruction (CLAUDE.md) “Apps never change each other directly — only via feature request”');
    expect(r.content).toContain('Full text of Apps never');
    expect(r.content).not.toContain('abcdef1234567890');
  });

  it('finds a name written with quotes, other case or only a unique part of it', async () => {
    const read = createReader(components, load);
    expect((await read(call({ name: '"apps never change each other directly — only via feature request"' }))).found).toBe(true);
    expect((await read(call({ name: '“Apps never change each other directly — only via feature request”' }))).found).toBe(true);
    expect((await read(call({ name: 'Project index', kind: 'instruction' }))).label).toContain('Project index `~/projects`');
  });

  it('returns every component with that exact name, each with its origin', async () => {
    const r = await createReader(components, load)(call({ name: 'brainstorming', kind: 'skill' }));
    expect(r.content).toContain('Plugin superpowers');
    expect(r.content).toContain('own text');
  });

  it('asks for the exact name when only parts match several components', async () => {
    const r = await createReader(components, load)(call({ name: 'project' }));
    expect(r.found).toBe(false);
    expect(r.content).toContain('project-index-upkeep');
    expect(r.content).toContain('Project index `~/projects`');
  });

  it('says what exists when nothing matches', async () => {
    const r = await createReader(components, load)(call({ name: 'does not exist', kind: 'rule' }));
    expect(r.found).toBe(false);
    expect(r.content).toContain('antipatterns');
  });

  it('marks a disabled component and refuses broken arguments', async () => {
    const read = createReader(components, load);
    expect((await read(call({ name: 'antipatterns' }))).content).toContain('disabled');
    expect((await read(call('{nope'))).found).toBe(false);
    expect((await read({ id: 'x', name: 'write_file', arguments: '{}' })).content).toContain('Unknown tool');
  });

  it('cuts a long text and stops reading once the budget of the answer is used', async () => {
    const big = comp('skill', 'large');
    const read = createReader([big], async () => ({ text: 'x'.repeat(READ_BUDGET), file: null }));
    const first = await read(call({ name: 'large' }));
    expect(first.content).toContain('cut');
    let last = first;
    for (let i = 0; i < 10 && last.found; i++) last = await read(call({ name: 'large' }));
    expect(last.found).toBe(false);
    expect(last.content).toContain('Read budget');
  });
});

describe('chat with reading rounds', () => {
  /** A fake router: each request plays the next script entry. */
  function fakeClient(script: ((req: ChatRequest) => (string | ToolCall)[] | Error)[]) {
    const requests: ChatRequest[] = [];
    return {
      requests,
      async *chat(req: ChatRequest) {
        requests.push(structuredClone({ ...req, signal: undefined, execute: undefined }));
        const out = script[Math.min(requests.length - 1, script.length - 1)](req);
        if (out instanceof Error) throw out;
        yield* out;
      },
    };
  }
  const setup = (script: Parameters<typeof fakeClient>[0]) => {
    const client = fakeClient(script);
    const events: object[] = [];
    const run = () =>
      runChat({
        client, system: 'SYS', model: 'opus', messages: [{ role: 'user', content: 'Does this exist already?' }],
        read: async (c) => ({ label: `"${JSON.parse(c.arguments).name}"`, content: `Text ${JSON.parse(c.arguments).name}`, found: true }),
        onText: async (t) => void events.push({ t }), onRead: async (r) => void events.push({ read: r }), onNote: async (n) => void events.push({ note: n }),
      });
    return { client, events, run };
  };

  it('runs the tool calls, sends the results back and streams the final answer', async () => {
    const { client, events, run } = setup([() => ['Let me read.', call({ name: 'A' })], () => ['Already covered in A.']]);
    expect(await run()).toEqual({ reply: 'Let me read.\n\nAlready covered in A.', reads: ['"A"'] });
    expect(events).toEqual([{ t: 'Let me read.' }, { read: '"A"' }, { t: '\n\n' }, { t: 'Already covered in A.' }]);
    expect(client.requests[0]).toMatchObject({ tools: CHAT_TOOLS, toolChoice: 'auto' });
    expect(client.requests[1].messages.slice(1)).toEqual([
      { role: 'assistant', content: 'Let me read.', tool_calls: [{ id: 'c1', type: 'function', function: { name: READ_TOOL, arguments: '{"name":"A"}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: 'Text A' },
    ]);
  });

  it('gives calls without id one, so results stay paired', async () => {
    const { client, run } = setup([() => [{ id: '', name: READ_TOOL, arguments: '{"name":"A"}' }], () => ['ok']]);
    await run();
    const [assistant, tool] = client.requests[1].messages.slice(1) as unknown as [{ tool_calls: { id: string }[] }, { tool_call_id: string }];
    expect(assistant.tool_calls[0].id).not.toBe('');
    expect(tool.tool_call_id).toBe(assistant.tool_calls[0].id);
  });

  it('lets the model only answer in the last round', async () => {
    const { client, run } = setup([(req) => (req.toolChoice === 'none' ? ['done'] : [call({ name: 'A' })])]);
    expect((await run()).reply).toBe('done');
    expect(client.requests).toHaveLength(MAX_TOOL_ROUNDS + 1);
    expect(client.requests.at(-1)!.toolChoice).toBe('none');
  });

  it('falls back to a chat without tools when the router refuses them, and says so', async () => {
    const { client, events, run } = setup([(req) => (req.tools ? new RouterError('may not use function calling', 403) : ['without tool'])]);
    expect((await run()).reply).toBe('without tool');
    expect(client.requests[1].tools).toBeUndefined();
    expect(client.requests[1].system).toContain('not available');
    expect(events[0]).toMatchObject({ note: expect.stringContaining('Function calling') });
  });

  it('passes other router errors on', async () => {
    const { run } = setup([() => new RouterError('router answered 500', 500)]);
    await expect(run()).rejects.toThrow('500');
  });
});
