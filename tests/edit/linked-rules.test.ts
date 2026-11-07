import { lstat, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveProposedFile, saveProposedFile } from '../../src/server/edit/files.js';
import { loadComponentText, resolveEditable } from '../../src/server/edit/resolve.js';
import { saveComponentText } from '../../src/server/edit/save.js';
import type { ScanContext } from '../../src/server/scan/context.js';
import { scanGlobal } from '../../src/server/scan/index.js';
import { linkedRuleHome, RULE_TEXT } from '../helpers/linked.js';

const ruleNamed = async (ctx: ScanContext, name: string) => (await scanGlobal(ctx)).components.filter((c) => c.kind === 'rule' && c.name === name);
const backupRoot = () => mkdtemp(path.join(tmpdir(), 'atlas-linked-backup-'));

describe('rule files linked in from a project root', () => {
  it('are listed once, with the words of the target and the project they belong to', async () => {
    const { ctx, target } = await linkedRuleHome();
    const found = await ruleNamed(ctx, 'arbeitsregeln.md');
    expect(found).toHaveLength(1);
    expect(found[0].contextWords).toBe(26);
    expect(found[0].detail.managedBy).toBe('project:standards');
    // The target is not listed a second time on its own.
    expect((await scanGlobal(ctx)).components.filter((c) => c.sourcePath === target)).toHaveLength(0);
  });

  it('are editable, and the text comes from the target', async () => {
    const { ctx, target } = await linkedRuleHome();
    const [rule] = await ruleNamed(ctx, 'arbeitsregeln.md');
    const t = await loadComponentText(rule, ctx);
    expect(t.editable).toBe(true);
    expect(t.text).toBe(RULE_TEXT);
    expect(t.file).toBe(target);
    expect(t.inRepo).toBe(false);
  });

  it('save into the target and keep the symlink', async () => {
    const { ctx, target, link } = await linkedRuleHome();
    const [rule] = await ruleNamed(ctx, 'arbeitsregeln.md');
    const edit = await resolveEditable(rule, ctx);
    if ('readOnly' in edit) throw new Error(edit.readOnly);
    const after = RULE_TEXT.replace('before fixing a bug', 'before any fix');
    const res = await saveComponentText(edit, RULE_TEXT, after, { backupRoot: await backupRoot(), git: null });
    expect(res.ok).toBe(true);
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect(await readFile(target, 'utf8')).toBe(after);
  });

  it('stay read-only without a project root around the target, with the same reason as before', async () => {
    const { ctx } = await linkedRuleHome();
    const without = { ...ctx, projectRoots: [] };
    const [rule] = await ruleNamed(without, 'arbeitsregeln.md');
    const t = await loadComponentText(rule, without);
    expect(t.editable).toBe(false);
    expect(t.readOnlyReason).toBe('It is outside the places you can edit.');
    expect(rule.detail.managedBy).toBeUndefined();
  });

  it('leave plain rule files as they were: editable and versioned inside ~/.claude', async () => {
    const { ctx } = await linkedRuleHome();
    const [style] = await ruleNamed(ctx, 'style.md');
    const t = await loadComponentText(style, ctx);
    expect(t.editable).toBe(true);
    expect(t.inRepo).toBe(true);
    expect(style.detail.managedBy).toBeUndefined();
  });
});

describe('chat proposals for a linked rule file', () => {
  it('may target it and are written to the target, the link stays', async () => {
    const { ctx, target, link } = await linkedRuleHome();
    const t = await resolveProposedFile('~/.claude/rules/arbeitsregeln.md', ctx, []);
    if ('refused' in t) throw new Error(t.refused);
    expect(t.real).toBe(target);
    expect(t.current).toBe(RULE_TEXT);
    expect(t.inRepo).toBe(false);
    const after = `${RULE_TEXT}\n## New\nOne more rule.\n`;
    const res = await saveProposedFile(t, RULE_TEXT, after, { backupRoot: await backupRoot(), git: null });
    expect(res.ok).toBe(true);
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect(await readFile(target, 'utf8')).toBe(after);
  });

  it('are still refused when no project root covers the target', async () => {
    const { ctx } = await linkedRuleHome();
    const t = await resolveProposedFile('~/.claude/rules/arbeitsregeln.md', { ...ctx, projectRoots: [] }, []);
    expect(t).toEqual({ refused: 'The path leads out of the allowed area through a symlink. Please edit the file at its target.' });
  });

  it('are refused when the link leads to a hidden file of the project (such as .git or .env)', async () => {
    const { ctx, repo } = await linkedRuleHome();
    await writeFile(path.join(repo, '.env'), 'A=1\n');
    await symlink(path.join(repo, '.env'), path.join(ctx.claudeDir, 'rules', 'env.md'));
    await symlink(path.join(repo, '.git', 'config'), path.join(ctx.claudeDir, 'rules', 'git.md'));
    for (const p of ['~/.claude/rules/env.md', '~/.claude/rules/git.md']) {
      expect(await resolveProposedFile(p, ctx, [])).toHaveProperty('refused');
    }
  });

  it('may also target a file of a skill linked in from a project root, with the usual warning', async () => {
    const { ctx, root } = await linkedRuleHome();
    const dir = path.join(root, 'my-app', 'skills', 'proj-skill');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'SKILL.md'), '---\nname: proj-skill\ndescription: Use when testing.\n---\n');
    await symlink(dir, path.join(ctx.claudeDir, 'skills', 'proj-skill'));
    const t = await resolveProposedFile('~/.claude/skills/proj-skill/SKILL.md', ctx, []);
    if ('refused' in t) throw new Error(t.refused);
    expect(t).toMatchObject({ real: path.join(dir, 'SKILL.md'), inRepo: false, exists: true });
    expect(t.warning).toContain('Commands, skills and agents can run commands');
    const added = await resolveProposedFile('~/.claude/skills/proj-skill/references/notes.md', ctx, []);
    expect(added).toMatchObject({ real: path.join(dir, 'references', 'notes.md'), exists: false });
  });

  it('are refused for a linked skill file whose target lies outside every project root', async () => {
    const { ctx } = await linkedRuleHome();
    const elsewhere = await mkdtemp(path.join(tmpdir(), 'atlas-elsewhere-'));
    await writeFile(path.join(elsewhere, 'SKILL.md'), '---\nname: far\ndescription: Use when far.\n---\n');
    await symlink(elsewhere, path.join(ctx.claudeDir, 'skills', 'far'));
    expect(await resolveProposedFile('~/.claude/skills/far/SKILL.md', ctx, [])).toHaveProperty('refused');
  });
});
