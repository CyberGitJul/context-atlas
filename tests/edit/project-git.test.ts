import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { commitInRepo, repoOf, repoState, repoStateOf } from '../../src/server/edit/project-git.js';
import { addOrigin, git, initRepo, linkedRuleHome, RULE_TEXT } from '../helpers/linked.js';

const edited = RULE_TEXT.replace('before fixing a bug', 'before any fix');

describe('the git repo of a saved project file', () => {
  it('is found for a file under a project root, with its uncommitted changes', async () => {
    const { ctx, repo, target } = await linkedRuleHome();
    const root = await repoOf(target, ctx);
    expect(root).toBe(repo);
    expect((await repoState(root!, ctx)).changes).toEqual([]);
    await writeFile(target, edited);
    const state = await repoState(root!, ctx);
    expect(state).toMatchObject({ display: '~/projects/standards', branch: 'main', upstream: null, ahead: 0 });
    expect(state.changes).toEqual([{ path: 'regeln/arbeitsregeln.md', status: '.M' }]);
  });

  it('lists new and deleted files too', async () => {
    const { ctx, repo, target } = await linkedRuleHome();
    await writeFile(path.join(repo, 'regeln', 'neu.md'), 'new\n');
    await git(repo, 'rm', '-q', '--cached', 'regeln/arbeitsregeln.md');
    const state = await repoState((await repoOf(target, ctx))!, ctx);
    expect(state.changes).toEqual([
      { path: 'regeln/arbeitsregeln.md', status: 'D.' },
      { path: 'regeln/arbeitsregeln.md', status: '??' },
      { path: 'regeln/neu.md', status: '??' },
    ]);
  });

  it('is found for a file that is still to be created in a folder of the repo', async () => {
    const { ctx, repo } = await linkedRuleHome();
    expect(await repoOf(path.join(repo, 'regeln', 'neu.md'), ctx)).toBe(repo);
    expect(await repoOf(path.join(repo, 'no-folder', 'neu.md'), ctx)).toBeNull();
  });

  it('is none for files outside every project root', async () => {
    const { ctx, target } = await linkedRuleHome();
    expect(await repoOf(path.join(ctx.claudeDir, 'rules', 'style.md'), ctx)).toBeNull();
    expect(await repoOf(target, { ...ctx, projectRoots: [] })).toBeNull();
  });

  it('is none when the folder under the project root is no repo of its own but part of one above it', async () => {
    const { ctx } = await linkedRuleHome();
    await initRepo(ctx.homeDir);
    const loose = path.join(ctx.homeDir, 'projects', 'loose', 'notes.md');
    await mkdir(path.dirname(loose), { recursive: true });
    await writeFile(loose, 'x\n');
    expect(await repoOf(loose, ctx)).toBeNull();
  });

  it('names the file it was asked about, relative to the work tree', async () => {
    const { ctx, link } = await linkedRuleHome();
    expect(await repoStateOf(link, ctx)).toMatchObject({ display: '~/projects/standards', file: 'regeln/arbeitsregeln.md' });
    expect(await repoStateOf(path.join(ctx.claudeDir, 'rules', 'style.md'), ctx)).toBeNull();
  });

  it('counts commits that are not pushed yet', async () => {
    const { ctx, repo, target } = await linkedRuleHome();
    await addOrigin(repo);
    await writeFile(target, edited);
    await git(repo, 'commit', '-q', '-am', 'edit');
    expect(await repoState(repo, ctx)).toMatchObject({ upstream: 'origin/main', ahead: 1, behind: 0, changes: [] });
  });
});

