import { execFile } from 'node:child_process';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { redact } from '../redact.js';
import { appDirs } from '../paths.js';

const run = promisify(execFile);

/**
 * Only hand-written configuration is tracked. Lives in the git dir's info/exclude, so nothing
 * is written into ~/.claude itself.
 */
export const CLAUDE_EXCLUDE = `# Managed by Context Atlas: only hand-written configuration is tracked.
/*
!/CLAUDE.md
!/rules/
!/skills/
/skills/synced/
!/agents/
/agents/*
!/agents/*.md
!/commands/
/commands/*
!/commands/*.md
!/output-styles/
/output-styles/*
!/output-styles/*.md
!/hooks/
/hooks/*
!/hooks/*.sh
!/hooks/*.js
!/hooks/*.mjs
!/hooks/*.cjs
!/hooks/*.py
!/hooks/*.ts
`;

/** Pending git work per git dir; keyed by path because git's index lock is per repository. */
const gitChains = new Map<string, Promise<unknown>>();

export function defaultClaudeGitDir(): string {
  return path.join(appDirs().data, 'claude-config.git');
}

/** Why a file was (not) committed; errors are thrown. */
export type CommitOutcome =
  | { status: 'committed'; hash: string }
  | { status: 'unchanged' }
  | { status: 'ignored' }
  | { status: 'secret' };

export interface ClaudeGit {
  /** Creates the repo with the whitelist on first use; true if it was created now. */
  ensureRepo(): Promise<boolean>;
  /** Commits exactly this file — never if its content holds secret-like values. */
  commitFile(file: string, message: string): Promise<CommitOutcome>;
}

/**
 * Git for ~/.claude with the git data kept outside (gitDir), so ~/.claude never becomes a repo:
 * tools that honour .gitignore (ripgrep, Grep/Glob) and `git rev-parse` there are not affected.
 */
export function createClaudeGit(claudeDir: string, gitDir: string = defaultClaudeGitDir()): ClaudeGit {
  // Fixed identity, no signing, no hooks: commits must never prompt or run foreign code.
  const git = async (...args: string[]) =>
    (
      await run('git', [
        `--git-dir=${gitDir}`,
        `--work-tree=${claudeDir}`,
        '-c', 'user.name=Context Atlas',
        '-c', 'user.email=context-atlas@localhost',
        '-c', 'commit.gpgsign=false',
        '-c', 'core.hooksPath=/dev/null',
        '-c', 'core.excludesFile=/dev/null',
        ...args,
      ])
    ).stdout.trim();

  // One git operation at a time per git dir (index and HEAD are shared), also across instances.
  const serialized = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = (gitChains.get(gitDir) ?? Promise.resolve()).catch(() => undefined).then(fn);
    gitChains.set(gitDir, next);
    return next;
  };

  return {
    ensureRepo: () =>
      serialized(async () => {
        const exists = await access(path.join(gitDir, 'HEAD')).then(() => true, () => false);
        if (!exists) {
          await mkdir(path.dirname(gitDir), { recursive: true });
          await run('git', ['init', '-q', '--bare', '-b', 'main', gitDir]);
          await run('git', [`--git-dir=${gitDir}`, 'config', 'core.bare', 'false']);
        }
        // Rewritten every time so whitelist changes apply and an interrupted init is repaired.
        await mkdir(path.join(gitDir, 'info'), { recursive: true });
        await writeFile(path.join(gitDir, 'info', 'exclude'), CLAUDE_EXCLUDE);
        return !exists;
      }),
    commitFile: (file, message) =>
      serialized(async (): Promise<CommitOutcome> => {
        const rel = path.relative(claudeDir, file);
        if (rel.startsWith('..') || path.isAbsolute(rel)) return { status: 'ignored' };
        const ignored = await git('check-ignore', '-q', '--', rel).then(() => true, () => false);
        if (ignored) return { status: 'ignored' };
        // The single choke point for secrets: no commit (baseline, outside change, edit, new skill) may store them.
        const content = await readFile(file, 'utf8');
        if (redact(content) !== content) return { status: 'secret' };
        await git('add', '--', rel);
        const unchanged = await git('diff', '--cached', '--quiet', '--', rel).then(() => true, () => false);
        if (unchanged) return { status: 'unchanged' };
        await git('commit', '-q', '-m', message, '--', rel);
        return { status: 'committed', hash: await git('rev-parse', '--short', 'HEAD') };
      }),
  };
}
