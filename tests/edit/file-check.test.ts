import { describe, expect, it } from 'vitest';
import type { Component } from '../../src/shared/model.js';
import { checkProposedFile } from '../../src/server/edit/file-check.js';

const dir = '/h/.claude';
const at = (rel: string) => `${dir}/${rel}`;
const skill = (name: string, sourcePath: string | null, plugin?: string): Component => ({
  id: `skill:${name}`, kind: 'skill', name, origin: plugin ? { type: 'plugin', plugin } : { type: 'user' }, phases: ['on-demand'], sourcePath,
  enabled: true, summary: 'Use when …', contextWords: 3, hash: name, detail: {},
});
const md = (fm: string) => `---\n${fm}\n---\n\n# Content\n`;

describe('checkProposedFile', () => {
  it('accepts a well-formed new skill', () => {
    expect(checkProposedFile(at('skills/new/SKILL.md'), dir, md('name: new\ndescription: Use when x happens.'), [])).toEqual({ errors: [], warnings: [] });
  });

  it('blocks a missing frontmatter, a name unlike the folder, bad characters and a missing description', () => {
    expect(checkProposedFile(at('skills/new/SKILL.md'), dir, '# Text only', []).errors[0]).toContain('frontmatter block is missing');
    const r = checkProposedFile(at('skills/new/SKILL.md'), dir, md('name: New_Skill'), []);
    expect(r.errors.join(' ')).toContain('must equal the folder name “new”');
    expect(r.errors.join(' ')).toContain('lowercase letters');
    expect(r.errors.join(' ')).toContain('description is missing');
  });

  it('blocks a description over 1024 characters and warns when it does not say when', () => {
    expect(checkProposedFile(at('skills/new/SKILL.md'), dir, md(`name: new\ndescription: Use when ${'x'.repeat(1100)}`), []).errors[0]).toContain('1024');
    expect(checkProposedFile(at('skills/new/SKILL.md'), dir, md('name: new\ndescription: Does things.'), []).warnings[0]).toContain('Use when');
  });

  it('warns about a skill with the same name elsewhere, not about the file itself', () => {
    const others = [skill('new', '/plugins/p/skills/new/SKILL.md', 'p@market'), skill('new', at('skills/new/SKILL.md'))];
    const r = checkProposedFile(at('skills/new/SKILL.md'), dir, md('name: new\ndescription: Use when x.'), others);
    expect(r.warnings).toEqual([expect.stringContaining('from plugin p')]);
  });

  it('leaves other files alone', () => {
    expect(checkProposedFile(at('skills/new/references/a.md'), dir, 'anything', [])).toEqual({ errors: [], warnings: [] });
    expect(checkProposedFile(at('CLAUDE.md'), dir, 'anything', [])).toEqual({ errors: [], warnings: [] });
    expect(checkProposedFile(at('rules/style.md'), dir, '# Style\n', [])).toEqual({ errors: [], warnings: [] });
  });
});

const other = (kind: Component['kind'], name: string, sourcePath: string, plugin?: string): Component => ({ ...skill(name, sourcePath, plugin), id: `${kind}:${name}`, kind });

describe('checkProposedFile for a subagent', () => {
  it('accepts a well-formed agent', () => {
    expect(checkProposedFile(at('agents/checker.md'), dir, md('name: checker\ndescription: Use when code needs a review.'), [])).toEqual({ errors: [], warnings: [] });
  });

  it('blocks a missing frontmatter, name or description and bad characters', () => {
    expect(checkProposedFile(at('agents/checker.md'), dir, '# Text only', []).errors[0]).toContain('frontmatter block is missing');
    const r = checkProposedFile(at('agents/checker.md'), dir, md('name: Checker_X'), []);
    expect(r.errors.join(' ')).toContain('lowercase letters');
    expect(r.errors.join(' ')).toContain('description is missing');
    expect(checkProposedFile(at('agents/checker.md'), dir, md('description: Use when x.'), []).errors.join(' ')).toContain('name is missing');
  });

  it('warns when the name differs from the file and when an agent of that name exists elsewhere', () => {
    const r = checkProposedFile(at('agents/checker.md'), dir, md('name: reviewer\ndescription: Use when x.'), [other('agent', 'reviewer', '/p/agents/reviewer.md', 'p@m'), other('agent', 'reviewer', at('agents/checker.md'))]);
    expect(r.errors).toEqual([]);
    expect(r.warnings.join(' ')).toContain('file name “checker”');
    expect(r.warnings.join(' ')).toContain('from plugin p');
    expect(r.warnings).toHaveLength(2);
  });
});

describe('checkProposedFile for a slash command', () => {
  it('accepts a command with a description, frontmatter is optional', () => {
    expect(checkProposedFile(at('commands/deploy.md'), dir, md('description: Deploys the app.'), [])).toEqual({ errors: [], warnings: [] });
    expect(checkProposedFile(at('commands/deploy.md'), dir, 'Deploy $ARGUMENTS', []).warnings.join(' ')).toContain('description');
  });

  it('warns when /name is already taken by a skill or another command', () => {
    const r = checkProposedFile(at('commands/tools/deploy.md'), dir, md('description: Deploys.'), [other('skill', 'deploy', at('skills/deploy/SKILL.md')), other('command', 'deploy', at('commands/tools/deploy.md'))]);
    expect(r.warnings).toEqual([expect.stringContaining('/deploy')]);
  });
});
