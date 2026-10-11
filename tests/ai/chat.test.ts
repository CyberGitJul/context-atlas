import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { areaFor, areaForFile, assembleSystem, CHAT_AREAS, type ChatArea, detailContext, loadChatPrompts, newContext, overviewContext } from '../../src/server/ai/chat.js';
import type { Component } from '../../src/shared/model.js';

const comp = (over: Partial<Component>): Component => ({
  id: 'x', kind: 'instruction', name: 'N', origin: { type: 'user' }, phases: ['always'], sourcePath: '/h/.claude/CLAUDE.md',
  enabled: true, summary: 'Short.', contextWords: 12, hash: 'h', detail: {}, ...over,
});

describe('areaFor', () => {
  it.each<[Component | null, boolean, ChatArea]>([
    [null, false, 'overview'],
    [comp({ kind: 'instruction' }), true, 'instruction'],
    [comp({ kind: 'rule' }), true, 'instruction'],
    [comp({ kind: 'skill' }), true, 'skill'],
    [comp({ kind: 'skill', origin: { type: 'plugin', plugin: 'p' } }), false, 'other'],
    [comp({ kind: 'instruction' }), false, 'other'],
    [comp({ kind: 'mcp' }), false, 'other'],
    [comp({ kind: 'hook' }), true, 'hook'],
    [comp({ kind: 'hook', origin: { type: 'plugin', plugin: 'p' } }), false, 'hook'],
    [comp({ kind: 'memory' }), false, 'memory'],
    [comp({ kind: 'agent' }), true, 'agent'],
    [comp({ kind: 'command', origin: { type: 'plugin', plugin: 'p' } }), false, 'agent'],
    [comp({ kind: 'output-style' }), true, 'agent'],
  ])('%#: picks the area by kind and editability', (c, editable, area) => {
    expect(areaFor(c, editable)).toBe(area);
  });

  it.each<[string, ChatArea]>([
    ['/h/.claude/skills/new/SKILL.md', 'skill'],
    ['/h/.claude/agents/helper.md', 'agent'],
    ['/h/.claude/commands/sub/do-it.md', 'agent'],
    ['/h/.claude/output-styles/terse.md', 'agent'],
    ['/h/.claude/hooks/check.sh', 'hook'],
    ['/h/.claude/rules/style.md', 'other'],
    ['/h/.claude/skills/new/help.md', 'other'],
  ])('a proposed file %s gets the area of its kind', (file, area) => {
    expect(areaForFile(file, '/h/.claude')).toBe(area);
  });
});

