import { describe, expect, it } from 'vitest';
import type { Component } from '../src/shared/model.js';
import { ensurePointer, keepPointers, linksFor, pointOnlyTo, resolveLinks, retargetPointer, skillifyBlock, skillPointers } from '../src/shared/skill-links.js';

function skill(name: string, enabled = true, plugin?: string): Component {
  return {
    id: `skill:${plugin ? `plugin:${plugin}` : 'user'}:${name}:${name}`, kind: 'skill', name, origin: plugin ? { type: 'plugin', plugin } : { type: 'user' },
    phases: ['on-demand'], sourcePath: null, enabled, summary: 'Use when …', contextWords: 3, hash: name, detail: {},
  };
}

describe('skillPointers', () => {
  it('finds each pointer in the fixed form once', () => {
    expect(skillPointers('Text. Procedure: skill `a-b`.\nAgain Procedure: skill `a-b`. And Procedure: skill `c`.')).toEqual(['a-b', 'c']);
  });
  it('still recognizes the older German form, also mixed with the English one', () => {
    expect(skillPointers('Text. Ablauf: Skill `a-b`.\nAnd Procedure: skill `c`. Again Procedure: skill `a-b`.')).toEqual(['a-b', 'c']);
  });
  it('needs the exact casing of the fixed forms', () => {
    expect(skillPointers('procedure: skill `a`. Procedure: Skill `b`. Ablauf: skill `c`.')).toEqual([]);
  });
  it('ignores skills that are only mentioned', () => {
    expect(skillPointers('Use `ui-ux-pro-max` for UI tasks and the skill `frontend-design`.')).toEqual([]);
  });
  it('accepts plugin-qualified names', () => {
    expect(skillPointers('Ablauf: Skill `superpowers:brainstorming`.')).toEqual(['superpowers:brainstorming']);
  });
  it('ignores pointers inside fenced code blocks (examples), also an unclosed one', () => {
    expect(skillPointers('Real: Ablauf: Skill `real`.\n\n```md\nAblauf: Skill `example`.\n```\nAfter.\n~~~\nAblauf: Skill `open`.')).toEqual(['real']);
  });
});

describe('pointOnlyTo', () => {
  it('retargets a pointer the AI named differently instead of adding a second one', () => {
    expect(pointOnlyTo('## H\n\nShort. Ablauf: Skill `ai-name`.', 'chosen')).toBe('## H\n\nShort. Ablauf: Skill `chosen`.');
  });
  it('appends the line when there is none', () => {
    expect(pointOnlyTo('## H\n\nShort.', 'x')).toBe('## H\n\nShort.\n\nProcedure: skill `x`.');
  });
});

describe('keepPointers', () => {
  it('appends a pointer line a proposal dropped and names it', () => {
    expect(keepPointers('## H\n\nLong. Procedure: skill `x`.', '## H\n\nShort, procedure in skill x.')).toEqual({ text: '## H\n\nShort, procedure in skill x.\n\nProcedure: skill `x`.', restored: ['x'] });
  });
  it('restores a dropped pointer in the form the text had, so a German line stays German', () => {
    expect(keepPointers('## H\n\nLang. Ablauf: Skill `x`.', '## H\n\nKurz.')).toEqual({ text: '## H\n\nKurz.\n\nAblauf: Skill `x`.', restored: ['x'] });
  });
  it('leaves a proposal that kept it alone', () => {
    expect(keepPointers('A. Ablauf: Skill `x`.', 'B. Ablauf: Skill `x`.')).toEqual({ text: 'B. Ablauf: Skill `x`.', restored: [] });
  });
});

describe('skillifyBlock', () => {
  const none = { pointers: [], sourcedBy: [] };
  it('blocks on a pointer in the editor, a working saved pointer, or a skill made from this section', () => {
    expect(skillifyBlock('Ablauf: Skill `x`.', none)).toEqual({ code: 'moved', names: ['x'] });
    expect(skillifyBlock('no line', { pointers: [{ name: 'x', state: 'ok', skillId: 's' }], sourcedBy: [] })).toEqual({ code: 'saved', names: ['x'] });
    expect(skillifyBlock('no line', { pointers: [], sourcedBy: [{ id: 's', name: 'x' }] })).toEqual({ code: 'sourced', names: ['x'] });
  });
  it('lets a section without any link through, also when its saved pointer is broken', () => {
    expect(skillifyBlock('no line', none)).toBeNull();
    expect(skillifyBlock('no line', { pointers: [{ name: 'gone', state: 'missing', skillId: null }], sourcedBy: [] })).toBeNull();
  });
});

