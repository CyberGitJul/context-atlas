import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';
import type { ReplayOptions, ReplayResult } from '../../src/shared/sessions.js';
import { createApp } from '../../src/server/app.js';
import { createExplanationCache } from '../../src/server/ai/cache.js';
import { createEventHub } from '../../src/server/events.js';
import { actionsOf, cutBefore, parseEntries, passages, prepareCopy, replayOnce, type QueryFn } from '../../src/server/sessions/replay.js';
import { makeFixtureHome } from '../helpers/fixture.js';

const HOME = '/home/ada';
const RULE = '## Package manager\n\nPrefer pnpm over npm.';
const CLAUDE_MD = `# Ada's rules\n\nBe brief.\n\n${RULE}\n\n## Tests\n\nRun the tests before a commit.\n`;

/** A session: instructions, your message, Claude's thinking and tool call (one response), its result, then a second call. */
function transcript(home = HOME) {
  const base = { sessionId: 'orig', cwd: `${home}/projects/atlas`, timestamp: '2026-10-13T10:00:00.000Z' };
  const rendered = [{ content: `<system-reminder>\nContents of ${home}/.claude/CLAUDE.md:\n\n${CLAUDE_MD.trim()}\n</system-reminder>` }];
  return [
    { type: 'queue-operation' },
    { ...base, type: 'attachment', uuid: 'u1', parentUuid: null, attachment: { type: 'instructions', files: [{ path: `${home}/.claude/CLAUDE.md`, type: 'User', content: CLAUDE_MD }, { path: `${home}/.claude/rules/old.md`, type: 'User', content: '# Old\n\nGone later.' }] }, rendered, renderedRole: 'user' },
    { ...base, type: 'attachment', uuid: 'u2', parentUuid: 'u1', attachment: { type: 'instructions', files: [], removed: [`${home}/.claude/rules/old.md`], changed: true }, rendered: [{ content: 'removed' }], renderedRole: 'user' },
    { ...base, type: 'user', uuid: 'u3', parentUuid: 'u2', message: { role: 'user', content: 'run the tests' } },
    { ...base, type: 'attachment', uuid: 'u4', parentUuid: 'u3', attachment: { type: 'hook_additional_context', content: ['Remember the rules.'], hookEvent: 'UserPromptSubmit' }, rendered: [{ content: 'Remember the rules.' }], renderedRole: 'system' },
    { ...base, type: 'assistant', uuid: 'a1', parentUuid: 'u4', message: { id: 'msg_1', model: 'claude-opus-5-5', content: [{ type: 'thinking', thinking: '' }], usage: { input_tokens: 10, cache_read_input_tokens: 41_990 } } },
    { ...base, type: 'assistant', uuid: 'a2', parentUuid: 'a1', message: { id: 'msg_1', model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'pnpm test', description: 'Run the tests' } }] } },
    { ...base, type: 'user', uuid: 'u5', parentUuid: 'a2', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } },
    { ...base, type: 'assistant', uuid: 'a3', parentUuid: 'u5', message: { id: 'msg_2', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'All tests pass.' }] } },
  ];
}
const jsonl = (home = HOME) => transcript(home).map((e) => JSON.stringify(e)).join('\n');

describe('cutBefore', () => {
  it('cuts before the whole response that holds the step and returns that response', () => {
    const cut = cutBefore(parseEntries(jsonl()), 'a2')!;
    expect(cut.kept.at(-1)!.uuid).toBe('u4');
    expect(cut.response.map((e) => e.uuid)).toEqual(['a1', 'a2']);
  });

  it('cuts mid-turn after the tool result', () => {
    const cut = cutBefore(parseEntries(jsonl()), 'a3')!;
    expect(cut.kept.at(-1)!.uuid).toBe('u5');
    expect(cut.response.map((e) => e.uuid)).toEqual(['a3']);
  });

  it('refuses steps that are not Claude’s or not in the transcript', () => {
    const entries = parseEntries(jsonl());
    expect(cutBefore(entries, 'u3')).toBeNull();
    expect(cutBefore(entries, 'nope')).toBeNull();
  });
});

describe('passages', () => {
  it('lists the sections of the files in effect, latest copy, removed files left out', () => {
    const list = passages(cutBefore(parseEntries(jsonl()), 'a2')!.kept, HOME);
    expect(list.map((p) => [p.id, p.file, p.heading])).toEqual([
      ['0.0', '~/.claude/CLAUDE.md', 'Ada\'s rules'],
      ['0.1', '~/.claude/CLAUDE.md', 'Package manager'],
      ['0.2', '~/.claude/CLAUDE.md', 'Tests'],
    ]);
    expect(list[1].text).toBe(RULE);
    expect(list[2].text).toBe('## Tests\n\nRun the tests before a commit.');
  });
});

