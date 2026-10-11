import { mkdir, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadComponentText } from '../../src/server/edit/resolve.js';
import { parseProjectRoots, type ScanContext } from '../../src/server/scan/context.js';
import { scanGlobal } from '../../src/server/scan/index.js';
import { makeFixtureHome } from '../helpers/fixture.js';

describe('parseProjectRoots', () => {
  it('reads several folders, expands ~ and drops empty or relative entries', () => {
    const value = ['~/projects', '', ' /srv/code ', 'relative/dir', '~'].join(path.delimiter);
    expect(parseProjectRoots(value, '/home/x')).toEqual(['/home/x/projects', '/srv/code', '/home/x']);
  });

  it('has no project roots when nothing is set', () => {
    expect(parseProjectRoots(undefined, '/home/x')).toEqual([]);
  });
});

/** A skill that lives in a project folder and is linked into ~/.claude/skills, as people keep their own skills. */
async function linkedProjectSkill(): Promise<{ ctx: ScanContext; root: string }> {
  const ctx = await makeFixtureHome();
  const root = path.join(ctx.homeDir, 'code');
  const dir = path.join(root, 'my-app', 'skills', 'proj-skill');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'SKILL.md'), '---\nname: proj-skill\ndescription: Use when testing project skills.\n---\n\n# Proj\n');
  await symlink(dir, path.join(ctx.claudeDir, 'skills', 'proj-skill'));
  return { ctx, root };
}

describe('project roots', () => {
  it('treats a linked skill inside a project root as belonging to that project and editable', async () => {
    const { ctx, root } = await linkedProjectSkill();
    const withRoot = { ...ctx, projectRoots: [root] };
    const skill = (await scanGlobal(withRoot)).components.find((c) => c.name === 'proj-skill')!;
    expect(skill.detail.managedBy).toBe('project:my-app');
    expect((await loadComponentText(skill, withRoot)).editable).toBe(true);
  });

  it('keeps the same skill read-only when no project root covers it', async () => {
    const { ctx } = await linkedProjectSkill();
    const skill = (await scanGlobal(ctx)).components.find((c) => c.name === 'proj-skill')!;
    expect(skill.detail.managedBy).toBe('external');
    const t = await loadComponentText(skill, ctx);
    expect(t.editable).toBe(false);
    expect(t.readOnlyReason).toContain('PROJECT_ROOTS');
  });
});

describe('memory folder names', () => {
  it('shortens a memory folder to the project name only inside a project root', async () => {
    const ctx = await makeFixtureHome();
    const flat = (p: string) => p.replace(/[/.]/g, '-');
    await mkdir(path.join(ctx.claudeDir, 'projects', `${flat(ctx.homeDir)}-code-my-app`, 'memory'), { recursive: true });
    await writeFile(path.join(ctx.claudeDir, 'projects', `${flat(ctx.homeDir)}-code-my-app`, 'memory', 'MEMORY.md'), '- note\n');
    const names = async (c: ScanContext) => (await scanGlobal(c)).components.filter((x) => x.kind === 'memory').map((x) => x.name);
    expect(await names({ ...ctx, projectRoots: [path.join(ctx.homeDir, 'code')] })).toContain('my-app');
    expect(await names(ctx)).toContain(`${flat(ctx.homeDir)}-code-my-app`);
  });
});