describe('retargetPointer', () => {
  it('changes only the pointer, not other mentions', () => {
    expect(retargetPointer('The `old` stays. Procedure: skill `old`.', 'old', 'new')).toBe('The `old` stays. Procedure: skill `new`.');
  });
  it('keeps the form each pointer was written in', () => {
    expect(retargetPointer('Ablauf: Skill `old`. Procedure: skill `old`.', 'old', 'new')).toBe('Ablauf: Skill `new`. Procedure: skill `new`.');
  });
});

describe('ensurePointer', () => {
  it('keeps a text that already points to the skill', () => {
    const t = '## H\n\nShort. Ablauf: Skill `x`.';
    expect(ensurePointer(t, 'x')).toBe(t);
  });
  it('follows a rename of the proposed name before creating', () => {
    expect(ensurePointer('## H\n\nShort. Ablauf: Skill `proposal`.', 'chosen', 'proposal')).toBe('## H\n\nShort. Ablauf: Skill `chosen`.');
  });
  it('appends the pointer line when the AI left it out', () => {
    expect(ensurePointer('## H\n\nShort.\n', 'x')).toBe('## H\n\nShort.\n\nProcedure: skill `x`.\n');
  });
  it('appends in the form the text already uses for its other pointers', () => {
    expect(ensurePointer('## H\n\nKurz. Ablauf: Skill `a`.', 'x')).toBe('## H\n\nKurz. Ablauf: Skill `a`.\n\nAblauf: Skill `x`.');
  });
});

describe('resolveLinks', () => {
  const skills = [skill('present'), skill('off', false), skill('brainstorming', true, 'superpowers@claude-plugins-official')];
  it('marks each pointer as ok, disabled or missing', () => {
    expect(resolveLinks(['present', 'off', 'gone'], skills)).toEqual([
      { name: 'present', state: 'ok', skillId: skills[0].id },
      { name: 'off', state: 'disabled', skillId: skills[1].id },
      { name: 'gone', state: 'missing', skillId: null },
    ]);
  });
  it('resolves plugin skills by plain and by qualified name, as Claude Code names them (without @marketplace)', () => {
    expect(resolveLinks(['superpowers:brainstorming', 'brainstorming', 'superpowers@claude-plugins-official:brainstorming'], skills).map((l) => l.state)).toEqual(['ok', 'ok', 'missing']);
  });
  it('prefers an enabled skill when a name exists twice', () => {
    const twice = [skill('dup', false), { ...skill('dup', true, 'p'), id: 'p-dup' }];
    expect(resolveLinks(['dup'], twice)[0]).toMatchObject({ state: 'ok', skillId: 'p-dup' });
  });
});

describe('linksFor', () => {
  const section: Component = {
    id: 'instruction:user:CLAUDE.md#3', kind: 'instruction', name: 'Project-Index', origin: { type: 'user' }, phases: ['always'], sourcePath: null,
    enabled: true, summary: null, contextWords: 10, hash: 'h', detail: { file: 'CLAUDE.md', index: 3, skillPointers: ['old-name'] },
  };
  it('suggests the skill whose recorded source is this section (renamed skill)', () => {
    const renamed = { ...skill('new-name'), detail: { source: 'CLAUDE.md#Project-Index' } };
    const links = linksFor(section, [section, renamed, skill('other')]);
    expect(links.pointers[0]).toMatchObject({ name: 'old-name', state: 'missing', suggestion: 'new-name' });
    expect(links.choices).toEqual(['new-name', 'other']);
    expect(links.sourcedBy).toEqual([{ id: renamed.id, name: 'new-name' }]);
  });
  it('offers plugin skills by their Claude Code name', () => {
    const links = linksFor(section, [section, skill('brainstorming', true, 'superpowers@claude-plugins-official')]);
    expect(links.choices).toEqual(['superpowers:brainstorming']);
  });
  it('lists the sections pointing to a skill on the skill page', () => {
    const target = skill('old-name');
    expect(linksFor(target, [section, target]).referencedBy).toEqual([{ id: section.id, name: 'Project-Index' }]);
  });
});
