import { describe, expect, it } from 'vitest';
import { checkWhy, whyContext, whyPrompt } from '../../src/server/sessions/why.js';
import type { FullStep } from '../../src/server/sessions/timeline.js';

let n = 0;
const step = (kind: FullStep['kind'], title: string, text = title): FullStep => ({ i: n++, at: '2026-10-13T10:00:00.000Z', kind, title, preview: '', chars: text.length, text });
const session = () => {
  n = 0;
  return [
    step('hook', 'SessionStart hook', 'Resume from PROGRESS.md.'),
    step('instructions', 'Instructions: ~/.claude/CLAUDE.md', '# ~/.claude/CLAUDE.md (User)\n\nOld rules.'),
    step('prompt', 'first'),
    step('tool', 'Skill: progress-md'),
    step('skill', 'Skill text: progress-md', 'Keep PROGRESS.md current.'),
    step('instructions', 'Instructions: ~/.claude/CLAUDE.md', '# ~/.claude/CLAUDE.md (User)\n\nUse the web-research subagent for GitHub research.'),
    step('hook', 'PreToolUse hook on Bash', 'Old turn reminder.'),
    step('prompt', 'go'),
    step('hook', 'UserPromptSubmit hook', 'USER MESSAGE: go'),
    step('answer', 'Pushed.'),
    step('tool', 'Bash: Wait for CI', '{"command":"gh run watch"}'),
    step('hook', 'PreToolUse hook on Bash', 'Prefer the web-research subagent.'),
    step('notice', 'Task notification'),
  ];
};

describe('whyContext', () => {
  it('gathers your message, this turn and the instructions in effect, newest version only', () => {
    const c = whyContext(session(), 10)!;
    expect(c.action.title).toBe('Bash: Wait for CI');
    expect(c.turn.map((s) => s.title)).toEqual(['Pushed.']);
    expect(c.blocks.map((b) => b.label)).toEqual([
      'Your message',
      'UserPromptSubmit hook',
      'PreToolUse hook on Bash (arrived with the result of this step)',
      'Skill text: progress-md',
      'Instructions: ~/.claude/CLAUDE.md',
      'SessionStart hook',
    ]);
    expect(c.blocks.find((b) => b.label.startsWith('Instructions'))!.text).toContain('web-research subagent for GitHub');
    expect(c.blocks.map((b) => b.id)).toEqual(['S1', 'S2', 'S3', 'S4', 'S5', 'S6']);
  });

  it('explains only what Claude did', () => {
    const steps = session();
    expect(whyContext(steps, 7)).toBeNull();
    expect(whyContext(steps, 4)).toBeNull();
    expect(whyContext(steps, 99)).toBeNull();
  });

  it('leaves out the least important sources when the texts get too long', () => {
    const c = whyContext(session(), 10, 120)!;
    expect(c.blocks.map((b) => b.label)).toEqual(['Your message', 'UserPromptSubmit hook', 'PreToolUse hook on Bash (arrived with the result of this step)', 'Skill text: progress-md']);
    expect(c.dropped).toEqual(['Instructions: ~/.claude/CLAUDE.md', 'SessionStart hook']);
  });
});

describe('whyPrompt', () => {
  it('shows the action, the turn so far and every source with its id', () => {
    const p = whyPrompt(whyContext(session(), 10)!);
    expect(p).toContain('# CLAUDE’S ACTION (Bash: Wait for CI)\n{"command":"gh run watch"}');
    expect(p).toContain('- Pushed.');
    expect(p).toContain('## [S3] PreToolUse hook on Bash (arrived with the result of this step)\nPrefer the web-research subagent.');
  });
});

describe('checkWhy', () => {
  it('names the sources and checks each quote against its own source', () => {
    const c = whyContext(session(), 10)!;
    const r = checkWhy(
      {
        verdict: 'The user said go.',
        steered: [{ source: 'S1', quote: 'go', how: 'Pushing was asked for.' }],
        ignored: [
          { source: 'S3', quote: 'Prefer the  **web-research** subagent', why: 'A CI check is no research.' },
          { source: 'S1', quote: 'web-research', why: 'Wrong source.' },
          { source: 'S9', quote: 'x', why: 'Unknown source.' },
        ],
      },
      c,
      'opus',
    );
    expect(r.steered).toEqual([{ source: 'Your message', quote: 'go', note: 'Pushing was asked for.', quoteFound: true }]);
    expect(r.ignored.map((x) => [x.source, x.quoteFound])).toEqual([
      ['PreToolUse hook on Bash (arrived with the result of this step)', true],
      ['Your message', false],
      ['S9', false],
    ]);
    expect(r).toMatchObject({ verdict: 'The user said go.', sources: 6, model: 'opus' });
  });

  it('rejects an answer without its fields', () => {
    expect(() => checkWhy({ verdict: 'x' }, whyContext(session(), 10)!, 'opus')).toThrow();
  });
});