describe('page context', () => {
  it('lists every component with origin, timing and cost on the overview, plus the hints', () => {
    const text = overviewContext({
      components: [comp({ name: 'Rule A' }), comp({ id: 's', kind: 'skill', name: 'tool', origin: { type: 'plugin', plugin: 'sp' }, phases: ['on-demand'], enabled: false, contextWords: 0 })],
      hints: [{ id: 'h', severity: 'warn', text: 'Too long', componentIds: [] }],
      explanations: {},
    });
    expect(text).toContain('Warning: Too long');
    expect(text).toContain('Instruction (CLAUDE.md) “Rule A” (own; always in context; 12 words in context): Short.');
    expect(text).toContain('Skill “tool” (Plugin sp; Claude thinks; disabled)');
  });

  it('gives the detail page the editor text masked, the links and a short form of the other sources', () => {
    const c = comp({ id: 'me', name: 'Project index' });
    const text = detailContext({
      component: c, text: 'token=sk-ant-abcdefghijklmnopqrstuvwxyz0123 new', savedText: 'old', editable: true, readOnlyReason: null, file: '/h/.claude/CLAUDE.md',
      links: { pointers: [{ name: 'pi', state: 'ok', skillId: 's' }], referencedBy: [], sourcedBy: [], choices: [] },
      hints: [{ id: 'x', severity: 'warn', text: 'concerns me', componentIds: ['me'] }, { id: 'y', severity: 'info', text: 'other', componentIds: ['z'] }],
      others: [c, comp({ id: 'o', name: 'Other rule' }), comp({ id: 'off', name: 'Off', enabled: false })],
      explanations: {},
    });
    expect(text).toContain('Editable: yes.');
    expect(text).toContain('Unsaved changes in the editor: yes.');
    expect(text).toContain('Belongs to skill “pi”');
    expect(text).toContain('concerns me');
    expect(text).not.toContain('other\n');
    expect(text).not.toContain('sk-ant-abcdefghijklmnopqrstuvwxyz0123');
    expect(text).toContain('“Other rule”');
    expect(text).not.toContain('“Off”');
  });

  const noLinks = { pointers: [], referencedBy: [], sourcedBy: [], choices: [] };

  it('gives a hook page its event, matcher, what it injects and the other hooks of that event', () => {
    const hook = comp({
      id: 'h1', kind: 'hook', name: 'check.sh', phases: ['tool'], contextWords: 0, hash: 'hh', sourcePath: '/h/.claude/hooks/check.sh',
      detail: { event: 'PreToolUse', matcher: 'Bash', type: 'command', command: 'bash ~/.claude/hooks/check.sh', hasScript: true },
    });
    const sibling = comp({ id: 'h2', kind: 'hook', name: 'log.sh', phases: ['tool'], summary: 'bash log.sh', detail: { event: 'PreToolUse', matcher: '*', hasScript: true } });
    const later = comp({ id: 'h3', kind: 'hook', name: 'start.sh', phases: ['session-start'], detail: { event: 'SessionStart', matcher: '*', hasScript: true } });
    const text = detailContext({
      component: hook, text: '#!/bin/bash\necho hi', savedText: '#!/bin/bash\necho hi', editable: true, readOnlyReason: null, file: '/h/.claude/hooks/check.sh',
      links: noLinks, hints: [], others: [hook, sibling, later],
      explanations: { hh: { hash: 'hh', title: 'Checks Bash', summary: 'Blockt rm -rf.', injects: 'Warning on rm', at: '' } },
    });
    expect(text).toContain('Event: PreToolUse, matcher: Bash, type: command');
    expect(text).toContain('Command: bash ~/.claude/hooks/check.sh');
    expect(text).toContain('AI explanation: Blockt rm -rf.');
    expect(text).toContain('Injects: Warning on rm');
    expect(text).toContain('Other hooks on PreToolUse:');
    expect(text).toContain('“log.sh” (Matcher *; own): bash log.sh');
    expect(text).not.toContain('“start.sh”');
    expect(text).toContain('echo hi');
  });

  it('shows a hook without script by its command, not the whole settings.json', () => {
    const hook = comp({ id: 'h1', kind: 'hook', name: 'echo done', phases: ['end'], sourcePath: '/h/.claude/settings.json', detail: { event: 'Stop', matcher: '*', command: 'echo done', hasScript: false } });
    const settings = '{"permissions":{"allow":["Bash(ls)"]}}';
    const text = detailContext({
      component: hook, text: settings, savedText: settings, editable: false, readOnlyReason: 'The command is inline in settings.json.', file: '/h/.claude/settings.json',
      links: noLinks, hints: [], others: [hook], explanations: {},
    });
    expect(text).toContain('Command: echo done');
    expect(text).toContain('Other hooks on Stop: none');
    expect(text).not.toContain('permissions');
  });

  it('tells a memory page its project and how its notes are loaded', () => {
    const mem = comp({ id: 'm', kind: 'memory', name: 'wiki', summary: '2 notes', detail: { files: 2, project: '-home-j-projects-wiki' } });
    const notes = '==> MEMORY.md <==\n- [A](a.md) — one\n\n==> a.md <==\nContent A\n';
    const text = detailContext({
      component: mem, text: notes, savedText: notes, editable: false, readOnlyReason: 'maintained by Claude Code', file: '/h/.claude/projects/-home-j-projects-wiki/memory',
      links: noLinks, hints: [], others: [mem, comp({ id: 'r', name: 'Rule A' })], explanations: {},
    });
    expect(text).toContain('Memory of project “wiki”');
    expect(text).toContain('MEMORY.md is in context in every session of this project');
    expect(text).toContain('==> a.md <==\nContent A');
    expect(text).toContain('“Rule A”');
  });

  it('lists commands and output styles beside agents and skills on an agent page', () => {
    const agent = comp({ id: 'a', kind: 'agent', name: 'web-research', phases: ['on-demand'] });
    const text = detailContext({
      component: agent, text: '---\nname: web-research\n---\nYou research.', savedText: 'x', editable: true, readOnlyReason: null, file: '/h/.claude/agents/web-research.md',
      links: noLinks, hints: [], explanations: {},
      others: [agent, comp({ id: 'c', kind: 'command', name: 'deploy', phases: ['on-demand'] }), comp({ id: 'o', kind: 'output-style', name: 'terse', phases: ['always'] })],
    });
    expect(text).toContain('Slash command “deploy”');
    expect(text).toContain('Output style “terse”');
  });
});

describe('linked components', () => {
  it('sends the full text of linked components and leaves them out of the short list', () => {
    const c = comp({ id: 'me', name: 'Project index' });
    const skill = comp({ id: 'sk', kind: 'skill', name: 'project-index-upkeep', phases: ['on-demand'], summary: 'Use when …' });
    const text = detailContext({
      component: c, text: 'Ablauf: Skill `project-index-upkeep`.', savedText: 'Ablauf: Skill `project-index-upkeep`.', editable: true, readOnlyReason: null, file: null,
      links: { pointers: [{ name: 'project-index-upkeep', state: 'ok', skillId: 'sk' }], referencedBy: [], sourcedBy: [], choices: [] },
      hints: [], others: [c, skill], explanations: {},
      linked: [{ component: skill, text: '---\nname: project-index-upkeep\n---\n# Procedure\n1. Ask' }],
    });
    expect(text).toContain('Linked components (in full):');
    expect(text).toContain('Skill “project-index-upkeep”');
    expect(text).toContain('1. Ask');
    expect(text).not.toContain('- Skill “project-index-upkeep”');
  });

  it('marks a linked text that had to be cut, so it is never rewritten as a whole file', () => {
    const c = comp({ id: 'me', name: 'Project index' });
    const skill = comp({ id: 'sk', kind: 'skill', name: 'large', phases: ['on-demand'] });
    const text = detailContext({
      component: c, text: 'x', savedText: 'x', editable: true, readOnlyReason: null, file: null,
      links: { pointers: [{ name: 'large', state: 'ok', skillId: 'sk' }], referencedBy: [], sourcedBy: [], choices: [] },
      hints: [], others: [c, skill], explanations: {},
      linked: [{ component: skill, text: 'a'.repeat(40_000) }],
    });
    expect(text).toContain('Linked components:');
    expect(text).toContain('(cut: 30000 of 40000 characters; do not rewrite as a whole file)');
  });
});

