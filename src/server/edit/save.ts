import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { msg } from '../messages/index.js';
import type { ClaudeGit, CommitOutcome } from './claude-git.js';
import type { EditTarget } from './resolve.js';
import { sectionBounds } from './sections.js';

export type SaveResult =
  | { ok: true; backup: string; commit: string | null; commitStatus: CommitOutcome['status'] | 'failed' | 'none'; warning: string | null; repoCreated: boolean }
  | { ok: false; conflict: true }
  | { ok: false; invalid: string };

interface Deps {
  backupRoot: string;
  /** Git of ~/.claude; used only for targets inside it. */
  git: ClaudeGit | null;
  now?: () => Date;
}

/** One save per file at a time (read → write → commit), so concurrent saves never lose an edit. */
const locks = new Map<string, Promise<unknown>>();
async function withFileLock<T>(file: string, fn: () => Promise<T>): Promise<T> {
  const previous = locks.get(file) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(fn);
  locks.set(file, next);
  try {
    return await next;
  } finally {
    if (locks.get(file) === next) locks.delete(file);
  }
}

/** A section must stay exactly one `## ` section, otherwise the overview would address the wrong text. */
function sectionProblem(after: string): string | null {
  const m = msg.edit.save;
  if (!after.startsWith('## ')) return m.sectionStart;
  if (/\n## /.test(after)) return m.sectionTwoHeadings;
  return null;
}

async function gitStep<T>(fn: () => Promise<T>): Promise<{ value: T | null; error: string | null }> {
  try {
    return { value: await fn(), error: null };
  } catch (e) {
    return { value: null, error: (e as Error).message.split('\n')[0].slice(0, 160) };
  }
}

/** Whether the file still holds `before` where the component lives (read only, nothing written). */
async function stillHolds(target: EditTarget, before: string): Promise<boolean> {
  const current = await readFile(target.realFile, 'utf8').catch(() => null);
  if (current === null) return false;
  if (!target.section) return current === before;
  const b = sectionBounds(current, target.section.index, target.section.heading);
  return !!b && current.slice(b.start, b.end) === before;
}

export interface PairPart {
  target: EditTarget;
  before: string;
  after: string;
}
type SaveOk = Extract<SaveResult, { ok: true }>;
export type PairSaveResult = { ok: true; first: SaveOk; second: SaveOk } | { ok: false; conflict: true } | { ok: false; invalid: string };

/**
 * Saves two components as one change (a section and the skill it points to): both or neither. Both are checked
 * before anything is written; if the second still fails, the first is put back (with its own backup and commit).
 */
export async function saveComponentPair(first: PairPart, second: PairPart, deps: Deps): Promise<PairSaveResult> {
  if (!(await stillHolds(first.target, first.before)) || !(await stillHolds(second.target, second.before))) return { ok: false, conflict: true };
  const a = await saveComponentText(first.target, first.before, first.after, deps);
  if (!a.ok) return a;
  const b = await saveComponentText(second.target, second.before, second.after, deps);
  if (b.ok) return { ok: true, first: a, second: b };
  const undo = await saveComponentText(first.target, first.after, first.before, deps);
  if (!undo.ok) return { ok: false, invalid: msg.edit.save.partialSave(a.backup) };
  return b;
}

/**
 * Saves `after` only if the file still contains `before` where the component lives (whole file or its
 * CLAUDE.md section). Order: check → commit the state found on disk (outside changes, baseline) →
 * backup of the checked bytes → atomic write (re-checked right before the rename) → commit of the edit.
 */
export function saveComponentText(target: EditTarget, before: string, after: string, deps: Deps): Promise<SaveResult> {
  return withFileLock(target.realFile, async () => {
    const raw = await readFile(target.realFile);
    const current = raw.toString('utf8');
    if (!Buffer.from(current, 'utf8').equals(raw)) return { ok: false, invalid: msg.edit.save.notUtf8 };

    let next: string;
    if (target.section) {
      const problem = sectionProblem(after);
      if (problem) return { ok: false, invalid: problem };
      const b = sectionBounds(current, target.section.index, target.section.heading);
      if (!b || current.slice(b.start, b.end) !== before) return { ok: false, conflict: true };
      const followed = b.end < current.length;
      const body = followed && !after.endsWith('\n') ? `${after}\n\n` : after;
      next = current.slice(0, b.start) + body + current.slice(b.end);
    } else {
      if (current !== before) return { ok: false, conflict: true };
      next = after;
    }

    const m = msg.edit.save;
    const warnings: string[] = [];
    let repoCreated = false;
    const useGit = target.inRepo && deps.git;
    if (useGit) {
      const created = await gitStep(() => deps.git!.ensureRepo());
      repoCreated = created.value === true;
      // Changes made outside this app (or the first baseline) get their own commit, never mixed into the edit.
      const outside = created.error ? created : await gitStep(() => deps.git!.commitFile(target.realFile, `outside change: ${path.basename(target.realFile)} (state before the edit)`));
      if (outside.error) warnings.push(m.gitProblem(outside.error));
      else if (typeof outside.value === 'object' && outside.value?.status === 'secret') warnings.push(m.secretNotVersioned);
    }

    const stamp = (deps.now?.() ?? new Date()).toISOString().replace(/[:.]/g, '-');
    const backup = path.join(deps.backupRoot, stamp, target.realFile.replace(/^\/+/, ''));
    await mkdir(path.dirname(backup), { recursive: true });
    await writeFile(backup, raw);

    const mode = (await stat(target.realFile)).mode & 0o7777;
    const tmp = path.join(path.dirname(target.realFile), `.${path.basename(target.realFile)}.${randomBytes(6).toString('hex')}.tmp`);
    await writeFile(tmp, next);
    await chmod(tmp, mode);
    // Last check right before replacing: another process may have written in the meantime.
    if (!(await readFile(target.realFile)).equals(raw)) {
      await rm(tmp, { force: true });
      return { ok: false, conflict: true };
    }
    await rename(tmp, target.realFile);

    let commit: string | null = null;
    let commitStatus: CommitOutcome['status'] | 'failed' | 'none' = 'none';
    if (useGit) {
      const name = target.section ? `${path.basename(target.realFile)} (${target.section.heading})` : path.basename(target.realFile);
      const res = await gitStep(() => deps.git!.commitFile(target.realFile, `edit: ${name} via Context Atlas`));
      if (res.error || !res.value) {
        commitStatus = 'failed';
        warnings.push(m.savedCommitFailed(res.error));
      } else {
        commitStatus = res.value.status;
        if (res.value.status === 'committed') commit = res.value.hash;
        if (res.value.status === 'secret') warnings.push(m.savedNotCommittedSecret);
      }
    }
    return { ok: true, backup, commit, commitStatus, warning: warnings.length ? [...new Set(warnings)].join(' ') : null, repoCreated };
  });
}
