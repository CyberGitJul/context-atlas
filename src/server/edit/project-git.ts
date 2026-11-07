import { execFile } from 'node:child_process';
import { access, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { RepoChange, RepoState } from '../../shared/model.js';
import { msg } from '../messages/index.js';
import { redact } from '../redact.js';
import { realProjectRoots, type ScanContext } from '../scan/context.js';

/**
 * The user's own git repos under PROJECT_ROOTS (rules and skills linked into ~/.claude live there). Unlike the
 * versioning of ~/.claude, these commits are the user's: their identity, signing and hooks apply. Nothing here
 * fetches, pulls or pushes.
 */

const run = promisify(execFile);

/** Files bigger than this are not read for the secret check; such a commit is left to the user. */
const MAX_CHECKED_BYTES = 2 * 1024 * 1024;

/** Variables that would point git at another repo or index than the work tree it is run in. */
const REPO_VARS = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_COMMON_DIR', 'GIT_NAMESPACE'];

/** Markers of an operation git is in the middle of; a partial commit then would leave the user's work in a mess. */
const BUSY_MARKERS = ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply'];

const within = (file: string, dir: string) => file === dir || file.startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep);

async function git(cwd: string, args: string[], timeout = 30_000): Promise<string> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    // Never wait for a password prompt; never take optional locks that `git status` would hold on the index.
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    // File names are names, not patterns (`*`, `:` and the like).
    GIT_LITERAL_PATHSPECS: '1',
  };
  for (const name of REPO_VARS) delete env[name];
  return (await run('git', ['-C', cwd, ...args], { env, timeout, maxBuffer: 16 * 1024 * 1024 })).stdout;
}

/** Real path of a file, or of a file still to be created in an existing folder. */
async function realFile(file: string): Promise<string | null> {
  const real = await realpath(file).catch(() => null);
  if (real) return real;
  const dir = await realpath(path.dirname(file)).catch(() => null);
  return dir && path.join(dir, path.basename(file));
}

/**
 * The work tree a file belongs to (also one still to be created), when the file and that work tree both lie inside a
 * project root; else null.
 */
export async function repoOf(file: string, ctx: ScanContext): Promise<string | null> {
  const real = await realFile(file);
  if (!real) return null;
  const roots = await realProjectRoots(ctx);
  if (!roots.some((r) => within(real, r))) return null;
  const top = await git(path.dirname(real), ['rev-parse', '--show-toplevel']).then((s) => s.trim(), () => null);
  if (!top) return null;
  const realTop = await realpath(top).catch(() => top);
  // A home folder kept in git must not turn every project file into a change of that repo.
  return roots.some((r) => within(realTop, r)) ? realTop : null;
}

type Status = Omit<RepoState, 'root' | 'display' | 'file'>;

/** `git status --porcelain=v2 -z`: branch lines, then one entry per change; a rename carries its old path as the next entry. */
function parseStatus(out: string): Status {
  const state: Status = { branch: null, upstream: null, ahead: 0, behind: 0, changes: [] };
  const entries = out.split('\0');
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.startsWith('# branch.head ')) state.branch = e.slice(14) === '(detached)' ? null : e.slice(14);
    else if (e.startsWith('# branch.upstream ')) state.upstream = e.slice(18);
    else if (e.startsWith('# branch.ab ')) {
      const m = e.match(/^# branch\.ab \+(\d+) -(\d+)$/);
      if (m) [state.ahead, state.behind] = [Number(m[1]), Number(m[2])];
    } else if (e.startsWith('1 ')) state.changes.push({ path: e.split(' ').slice(8).join(' '), status: e.slice(2, 4) });
    else if (e.startsWith('2 ')) state.changes.push({ path: e.split(' ').slice(9).join(' '), status: e.slice(2, 4), from: entries[++i] });
    else if (e.startsWith('u ')) state.changes.push({ path: e.split(' ').slice(10).join(' '), status: e.slice(2, 4) });
    else if (e.startsWith('? ')) state.changes.push({ path: e.slice(2), status: '??' });
  }
  return state;
}