describe('prepareCopy', () => {
  it('freezes tracked attachments into the text Claude saw and rekeys the copy', () => {
    const kept = cutBefore(parseEntries(jsonl()), 'a2')!.kept;
    const { entries } = prepareCopy(kept, 'copy');
    const frozen = entries.find((e) => e.uuid === 'u1')!;
    expect(frozen).toMatchObject({ type: 'user', isMeta: true, sessionId: 'copy', parentUuid: null });
    expect(frozen.message.content[0].text).toContain('Prefer pnpm');
    expect(frozen.attachment).toBeUndefined();
    // Other attachments stay as they are.
    expect(entries.find((e) => e.uuid === 'u4')!.type).toBe('attachment');
    expect(kept.find((e) => e.uuid === 'u1')!.type).toBe('attachment');
  });

  it('takes the passage out of every text it appears in', () => {
    const kept = cutBefore(parseEntries(jsonl()), 'a2')!.kept;
    const { entries, hits } = prepareCopy(kept, 'copy', { from: RULE, to: '' });
    expect(hits).toBe(1);
    expect(JSON.stringify(entries)).not.toContain('Prefer pnpm');
    expect(JSON.stringify(entries)).toContain('Run the tests before a commit.');
  });
});

describe('actionsOf', () => {
  it('titles tool calls as the timeline does and masks the home folder', () => {
    const actions = actionsOf([{ type: 'thinking' }, { type: 'tool_use', name: 'Read', input: { file_path: `${HOME}/x.md` } }, { type: 'text', text: 'Done.\nMore.' }], HOME);
    expect(actions).toEqual([
      { kind: 'tool', tool: 'Read', title: 'Read: ~/x.md', text: '{\n  "file_path": "~/x.md"\n}' },
      { kind: 'answer', title: 'Done.', text: 'Done.\nMore.' },
    ]);
  });
});

/** A stand-in for the SDK: reads the copy through the session store and answers with one tool call, then its refusal. */
function fakeQuery(answer: (entries: unknown[]) => unknown[], seen: { options: Options; entries: unknown[] }[] = []): QueryFn {
  return (params) =>
    (async function* () {
      const options = params.options!;
      const entries = (await options.sessionStore!.load({ projectKey: 'any', sessionId: options.resume! })) ?? [];
      seen.push({ options, entries });
      yield { type: 'system', subtype: 'init' } as unknown as SDKMessage;
      yield { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'thinking', thinking: '' }] } } as unknown as SDKMessage;
      yield { type: 'assistant', parent_tool_use_id: null, message: { content: answer(entries) } } as unknown as SDKMessage;
      yield { type: 'user', message: { content: [{ type: 'tool_result', content: 'denied' }] } } as unknown as SDKMessage;
      throw new Error('read past the end');
    })();
}

describe('replayOnce', () => {
  it('resumes the copy from memory with every tool refused and returns the first response', async () => {
    const seen: { options: Options; entries: unknown[] }[] = [];
    const blocks = await replayOnce({ entries: [{ type: 'user', uuid: 'x' }], sessionId: 'copy', cwd: '/w', model: 'claude-opus-5-5', query: fakeQuery(() => [{ type: 'tool_use', name: 'Bash', input: {} }], seen) });
    expect(blocks).toEqual([{ type: 'thinking', thinking: '' }, { type: 'tool_use', name: 'Bash', input: {} }]);
    const o = seen[0].options;
    expect(seen[0].entries).toEqual([{ type: 'user', uuid: 'x' }]);
    expect(o).toMatchObject({ resume: 'copy', cwd: '/w', model: 'claude-opus-5-5', settingSources: [], permissionMode: 'dontAsk', maxTurns: 1, strictMcpConfig: true });
    expect(o.env?.CLAUDE_CODE_RESUME_INTERRUPTED_TURN).toBe('1');
    const hook = o.hooks!.PreToolUse![0].hooks[0];
    expect(await hook({} as never, undefined, { signal: new AbortController().signal })).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
    expect(await o.canUseTool!('Bash', {}, {} as never)).toMatchObject({ behavior: 'deny' });
  });

  it('fails with the reason when Claude Code ends without a response', async () => {
    const q: QueryFn = () =>
      (async function* () {
        yield { type: 'result', subtype: 'error_during_execution', errors: ['No conversation found'] } as unknown as SDKMessage;
      })();
    await expect(replayOnce({ entries: [], sessionId: 'copy', cwd: '/w', model: 'm', query: q })).rejects.toThrow('error_during_execution: No conversation found');
  });
});

