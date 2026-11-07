import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { ScanContext } from '../../src/server/scan/context.js';
import { makeFixtureHome } from './fixture.js';

const run = promisify(execFile);

/** A rule file with two `## ` sections, as general rules look once they moved out of CLAUDE.md. */
export const RULE_TEXT = '# Working rules\n\n## Errors first\nFind the root cause before fixing a bug.\n\n## Public repos\nEverything in a public repository is written in English.\n';

export async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await run('git', ['-C', cwd, ...args])).stdout.trim();
}

/** A fresh repo with a local identity, no signing and no hooks: tests never depend on the developer's global git config. */
export async function initRepo(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await run('git', ['init', '-q', '-b', 'main', dir]);
  for (const [k, v] of [['user.name', 'Test'], ['user.email', 'test@example.invalid'], ['commit.gpgsign', 'false'], ['core.hooksPath', '/dev/null']]) await git(dir, 'config', k, v);
}

export interface LinkedRuleHome {
  /** Temporary home with ~/.claude and PROJECT_ROOTS = <home>/projects. */
  ctx: ScanContext;
  root: string;
  /** The rules repo: <home>/projects/standards, one commit. */
  repo: string;
  /** The rule file in the repo. */
  target: string;
  /** ~/.claude/rules/arbeitsregeln.md, a symlink to `target`. */
  link: string;
}

/** Own rules kept in a git repo under PROJECT_ROOTS and linked into ~/.claude/rules, everything in temp folders. */
export async function linkedRuleHome(): Promise<LinkedRuleHome> {
  const base = await makeFixtureHome();
  const root = path.join(base.homeDir, 'projects');
  const repo = path.join(root, 'standards');
  await initRepo(repo);
  const target = path.join(repo, 'regeln', 'arbeitsregeln.md');
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, RULE_TEXT);
  await git(repo, 'add', '-A');
  await git(repo, 'commit', '-q', '-m', 'init');
  const link = path.join(base.claudeDir, 'rules', 'arbeitsregeln.md');
  await symlink(target, link);
  return { ctx: { ...base, projectRoots: [root] }, root, repo, target, link };
}

/** Gives the repo a bare origin it is pushed to, so "not pushed yet" can be counted. */
export async function addOrigin(repo: string): Promise<string> {
  const origin = path.join(await mkdtemp(path.join(tmpdir(), 'atlas-origin-')), 'standards.git');
  await run('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  await git(repo, 'remote', 'add', 'origin', origin);
  await git(repo, 'push', '-q', '-u', 'origin', 'main');
  return origin;
}
