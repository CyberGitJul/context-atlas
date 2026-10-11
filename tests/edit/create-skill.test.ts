import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { createClaudeGit } from '../../src/server/edit/claude-git.js';
import { createSkill } from '../../src/server/edit/create-skill.js';
import type { ScanContext } from '../../src/server/scan/context.js';
import { scanSkills } from '../../src/server/scan/skills.js';
import { makeFixtureHome } from '../helpers/fixture.js';

let ctx: ScanContext;
beforeEach(async () => {
  ctx = await makeFixtureHome();
});
const deps = () => ({ git: createClaudeGit(ctx.claudeDir, path.join(ctx.homeDir, 'claude-config.git')) });

describe('createSkill', () => {
  it('creates SKILL.md with valid frontmatter, commits it, and the scan finds it', async () => {
    const res = await createSkill(ctx, 'feature-request-create', 'Use when: an app needs something from another app.', '# Procedure\n\n1. Read the card\n', deps());
    expect(res.ok && res.commit).toMatch(/^[0-9a-f]{7,}$/);
    const text = await readFile(path.join(ctx.claudeDir, 'skills', 'feature-request-create', 'SKILL.md'), 'utf8');
    expect(text).toContain('# Procedure');
    const skill = (await scanSkills(ctx, [])).find((s) => s.name === 'feature-request-create')!;
    expect(skill.summary).toBe('Use when: an app needs something from another app.');
  });

  it('records where the skill came from in metadata, which the scan reads back', async () => {
    await createSkill(ctx, 'with-source', 'Use when x.', '# A', deps(), 'CLAUDE.md#Rule B');
    const text = await readFile(path.join(ctx.claudeDir, 'skills', 'with-source', 'SKILL.md'), 'utf8');
    expect(text).toContain('atlas-source: CLAUDE.md#Rule B');
    expect((await scanSkills(ctx, [])).find((s) => s.name === 'with-source')!.detail.source).toBe('CLAUDE.md#Rule B');
  });

  it('still reads the back-reference that skills got under the former key', async () => {
    const dir = path.join(ctx.claudeDir, 'skills', 'old-source');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'SKILL.md'), '---\nname: old-source\ndescription: Use when y.\nmetadata:\n  lce-source: CLAUDE.md#Rule A\n---\n\n# B\n');
    expect((await scanSkills(ctx, [])).find((s) => s.name === 'old-source')!.detail.source).toBe('CLAUDE.md#Rule A');
  });

  it.each(['../x', 'Foo', 'a', 'with space', 'x/y'])('rejects the invalid name %s', async (name) => {
    const res = await createSkill(ctx, name, 'd', 'b', deps());
    expect(res.ok).toBe(false);
  });

  it('never overwrites an existing skill', async () => {
    const dir = path.join(ctx.claudeDir, 'skills', 'good-skill');
    const before = await readFile(path.join(dir, 'SKILL.md'), 'utf8');
    const res = await createSkill(ctx, 'good-skill', 'd', 'b', deps());
    expect(res).toMatchObject({ ok: false, exists: true });
    expect(await readFile(path.join(dir, 'SKILL.md'), 'utf8')).toBe(before);
  });

  it('also refuses when a non-skill folder of that name exists', async () => {
    await mkdir(path.join(ctx.claudeDir, 'skills', 'empty'));
    await writeFile(path.join(ctx.claudeDir, 'skills', 'empty', 'notes.txt'), 'x');
    expect(await createSkill(ctx, 'empty', 'd', 'b', deps())).toMatchObject({ ok: false, exists: true });
  });

  it('works when ~/.claude/skills does not exist yet', async () => {
    const { rm } = await import('node:fs/promises');
    await rm(path.join(ctx.claudeDir, 'skills'), { recursive: true, force: true });
    const res = await createSkill(ctx, 'first-skill', 'Use when x.', '# B', deps());
    expect(res.ok).toBe(true);
  });

  it('reserves the name synced', async () => {
    const res = await createSkill(ctx, 'synced', 'd', 'b', deps());
    expect(res.ok).toBe(false);
  });

  it('reports a git failure as a warning once the skill exists', async () => {
    const broken = { ensureRepo: async () => Promise.reject(new Error('git broken')), commitFile: async () => ({ status: 'unchanged' as const }) };
    const res = await createSkill(ctx, 'despite-git', 'Use when x.', '# B', { git: broken });
    expect(res.ok && res.warning).toContain('Git');
  });

});