async function setup(replay: { query?: QueryFn } | null) {
  const ctx = await makeFixtureHome();
  const cache = createExplanationCache(path.join(await mkdtemp(path.join(tmpdir(), 'atlas-replay-')), 'e.json'));
  await cache.load();
  const dir = path.join(ctx.claudeDir, 'projects', '-home-ada-projects-atlas');
  await mkdir(dir, { recursive: true });
  await mkdir(path.join(ctx.homeDir, 'projects', 'atlas'), { recursive: true });
  await writeFile(path.join(dir, 'cccccccc-0000-4000-8000-000000000003.jsonl'), jsonl(ctx.homeDir));
  const app = createApp({ ctx, ai: { cache, queue: null, events: createEventHub() }, allowedHosts: ['localhost'], replay });
  return { app, url: '/api/sessions/-home-ada-projects-atlas/cccccccc-0000-4000-8000-000000000003/steps' };
}

const post = (body: object) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
// Step indexes of the timeline: 0 instructions, 1 prompt, 2 hook, 3 tool (a2), 4 answer (a3).
const TOOL_STEP = 3;

describe('replay routes', () => {
  it('lists the sections in effect at a step and the context size', async () => {
    const { app, url } = await setup({});
    const res = await app.request(`${url}/${TOOL_STEP}/replay`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ReplayOptions;
    expect(body).toMatchObject({ tokens: 42_000, off: null });
    expect(body.sections.map((s) => s.heading)).toEqual(['Ada\'s rules', 'Package manager', 'Tests']);
    expect(JSON.stringify(body)).not.toContain('Prefer pnpm');
  });

  it('runs the step as it was and without the section, and returns both next to the original', async () => {
    const seen: { options: Options; entries: unknown[] }[] = [];
    const answer = (entries: unknown[]) => [{ type: 'tool_use', name: 'Bash', input: { command: JSON.stringify(entries).includes('Prefer pnpm') ? 'pnpm test' : 'npm test' } }];
    const { app, url } = await setup({ query: fakeQuery(answer, seen) });
    const res = await app.request(`${url}/${TOOL_STEP}/replay`, post({ section: '0.1' }));
    expect(res.status).toBe(200);
    const r = (await res.json()) as ReplayResult;
    expect(r.original.map((a) => a.title)).toEqual(['Bash: Run the tests']);
    expect(r.asIs[0].text).toContain('pnpm test');
    expect(r.changed[0].text).toContain('npm test');
    expect(r.changed[0].text).not.toContain('pnpm');
    expect(r).toMatchObject({ model: 'claude-opus-5-5', section: { id: '0.1', heading: 'Package manager' } });
    expect('text' in r.section).toBe(false);
    expect(seen).toHaveLength(2);
    expect(new Set(seen.map((s) => s.options.resume)).size).toBe(2);
  });

  it('refuses steps Claude did not take, unknown sections and a missing replay', async () => {
    const { app, url } = await setup({ query: fakeQuery(() => []) });
    expect((await app.request(`${url}/1/replay`)).status).toBe(400);
    expect((await app.request(`${url}/99/replay`)).status).toBe(404);
    expect((await app.request(`${url}/${TOOL_STEP}/replay`, post({ section: '7.7' }))).status).toBe(400);
    const off = await setup(null);
    const opts = (await (await off.app.request(`${off.url}/${TOOL_STEP}/replay`)).json()) as ReplayOptions;
    expect(opts.off).toBeTruthy();
    expect((await off.app.request(`${off.url}/${TOOL_STEP}/replay`, post({ section: '0.1' }))).status).toBe(503);
  });

  it('reports a failed run', async () => {
    const q: QueryFn = () =>
      (async function* () {
        yield { type: 'result', subtype: 'error_during_execution', errors: ['boom'] } as unknown as SDKMessage;
      })();
    const { app, url } = await setup({ query: q });
    const res = await app.request(`${url}/${TOOL_STEP}/replay`, post({ section: '0.1' }));
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toContain('boom');
  });
});
