import { mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { createClaudeGit } from '../../src/server/edit/claude-git.js';
import { resolveProposedFile, saveProposedFile } from '../../src/server/edit/files.js';
import type { ScanContext } from '../../src/server/scan/context.js';
import { makeFixtureHome } from '../helpers/fixture.js';

let ctx: ScanContext;
let backupRoot: string;
const EXTRA = ['~/projects/INDEX.md'];
beforeEach(async () => {
  ctx = await makeFixtureHome();
  backupRoot = await mkdtemp(path.join(tmpdir(), 'atlas-files-backup-'));
  await mkdir(path.join(ctx.homeDir, 'projects'), { recursive: true });
});
const resolve = (p: string) => resolveProposedFile(p, ctx, EXTRA);
const deps = () => ({ backupRoot, git: createClaudeGit(ctx.claudeDir, path.join(ctx.homeDir, 'claude-config.git')) });

describe('resolveProposedFile', () => {
  it.each([
    '~/.claude/CLAUDE.md',
    '~/.claude/rules/new.md',
    '~/.claude/skills/new-skill/SKILL.md',
    '~/.claude/skills/new-skill/references/details.md',
    '~/.claude/agents/helper.md',
    '~/.claude/commands/tools/run.md',
    '~/.claude/output-styles/short.md',
    '~/projects/INDEX.md',
  ])('allows %s', async (p) => {
    expect(await resolve(p)).toMatchObject({ display: p });
  });

  it.each(['~/.claude/settings.json', '~/.claude/hooks/check.sh', '~/.claude/skills/x/run.py'])('allows %s with a warning that it runs code', async (p) => {
    await writeFile(path.join(ctx.claudeDir, 'settings.json'), '{}\n');
    expect((await resolve(p)) as { warning: string }).toMatchObject({ warning: expect.stringContaining('runs code') });
  });

  it.each(['~/.claude/commands/run.md', '~/.claude/agents/helper.md', '~/.claude/skills/x/SKILL.md'])('warns that %s can run commands or grant rights', async (p) => {
    expect((await resolve(p)) as { warning: string }).toMatchObject({ warning: expect.stringContaining('allowed-tools') });
  });

  it.each(['~/.claude/CLAUDE.md', '~/.claude/rules/new.md', '~/projects/INDEX.md'])('gives %s no code warning', async (p) => {
    expect(await resolve(p)).toMatchObject({ warning: null });
  });

  it('refuses a symlink without target instead of failing on every save', async () => {
    await symlink(path.join(ctx.homeDir, 'nowhere.md'), path.join(ctx.claudeDir, 'rules', 'broken.md'));
    expect(await resolve('~/.claude/rules/broken.md')).toMatchObject({ refused: expect.stringContaining('without a target') });
  });

  it('refuses the settings file while it holds secrets (the fixture has env tokens)', async () => {
    expect(await resolve('~/.claude/settings.json')).toMatchObject({ refused: expect.stringContaining('secret-like') });
  });

  it.each([
    '~/.netrc',
    '/etc/passwd',
    '~/projects/other-app/README.md',
    '~/.claude/../.netrc',
    '~/.claude/plugins/x/SKILL.md',
    '~/.claude/skills/synced/abc/SKILL.md',
    '~/.claude/projects/p/memory/note.md',
    '~/.claude/.credentials.json',
    '~/.claude/rules/x.sh',
    'relative/path.md',
  ])('refuses %s', async (p) => {
    expect(await resolve(p)).toHaveProperty('refused');
  });

  it('refuses a path that leaves the allowed area through a symlink', async () => {
    const outside = await mkdtemp(path.join(tmpdir(), 'atlas-outside-'));
    await symlink(outside, path.join(ctx.claudeDir, 'skills', 'escape'));
    expect(await resolve('~/.claude/skills/escape/SKILL.md')).toMatchObject({ refused: expect.stringContaining('symlink') });
  });

  it('refuses existing files with secret-like values (a proposal from masked text would destroy them)', async () => {
    await writeFile(path.join(ctx.claudeDir, 'rules', 'secret.md'), 'token=sk-ant-abcdefghijklmnopqrstuvwxyz0123\n');
    expect(await resolve('~/.claude/rules/secret.md')).toMatchObject({ refused: expect.stringContaining('secret-like') });
  });
});

describe('saveProposedFile', () => {
  it('creates a new file, never over an existing one', async () => {
    const target = await resolve('~/projects/INDEX.md');
    if ('refused' in target) throw new Error(target.refused);
    expect(await saveProposedFile(target, null, '# Index\n', deps())).toMatchObject({ ok: true, commit: null });
    expect(await readFile(path.join(ctx.homeDir, 'projects', 'INDEX.md'), 'utf8')).toBe('# Index\n');
    expect(await saveProposedFile(target, null, '# Other\n', deps())).toMatchObject({ ok: false, conflict: true });
    expect(await readFile(path.join(ctx.homeDir, 'projects', 'INDEX.md'), 'utf8')).toBe('# Index\n');
  });

  it('creates missing folders inside ~/.claude and commits the new file', async () => {
    const target = await resolve('~/.claude/skills/brand-new/SKILL.md');
    if ('refused' in target) throw new Error(target.refused);
    const res = await saveProposedFile(target, null, '---\nname: brand-new\ndescription: Use when x.\n---\n\n# A\n', deps());
    expect(res).toMatchObject({ ok: true, commit: expect.stringMatching(/^[0-9a-f]{7,}$/) });
  });

  it('changes an existing file only from the state it was shown in, with a backup', async () => {
    const file = path.join(ctx.homeDir, 'projects', 'INDEX.md');
    await writeFile(file, 'old\n');
    const target = await resolve('~/projects/INDEX.md');
    if ('refused' in target) throw new Error(target.refused);
    expect(await saveProposedFile(target, 'different\n', 'new\n', deps())).toMatchObject({ ok: false, conflict: true });
    const res = await saveProposedFile(target, 'old\n', 'new\n', deps());
    expect(res).toMatchObject({ ok: true });
    expect(await readFile(file, 'utf8')).toBe('new\n');
    expect((await readdir(backupRoot)).length).toBe(1);
  });

  it('refuses broken JSON and a settings file that is not an object, writing nothing', async () => {
    await writeFile(path.join(ctx.claudeDir, 'settings.json'), '{}\n');
    const target = await resolve('~/.claude/settings.json');
    if ('refused' in target) throw new Error(target.refused);
    expect(await saveProposedFile(target, '{}\n', '{"permissions":{"deny":["Bash(rm:*)"],}}\n', deps())).toMatchObject({ ok: false, invalid: expect.stringContaining('line 1') });
    expect(await saveProposedFile(target, '{}\n', '[]\n', deps())).toMatchObject({ ok: false, invalid: expect.stringContaining('JSON object') });
    expect(await readFile(path.join(ctx.claudeDir, 'settings.json'), 'utf8')).toBe('{}\n');
  });
});
