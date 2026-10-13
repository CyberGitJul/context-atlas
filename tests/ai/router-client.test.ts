import { describe, expect, it } from 'vitest';
import { createRouterClient, RouterBusyError, type ExplainJob, type NativeTurn, type ToolCall } from '../../src/server/ai/router-client.js';

type Call = { url: string; init: RequestInit };

function fakeFetch(status: number, body: unknown, headers: Record<string, string> = {}) {
  const calls: Call[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

const job = (input: string): ExplainJob => ({ hash: 'h1', kind: 'hook', name: 'start.sh', event: 'SessionStart', matcher: '*', input });
const ok = { result: { title: 'Load progress', summary: 'S', injects: null } };
const bodyOf = (c: Call) => JSON.parse(String(c.init.body));

describe('router client', () => {
  it('posts to /v1/json with bearer key, opus by default and a schema for title, summary and injects', async () => {
    const { fetch, calls } = fakeFetch(200, ok);
    await createRouterClient({ url: 'http://router:1', apiKey: 'k1', fetch }).explain(job('echo hi'));
    expect(calls[0].url).toBe('http://router:1/v1/json');
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer k1');
    const body = bodyOf(calls[0]);
    expect(body.model).toBe('opus');
    expect(body.system).toContain('in English');
    expect(body.schema.required).toEqual(['title', 'summary', 'injects']);
    expect(body.schema.properties.injects.type).toEqual(['string', 'null']);
  });

  it("json aborts with the caller's signal", async () => {
    const { fetch, calls } = fakeFetch(200, ok);
    const caller = new AbortController();
    await createRouterClient({ url: 'http://r', apiKey: 'k', fetch }).json({ prompt: 'P', system: 'S', schema: {}, model: 'opus', signal: caller.signal });
    expect(calls[0].init.signal?.aborted).toBe(false);
    caller.abort();
    expect(calls[0].init.signal?.aborted).toBe(true);
  });

  it('sends at most 12000 characters of the input', async () => {
    const { fetch, calls } = fakeFetch(200, ok);
    await createRouterClient({ url: 'http://r', apiKey: 'k', fetch }).explain(job('x'.repeat(50_000)));
    const prompt: string = bodyOf(calls[0]).prompt;
    expect(prompt).toContain('x'.repeat(12_000));
    expect(prompt).not.toContain('x'.repeat(12_001));
  });

  it('redacts secrets in the input again before sending', async () => {
    const { fetch, calls } = fakeFetch(200, ok);
    await createRouterClient({ url: 'http://r', apiKey: 'k', fetch }).explain(job('API_KEY=sk-abcdefghijklmnop123 node x.js'));
    expect(bodyOf(calls[0]).prompt).not.toContain('sk-abcdefghijklmnop123');
  });

  it('turns 503 with Retry-After into a RouterBusyError', async () => {
    const { fetch } = fakeFetch(503, { detail: 'busy' }, { 'Retry-After': '2' });
    const err = await createRouterClient({ url: 'http://r', apiKey: 'k', fetch }).explain(job('a')).catch((e) => e);
    expect(err).toBeInstanceOf(RouterBusyError);
    expect(err.retryAfterMs).toBe(2000);
  });

  it('defaults to 10 s when 429 comes without Retry-After', async () => {
    const { fetch } = fakeFetch(429, {});
    const err = await createRouterClient({ url: 'http://r', apiKey: 'k', fetch }).explain(job('a')).catch((e) => e);
    expect(err.retryAfterMs).toBe(10_000);
  });

  it('maps a successful result to an explanation for the job hash, with the model the router reports', async () => {
    const { fetch } = fakeFetch(200, { ...ok, model: 'claude-opus-x' });
    const e = await createRouterClient({ url: 'http://r', apiKey: 'k', fetch }).explain(job('a'));
    expect(e).toMatchObject({ hash: 'h1', title: 'Load progress', summary: 'S', injects: null, model: 'claude-opus-x' });
  });

  it('uses the configured model', async () => {
    const { fetch, calls } = fakeFetch(200, ok);
    await createRouterClient({ url: 'http://r', apiKey: 'k', model: 'sonnet', fetch }).explain(job('a'));
    expect(bodyOf(calls[0]).model).toBe('sonnet');
  });
});

describe('router chat stream', () => {
  const chunk = (content: string) => `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content } }] })}\n\n`;
  function sseFetch(parts: string[], status = 200) {
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    const fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) });
      const stream = new ReadableStream({
        start(c) {
          // Split mid-event on purpose: the parser must buffer across reads.
          for (const p of parts) for (const half of [p.slice(0, 7), p.slice(7)]) c.enqueue(new TextEncoder().encode(half));
          c.close();
        },
      });
      return new Response(stream, { status, headers: { 'content-type': 'text/event-stream' } });
    }) as unknown as typeof globalThis.fetch;
    return { fetch, calls };
  }
  const collect = async (it: AsyncIterable<string | ToolCall | NativeTurn>) => {
    let out = '';
    for await (const d of it) if (typeof d === 'string') out += d;
    return out;
  };
  const events = async (it: AsyncIterable<string | ToolCall | NativeTurn>) => {
    const out: (string | ToolCall | NativeTurn)[] = [];
    for await (const d of it) out.push(d);
    return out;
  };
  const tools = [{ type: 'function' as const, function: { name: 'read_component', description: 'liest', parameters: { type: 'object', properties: {} } } }];

  it('sends the tools, the tool choice and the tool turns of the history', async () => {
    const { fetch, calls } = sseFetch([chunk('ok'), 'data: [DONE]\n\n']);
    const client = createRouterClient({ url: 'http://r', apiKey: 'k', fetch });
    const messages = [
      { role: 'user' as const, content: 'lies' },
      { role: 'assistant' as const, content: null, tool_calls: [{ id: 'c1', type: 'function' as const, function: { name: 'read_component', arguments: '{"name":"A"}' } }] },
      { role: 'tool' as const, tool_call_id: 'c1', content: 'Text A' },
    ];
    await collect(client.chat({ system: 's', messages, model: 'opus', tools, toolChoice: 'none' }));
    expect(calls[0].body).toMatchObject({ tools, tool_choice: 'none', messages: [{ role: 'system', content: 's' }, ...messages] });
  });

  it('sends no tools field when the request has none', async () => {
    const { fetch, calls } = sseFetch([chunk('ok'), 'data: [DONE]\n\n']);
    await collect(createRouterClient({ url: 'http://r', apiKey: 'k', fetch }).chat({ system: 's', messages: [], model: 'opus' }));
    expect(calls[0].body).not.toHaveProperty('tools');
    expect(calls[0].body).not.toHaveProperty('tool_choice');
  });

  it('yields the streamed tool calls after the text, arguments joined across deltas', async () => {
    const call = (index: number, extra: object) => `data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index, ...extra }] } }] })}\n\n`;
    const { fetch } = sseFetch([
      chunk('Let me read.'),
      call(0, { id: 'c1', type: 'function', function: { name: 'read_component', arguments: '{"name":' } }),
      call(0, { function: { arguments: '"A"}' } }),
      call(1, { id: 'c2', type: 'function', function: { name: 'read_component', arguments: '{"name":"B"}' } }),
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\n`,
      'data: [DONE]\n\n',
    ]);
    const client = createRouterClient({ url: 'http://r', apiKey: 'k', fetch });
    expect(await events(client.chat({ system: 's', messages: [], model: 'opus', tools }))).toEqual([
      'Let me read.',
      { id: 'c1', name: 'read_component', arguments: '{"name":"A"}' },
      { id: 'c2', name: 'read_component', arguments: '{"name":"B"}' },
    ]);
  });

  it('yields the tool calls of a router that answers once as JSON', async () => {
    const message = { content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_component', arguments: '{}' } }] };
    const fetch = (async () => new Response(JSON.stringify({ choices: [{ message, finish_reason: 'tool_calls' }] }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof globalThis.fetch;
    const client = createRouterClient({ url: 'http://r', apiKey: 'k', fetch });
    expect(await events(client.chat({ system: 's', messages: [], model: 'opus', tools }))).toEqual([{ id: 'c1', name: 'read_component', arguments: '{}' }]);
  });

  it('keeps the status of a refused request, so a missing tool permission can be told apart', async () => {
    const { fetch } = sseFetch([], 403);
    const client = createRouterClient({ url: 'http://r', apiKey: 'k', fetch });
    await expect(collect(client.chat({ system: 's', messages: [], model: 'opus', tools }))).rejects.toMatchObject({ status: 403 });
  });

  it('streams the text deltas and sends the system prompt first', async () => {
    const { fetch, calls } = sseFetch([`data: ${JSON.stringify({ choices: [{ delta: { role: 'assistant', content: '' } }] })}\n\n`, chunk('Hel'), chunk('lo'), 'data: [DONE]\n\n']);
    const client = createRouterClient({ url: 'http://r', apiKey: 'k', fetch });
    expect(await collect(client.chat({ system: 'SYS', messages: [{ role: 'user', content: 'hi' }], model: 'opus' }))).toBe('Hello');
    expect(calls[0].url).toBe('http://r/v1/chat/completions');
    expect(calls[0].body).toMatchObject({ model: 'opus', stream: true, messages: [{ role: 'system', content: 'SYS' }, { role: 'user', content: 'hi' }] });
  });

  it('raises the router error that ends a failed stream', async () => {
    const { fetch } = sseFetch([chunk('Part'), `data: ${JSON.stringify({ error: { message: 'Claude usage limit reached' } })}\n\n`]);
    const client = createRouterClient({ url: 'http://r', apiKey: 'k', fetch });
    await expect(collect(client.chat({ system: 's', messages: [], model: 'opus' }))).rejects.toThrow('usage limit');
  });

  it('fails a stream that ends without [DONE], so a cut answer never looks complete', async () => {
    const { fetch } = sseFetch([chunk('Half')]);
    const client = createRouterClient({ url: 'http://r', apiKey: 'k', fetch });
    await expect(collect(client.chat({ system: 's', messages: [], model: 'opus' }))).rejects.toThrow('[DONE]');
  });

  it('accepts a router that answers once as JSON instead of streaming', async () => {
    const fetch = (async () => new Response(JSON.stringify({ choices: [{ message: { content: 'Ganz' } }] }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof globalThis.fetch;
    const client = createRouterClient({ url: 'http://r', apiKey: 'k', fetch });
    expect(await collect(client.chat({ system: 's', messages: [], model: 'opus' }))).toBe('Ganz');
  });

  it('splits inside the blank line between events too', async () => {
    const parts = [chunk('A'), chunk('B'), 'data: [DONE]\n\n'].join('');
    const { fetch } = sseFetch(parts.split(/(?<=\n)(?=\n)/));
    const client = createRouterClient({ url: 'http://r', apiKey: 'k', fetch });
    expect(await collect(client.chat({ system: 's', messages: [], model: 'opus' }))).toBe('AB');
  });

  it('reports a busy router like the JSON calls do', async () => {
    const { fetch } = sseFetch([], 503);
    const client = createRouterClient({ url: 'http://r', apiKey: 'k', fetch });
    await expect(collect(client.chat({ system: 's', messages: [], model: 'opus' }))).rejects.toBeInstanceOf(RouterBusyError);
  });
});