async function statusOf(root: string): Promise<Status> {
  return parseStatus(await git(root, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all']));
}

/**
 * What is not committed or not pushed yet in that work tree. Behind counts as of the last fetch; nothing is fetched.
 * `file`: a file the page is about, named relative to the work tree, so the offer can preselect it.
 */
export async function repoState(root: string, ctx: ScanContext, file?: string | null): Promise<RepoState> {
  const display = root.startsWith(`${ctx.homeDir}/`) ? `~/${root.slice(ctx.homeDir.length + 1)}` : root;
  const real = file ? await realFile(file) : null;
  const rel = real && within(real, root) && real !== root ? path.relative(root, real).split(path.sep).join('/') : null;
  return { root, display, file: rel, ...(await statusOf(root)) };
}

/** The repo state of the file, or null when it lies in no repo under PROJECT_ROOTS; a broken repo counts as none. */
export async function repoStateOf(file: string | null | undefined, ctx: ScanContext): Promise<RepoState | null> {
  if (!file) return null;
  const root = await repoOf(file, ctx);
  return root ? repoState(root, ctx, file).catch(() => null) : null;
}

export type CommitResult = { ok: true; hash: string } | { ok: false; code: 'invalid' | 'busy' | 'nothing' | 'secret' | 'failed'; error: string };

/** First line of what git said; the command line (with its absolute paths) is never passed on. */
const gitSaid = (e: unknown) => {
  const err = e as { stderr?: string; stdout?: string };
  return (err.stderr?.trim() || err.stdout?.trim() || '').split('\n')[0].slice(0, 200);
};

async function busyWith(root: string): Promise<string | null> {
  for (const marker of BUSY_MARKERS) {
    const p = (await git(root, ['rev-parse', '--git-path', marker])).trim();
    if (await access(path.resolve(root, p)).then(() => true, () => false)) return marker;
  }
  return null;
}

/**
 * Commits exactly the files the user confirmed, as far as they still have changes; changes already staged for other
 * files stay staged and are not part of it. A file with secret-like values is never committed. Refused in the middle
 * of a merge, rebase, cherry-pick or revert, and when it fails, the index is as it was before.
 */
export async function commitInRepo(root: string, files: unknown[], message: string): Promise<CommitResult> {
  const m = msg.edit.repo;
  if (!message.trim()) return { ok: false, code: 'invalid', error: m.noMessage };
  if (!files.length) return { ok: false, code: 'invalid', error: m.noFiles };
  const bad = files.find((f) => typeof f !== 'string' || !f || f.includes('\0') || path.isAbsolute(f) || f.split(/[\\/]/).includes('..'));
  if (bad !== undefined) return { ok: false, code: 'invalid', error: m.badPath(String(bad)) };

  if (await busyWith(root)) return { ok: false, code: 'busy', error: m.busy };
  const { changes } = await statusOf(root);
  const chosen = changes.filter((c) => (files as string[]).includes(c.path));
  if (!chosen.length) return { ok: false, code: 'nothing', error: m.nothingLeft };
  const conflict = chosen.find((c) => c.status.includes('U') || c.status === 'AA' || c.status === 'DD');
  if (conflict) return { ok: false, code: 'busy', error: m.busy };
  // `git rm --cached`: a deletion staged on purpose while the file stays; a commit of the file would undo it.
  const untracked = chosen.filter((c) => c.status === '??').map((c) => c.path);
  const kept = untracked.find((p) => chosen.some((c) => c.path === p && c.status[0] === 'D'));
  if (kept) return { ok: false, code: 'invalid', error: m.untrackedOnPurpose(kept) };

  // A rename is committed with its old path, so the old file does not stay behind as a deletion.
  const commitSpec = [...new Set(chosen.flatMap((c: RepoChange) => (c.from ? [c.path, c.from] : [c.path])))];
  for (const rel of commitSpec) {
    const file = path.join(root, rel);
    const st = await stat(file).catch(() => null);
    if (!st?.isFile()) continue;
    if (st.size > MAX_CHECKED_BYTES) return { ok: false, code: 'secret', error: m.tooLarge(rel) };
    const content = await readFile(file, 'utf8');
    if (redact(content) !== content) return { ok: false, code: 'secret', error: m.secret(rel) };
  }
  // With paths, git commits their state on disk and leaves the rest of the index alone (its --only mode); only new
  // files have to be known to git first. Hooks and signing of the user's config may take a while.
  if (untracked.length) await git(root, ['add', '--', ...untracked]);
  try {
    await git(root, ['commit', '-q', '-m', message.trim(), '--', ...commitSpec], 120_000);
  } catch (e) {
    if (untracked.length) await git(root, ['rm', '-q', '--cached', '--ignore-unmatch', '--', ...untracked]).catch(() => undefined);
    const said = gitSaid(e);
    if (/nothing (added )?to commit|no changes added/i.test(said)) return { ok: false, code: 'nothing', error: m.nothingLeft };
    return { ok: false, code: 'failed', error: m.failed(said) };
  }
  return { ok: true, hash: (await git(root, ['rev-parse', '--short', 'HEAD'])).trim() };
}