describe('prompts', () => {
  it('ships a base prompt and one prompt per area, assembled in that order', async () => {
    const dir = path.join(process.cwd(), 'config', 'prompts');
    for (const area of Object.keys(CHAT_AREAS) as (keyof typeof CHAT_AREAS)[]) {
      const p = await loadChatPrompts({ generic: dir }, area);
      expect(p.base).toContain('````proposal');
      expect(p.area.length).toBeGreaterThan(100);
    }
    const sys = assembleSystem({ base: 'BASE', area: 'AREA' }, 'skill', 'CONTEXT');
    expect(sys.indexOf('BASE')).toBeLessThan(sys.indexOf('# Area: Optimize skill'));
    expect(sys.indexOf('AREA')).toBeLessThan(sys.indexOf('CONTEXT'));
  });

  it('ships an empty personal addition, so the generic prompts address no one in particular', async () => {
    const p = await loadChatPrompts({ generic: path.join(process.cwd(), 'config', 'prompts') }, 'skill');
    expect(p.personal).toBe('');
    expect(p.sources).toEqual({ base: 'generic', area: 'generic', personal: 'generic' });
    const sys = assembleSystem({ base: 'BASE', area: 'AREA', personal: 'The user is called Alex.' }, 'skill', 'CONTEXT');
    expect(sys.indexOf('BASE')).toBeLessThan(sys.indexOf('# Personal'));
    expect(sys.indexOf('The user is called Alex.')).toBeLessThan(sys.indexOf('# Area: Optimize skill'));
    expect(assembleSystem({ base: 'BASE', area: 'AREA', personal: '' }, 'skill', 'C')).not.toContain('# Personal');
  });
});

describe('new skill', () => {
  it('lists every skill with its full description and the instructions, and offers no text to edit', () => {
    const long = `Use when ${'a'.repeat(400)} end-of-description`;
    const text = newContext('skill', {
      components: [comp({ id: 's1', kind: 'skill', name: 'project-index-upkeep', phases: ['on-demand'], summary: long }), comp({ id: 'i1', name: 'Project index' })],
      hints: [], explanations: {},
    });
    expect(text).toContain('Editable: no');
    expect(text).toContain('`project-index-upkeep`');
    expect(text).toContain('end-of-description');
    expect(text).toContain('“Project index”');
  });
});

describe('new rule, agent, command', () => {
  const page = {
    components: [
      comp({ id: 'i1', name: 'Project index' }),
      comp({ id: 'r1', kind: 'rule', name: 'antipatterns.md', summary: 'Avoid offset pagination.' }),
      comp({ id: 's1', kind: 'skill', name: 'wiki-docs', phases: ['on-demand'], summary: 'Use when something should be documented.' }),
      comp({ id: 'a1', kind: 'agent', name: 'web-research', phases: ['on-demand'], summary: 'Use for any web research.' }),
      comp({ id: 'c1', kind: 'command', name: 'deploy', phases: ['on-demand'], summary: 'Deploys the app.' }),
    ],
    hints: [], explanations: {},
  };

  it('a new rule is checked against every instruction and rule, skills in short', () => {
    const text = newContext('rule', page);
    expect(text).toContain('Page: Create new rule.');
    expect(text).toContain('~/.claude/rules/<name>.md');
    expect(text).toContain('Editable: no');
    expect(text).toMatch(/Instructions and rules \(2\)[^\n]*duplicates/);
    expect(text).toContain('Rule “antipatterns.md”');
    expect(text).toContain('Skill “wiki-docs”');
  });

  it('a new agent is checked against every agent and the skills', () => {
    const text = newContext('agent', page);
    expect(text).toContain('~/.claude/agents/<name>.md');
    expect(text).toMatch(/Existing subagents \(1\)[^\n]*duplicates/);
    expect(text).toContain('`web-research`');
    expect(text).toContain('Use for any web research.');
    expect(text).toContain('Skill “wiki-docs”');
  });

  it('a new command is checked against commands and skills, which share the /name', () => {
    const text = newContext('command', page);
    expect(text).toContain('~/.claude/commands/<name>.md');
    expect(text).toMatch(/Existing slash commands \(1\)[^\n]*duplicates/);
    expect(text).toContain('`deploy`');
    expect(text).toContain('`wiki-docs`');
  });
});