describe('committing through the offer', () => {
  it('commits exactly the confirmed files, after which the repo is clean', async () => {
    const { ctx, repo, target } = await linkedRuleHome();
    await writeFile(target, edited);
    const res = await commitInRepo(repo, ['regeln/arbeitsregeln.md'], 'Rules: root cause before any fix');
    expect(res).toMatchObject({ ok: true });
    expect(await git(repo, 'status', '--porcelain')).toBe('');
    expect(await git(repo, 'log', '-1', '--format=%s')).toBe('Rules: root cause before any fix');
    expect((await repoState(repo, ctx)).changes).toEqual([]);
  });

  it('leaves changes alone that the user did not confirm, also ones already staged', async () => {
    const { repo, target } = await linkedRuleHome();
    await writeFile(target, edited);
    await writeFile(path.join(repo, 'other.md'), 'other\n');
    await git(repo, 'add', 'other.md');
    expect(await commitInRepo(repo, ['regeln/arbeitsregeln.md'], 'only the rule')).toMatchObject({ ok: true });
    expect(await git(repo, 'show', '--name-only', '--format=', 'HEAD')).toBe('regeln/arbeitsregeln.md');
    expect(await git(repo, 'status', '--porcelain')).toBe('A  other.md');
  });

  it('commits a new file and a deletion', async () => {
    const { repo, target } = await linkedRuleHome();
    await writeFile(path.join(repo, 'regeln', 'neu.md'), 'new\n');
    await git(repo, 'rm', '-q', 'regeln/arbeitsregeln.md');
    expect(await readFile(target, 'utf8').catch(() => null)).toBeNull();
    expect(await commitInRepo(repo, ['regeln/neu.md', 'regeln/arbeitsregeln.md'], 'move')).toMatchObject({ ok: true });
    expect(await git(repo, 'status', '--porcelain')).toBe('');
  });

  it('refuses a file with secret-like values and commits nothing', async () => {
    const { repo, target } = await linkedRuleHome();
    const head = await git(repo, 'rev-parse', 'HEAD');
    await writeFile(target, `${RULE_TEXT}API_KEY=sk-abcdefghijklmnop123\n`);
    const res = await commitInRepo(repo, ['regeln/arbeitsregeln.md'], 'leak');
    expect(res.ok).toBe(false);
    expect(await git(repo, 'rev-parse', 'HEAD')).toBe(head);
  });

  it('refuses paths outside the work tree and files without a change', async () => {
    const { repo } = await linkedRuleHome();
    expect((await commitInRepo(repo, ['../outside.md'], 'x')).ok).toBe(false);
    expect((await commitInRepo(repo, ['regeln/arbeitsregeln.md'], 'x')).ok).toBe(false);
    expect((await commitInRepo(repo, [], 'x')).ok).toBe(false);
  });

  it('refuses while a merge is in progress and leaves the conflict as it was', async () => {
    const { repo, target } = await linkedRuleHome();
    await git(repo, 'checkout', '-q', '-b', 'other');
    await writeFile(target, `${RULE_TEXT}other\n`);
    await git(repo, 'commit', '-q', '-am', 'other');
    await git(repo, 'checkout', '-q', 'main');
    await writeFile(target, `${RULE_TEXT}main\n`);
    await git(repo, 'commit', '-q', '-am', 'main');
    await git(repo, 'merge', '-q', 'other').catch(() => undefined);
    const before = await git(repo, 'status', '--porcelain');
    expect(before).toBe('UU regeln/arbeitsregeln.md');
    expect(await commitInRepo(repo, ['regeln/arbeitsregeln.md'], 'x')).toMatchObject({ ok: false, code: 'busy' });
    expect(await git(repo, 'status', '--porcelain')).toBe(before);
  });

  it('refuses a file that is untracked on purpose (git rm --cached) and keeps it that way', async () => {
    const { repo } = await linkedRuleHome();
    await git(repo, 'rm', '-q', '--cached', 'regeln/arbeitsregeln.md');
    expect(await commitInRepo(repo, ['regeln/arbeitsregeln.md'], 'x')).toMatchObject({ ok: false, code: 'invalid' });
    expect(await git(repo, 'status', '--porcelain', '--untracked-files=all')).toBe('D  regeln/arbeitsregeln.md\n?? regeln/arbeitsregeln.md');
  });

  it('leaves nothing staged when the commit fails (a hook says no), and names no absolute path', async () => {
    const { ctx, repo, target } = await linkedRuleHome();
    const hooks = await mkdtemp(path.join(tmpdir(), 'atlas-hooks-'));
    await writeFile(path.join(hooks, 'pre-commit'), '#!/bin/sh\nexit 1\n');
    await chmod(path.join(hooks, 'pre-commit'), 0o755);
    await git(repo, 'config', 'core.hooksPath', hooks);
    await writeFile(target, edited);
    await writeFile(path.join(repo, 'regeln', 'neu.md'), 'new\n');
    const res = await commitInRepo(repo, ['regeln/arbeitsregeln.md', 'regeln/neu.md'], 'x');
    expect(res).toMatchObject({ ok: false, code: 'failed' });
    expect(JSON.stringify(res)).not.toContain(ctx.homeDir);
    expect(await git(repo, 'status', '--porcelain', '--untracked-files=all')).toBe('M regeln/arbeitsregeln.md\n?? regeln/neu.md');
  });

  it('works on the repo it was given even when the server runs with GIT_DIR or GIT_INDEX_FILE set', async () => {
    const { ctx, repo, target } = await linkedRuleHome();
    await writeFile(target, edited);
    const saved = { dir: process.env.GIT_DIR, index: process.env.GIT_INDEX_FILE };
    process.env.GIT_DIR = path.join(ctx.homeDir, 'nowhere.git');
    process.env.GIT_INDEX_FILE = path.join(ctx.homeDir, 'nowhere.index');
    try {
      expect((await repoState(repo, ctx)).changes).toEqual([{ path: 'regeln/arbeitsregeln.md', status: '.M' }]);
      expect(await commitInRepo(repo, ['regeln/arbeitsregeln.md'], 'edit')).toMatchObject({ ok: true });
    } finally {
      for (const [k, v] of [['GIT_DIR', saved.dir], ['GIT_INDEX_FILE', saved.index]] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
    expect(await git(repo, 'status', '--porcelain')).toBe('');
  });

  it('needs a message', async () => {
    const { repo, target } = await linkedRuleHome();
    await writeFile(target, edited);
    expect((await commitInRepo(repo, ['regeln/arbeitsregeln.md'], '  ')).ok).toBe(false);
  });
});
