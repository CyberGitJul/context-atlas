import { describe, expect, it } from 'vitest';
import { parseTimeline } from '../../src/server/sessions/timeline.js';

const HOME = '/home/ada';
const base = { sessionId: 's1', cwd: `${HOME}/projects/atlas`, isSidechain: false, timestamp: '2026-10-13T10:00:00.000Z' };
const user = (content: unknown, extra: object = {}) => ({ ...base, type: 'user', message: { role: 'user', content }, ...extra });
const assistant = (content: unknown[]) => ({ ...base, type: 'assistant', message: { role: 'assistant', content } });
const attachment = (a: object) => ({ ...base, type: 'attachment', attachment: a });
const parse = (...entries: object[]) => parseTimeline(entries.map((e) => JSON.stringify(e)).join('\n'), HOME);
const kinds = (r: ReturnType<typeof parse>) => r.steps.map((s) => `${s.kind}:${s.title}`);

describe('parseTimeline', () => {
  it('turns your message into a prompt step, titled by its first line', () => {
    const r = parse(user('resume\nand then more'));
    expect(kinds(r)).toEqual(['prompt:resume']);
    expect(r.steps[0].text).toBe('resume\nand then more');
  });

  it('shows a local command once and drops its caveat and empty output', () => {
    const r = parse(
      user('<local-command-caveat>The command below was run directly …</local-command-caveat>', { isMeta: true }),
      user('<command-name>/clear</command-name>\n<command-message>clear</command-message>\n<command-args></command-args>'),
      user('<local-command-stdout></local-command-stdout>'),
    );
    expect(kinds(r)).toEqual(['notice:/clear']);
    expect(r.steps[0].text).toBe('/clear');
  });

  it('lists the instruction files that were loaded, with ~ for the home folder', () => {
    const r = parse(
      attachment({
        type: 'instructions',
        files: [
          { path: `${HOME}/.claude/CLAUDE.md`, type: 'User', content: '## Rule A\nDo it.' },
          { path: `${HOME}/.claude/rules/x.md`, type: 'User', content: 'Rule X' },
        ],
      }),
    );
    expect(kinds(r)).toEqual(['instructions:Instructions: ~/.claude/CLAUDE.md, ~/.claude/rules/x.md']);
    expect(r.steps[0].text).toContain('## Rule A\nDo it.');
    expect(r.steps[0].text).not.toContain(HOME);
  });

  it('shows hook texts with their event and the tool they ran before', () => {
    const r = parse(
      attachment({ type: 'hook_additional_context', hookEvent: 'SessionStart', toolUseID: 'SessionStart', content: ['Resume from PROGRESS.md', 'You have superpowers.'] }),
      assistant([{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'gh run list', description: 'List CI runs' } }]),
      attachment({ type: 'hook_additional_context', hookEvent: 'PreToolUse', toolUseID: 't1', content: ['Use the web-research subagent.'] }),
      attachment({ type: 'hook_success', hookEvent: 'PreToolUse', toolUseID: 't1', stdout: '{}', exitCode: 0 }),
    );
    expect(kinds(r)).toEqual(['hook:SessionStart hook', 'tool:Bash: List CI runs', 'hook:PreToolUse hook on Bash']);
    expect(r.steps[0].text).toBe('Resume from PROGRESS.md\n\nYou have superpowers.');
  });

  it('marks a hook that blocked', () => {
    const r = parse(attachment({ type: 'hook_blocking_error', hookEvent: 'Stop', blockingError: { blockingError: 'Context is large', command: 'auto-progress.sh stop' } }));
    expect(kinds(r)).toEqual(['hook:Stop hook blocked']);
    expect(r.steps[0].error).toBe(true);
    expect(r.steps[0].text).toContain('Context is large');
  });

  it('counts the feedback of a blocking Stop hook as a hook', () => {
    const r = parse(user('Stop hook feedback:\nContext is large', { isMeta: true }));
    expect(kinds(r)).toEqual(['hook:Stop hook feedback']);
  });

  it('shows a skill call by Claude and the skill body that came in after it', () => {
    const r = parse(
      assistant([{ type: 'tool_use', id: 't2', name: 'Skill', input: { skill: 'progress-clear-resume', args: 'resume' } }]),
      user([{ type: 'tool_result', tool_use_id: 't2', content: 'Launching skill: progress-clear-resume' }]),
      user([{ type: 'text', text: 'Base directory for this skill: /x\n\n# PROGRESS.md' }], { isMeta: true, sourceToolUseID: 't2' }),
    );
    expect(kinds(r)).toEqual(['tool:Skill: progress-clear-resume', 'skill:Skill text: progress-clear-resume']);
    expect(r.steps[1].text).toContain('# PROGRESS.md');
  });

  it('puts the tool result into the tool step and marks failures', () => {
    const r = parse(
      assistant([{ type: 'tool_use', id: 't3', name: 'Read', input: { file_path: `${HOME}/a.ts` } }]),
      user([{ type: 'tool_result', tool_use_id: 't3', is_error: true, content: [{ type: 'text', text: 'File does not exist.' }] }]),
    );
    expect(kinds(r)).toEqual(['tool:Read: ~/a.ts']);
    expect(r.steps[0].error).toBe(true);
    expect(r.steps[0].text).toContain('File does not exist.');
  });

  it('shows Claude answers and skips thinking and bookkeeping entries', () => {
    const r = parse(
      assistant([{ type: 'thinking', thinking: '', signature: 'x' }, { type: 'text', text: 'Verstanden: resume.' }]),
      attachment({ type: 'total_tokens_reminder' }),
      attachment({ type: 'deferred_tools_record' }),
      { ...base, type: 'last-prompt' },
    );
    expect(kinds(r)).toEqual(['answer:Verstanden: resume.']);
  });

  it('keeps a message sent while Claude was working, without image data', () => {
    const r = parse(
      attachment({ type: 'queued_command', commandMode: 'prompt', prompt: [{ type: 'text', text: 'look at this' }, { type: 'image', source: { type: 'base64', data: 'iVBORw0KGgo' } }] }),
      attachment({ type: 'queued_command', commandMode: 'task-notification', prompt: '<task-notification>\n<status>completed</status>\n</task-notification>' }),
    );
    expect(kinds(r)).toEqual(['prompt:look at this', 'notice:Task notification']);
    expect(r.steps[0].text).toBe('look at this\n[image]');
  });

  it('shows where the context was compacted', () => {
    const r = parse({ ...base, type: 'system', subtype: 'compact_boundary', content: 'Conversation compacted', compactMetadata: { trigger: 'auto', preTokens: 477905 } });
    expect(kinds(r)).toEqual(['notice:Context compacted (auto, 477905 tokens before)']);
  });

  it('masks secrets and the home folder in every text', () => {
    const r = parse(user(`token=abc123 in ${HOME}/x`));
    expect(r.steps[0].text).toBe('token=*** in ~/x');
    expect(r.steps[0].title).toBe('token=*** in ~/x');
  });

  it('skips broken lines and subagent entries, and takes title and folder from the file', () => {
    const r = parseTimeline(
      ['{not json', JSON.stringify({ ...base, isSidechain: true, type: 'user', message: { content: 'inner' } }), JSON.stringify(user('hello')), JSON.stringify({ type: 'ai-title', aiTitle: 'First' }), JSON.stringify({ type: 'ai-title', aiTitle: 'Latest' })].join('\n'),
      HOME,
    );
    expect(kinds(r)).toEqual(['prompt:hello']);
    expect(r.title).toBe('Latest');
    expect(r.cwd).toBe('~/projects/atlas');
  });

  it('numbers the steps in order', () => {
    const r = parse(user('a'), user('b'));
    expect(r.steps.map((s) => s.i)).toEqual([0, 1]);
  });
});
