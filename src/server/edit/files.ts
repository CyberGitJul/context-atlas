import { randomBytes } from 'node:crypto';
import { link, lstat, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { msg } from '../messages/index.js';
import { redact } from '../redact.js';
import { jsonErrorIndex, lineColumn } from '../scan/json-position.js';
import type { ScanContext } from '../scan/context.js';
import type { ClaudeGit, CommitOutcome } from './claude-git.js';
import { saveComponentText } from './save.js';

// Warnings are kept as codes and worded when the request answers.
const RUNS_CODE = 'runs-code';
const MAY_RUN_CODE = 'may-run-code';
type Warning = typeof RUNS_CODE | typeof MAY_RUN_CODE;
const warningText = (w: Warning | null): string | null => (w === null ? null : w === RUNS_CODE ? msg.edit.files.runsCode : msg.edit.files.mayRunCode);
const SCRIPT = /\.(sh|py|js|mjs|cjs|ts)$/;
type Rule = { ok: boolean; warning: Warning | null };

/** Hand-written configuration inside ~/.claude a chat proposal may target (path relative to it, with `/`). */
function claudeRule(rel: string): Rule {
  const no = { ok: false, warning: null };
  if (rel.split('/').some((s) => s.startsWith('.'))) return no;
  if (rel === 'CLAUDE.md') return { ok: true, warning: null };
  if (rel === 'settings.json') return { ok: true, warning: RUNS_CODE };
  if (/^rules\/(?:[^/]+\/)*[^/]+\.md$/.test(rel) || /^output-styles\/[^/]+\.md$/.test(rel)) return { ok: true, warning: null };
  if (/^commands\/(?:[^/]+\/)*[^/]+\.md$/.test(rel) || /^agents\/[^/]+\.md$/.test(rel)) return { ok: true, warning: MAY_RUN_CODE };
  if (/^hooks\/[^/]+\.(sh|py|js|mjs|cjs|ts)$/.test(rel)) return { ok: true, warning: RUNS_CODE };
  // skills/synced is managed by claude.ai; plugins/ and projects/ by Claude Code (not matched at all).
  const skill = rel.match(/^skills\/([^/]+)\/(?:[^/]+\/)*[^/]+\.(md|txt|json|ya?ml|sh|py|js|mjs|cjs|ts)$/);
  if (skill && skill[1] !== 'synced') return { ok: true, warning: SCRIPT.test(rel) ? RUNS_CODE : rel.endsWith('.md') ? MAY_RUN_CODE : null };
  return no;
}

function rule(abs: string, claudeDir: string, extras: string[]): Rule & { inRepo: boolean } {
  const rel = path.relative(claudeDir, abs);
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return { ...claudeRule(rel.split(path.sep).join('/')), inRepo: true };
  if (extras.includes(abs)) return { ok: true, warning: SCRIPT.test(abs) ? RUNS_CODE : null, inRepo: false };
  return { ok: false, warning: null, inRepo: false };
}

/** Real path of a file that may not exist yet: symlinks in the existing part are followed. */
async function realTarget(abs: string): Promise<string> {
  const rest: string[] = [];
  let dir = abs;
  for (;;) {
    const real = await realpath(dir).catch(() => null);
    if (real) return path.join(real, ...rest.reverse());
    const parent = path.dirname(dir);
    if (parent === dir) return abs;
    rest.push(path.basename(dir));
    dir = parent;
  }
}

export interface ProposedFile {
  abs: string;
  /** After following symlinks; this is the file that gets written. */
  real: string;
  /** With ~ for the home directory, as shown to the user. */
  display: string;
  /** Inside ~/.claude: backed up and committed to its versioning. */
  inRepo: boolean;
  exists: boolean;
  current: string | null;
  warning: string | null;
}

/**
 * Decides whether a chat may propose writing this path: own configuration in ~/.claude or one of
 * the single files listed in config/chat-files.json. Checked again after following symlinks.
 */
export async function resolveProposedFile(input: unknown, ctx: ScanContext, extraFiles: string[]): Promise<ProposedFile | { refused: string }> {
  const m = msg.edit.files;
  if (typeof input !== 'string' || !input.trim() || input.includes('\0')) return { refused: m.noPath };
  const expand = (p: string) => (p.startsWith('~/') ? path.join(ctx.homeDir, p.slice(2)) : p);
  const tilde = (p: string) => (p.startsWith(`${ctx.homeDir}/`) ? `~/${p.slice(ctx.homeDir.length + 1)}` : p);
  const expanded = expand(input.trim());
  if (!path.isAbsolute(expanded)) return { refused: m.fullPath };
  const abs = path.normalize(expanded);
  const extras = extraFiles.map((e) => path.normalize(expand(e)));
  const asWritten = rule(abs, ctx.claudeDir, extras);
  if (!asWritten.ok) return { refused: m.notAllowed(tilde(abs)) };

  const real = await realTarget(abs);
  const realClaude = await realpath(ctx.claudeDir).catch(() => ctx.claudeDir);
  const asReal = rule(real, realClaude, await Promise.all(extras.map(realTarget)));
  if (!asReal.ok) return { refused: m.symlinkOut };

  const st = await stat(real).catch(() => null);
  if (st && !st.isFile()) return { refused: m.notRegular };
  // A symlink without target would make creating the file fail forever with "exists already".
  if (!st && (await lstat(abs).catch(() => null))?.isSymbolicLink()) return { refused: m.symlinkNoTarget };
  let current: string | null = null;
  if (st) {
    const raw = await readFile(real);
    current = raw.toString('utf8');
    if (!Buffer.from(current, 'utf8').equals(raw)) return { refused: m.notUtf8 };
    if (redact(current) !== current) return { refused: m.hasSecrets };
  }
  return { abs, real, display: tilde(abs), inRepo: asReal.inRepo, exists: !!st, current, warning: warningText(asWritten.warning ?? asReal.warning) };
}

export type FileSaveResult =
  | { ok: true; backup: string | null; commit: string | null; commitStatus: CommitOutcome['status'] | 'failed' | 'none'; warning: string | null; repoCreated: boolean }
  | { ok: false; conflict: true }
  | { ok: false; invalid: string };

interface Deps {
  backupRoot: string;
  git: ClaudeGit | null;
}

/** New file: created without ever replacing one that appeared meanwhile; then committed if inside ~/.claude. */
async function createFile(target: ProposedFile, after: string, deps: Deps): Promise<FileSaveResult> {
  await mkdir(path.dirname(target.real), { recursive: true });
  const tmp = path.join(path.dirname(target.real), `.${path.basename(target.real)}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    await writeFile(tmp, after, { flag: 'wx' });
    // link() fails if the name exists: an atomic "only if still new".
    await link(tmp, target.real);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return { ok: false, conflict: true };
    throw e;
  } finally {
    await rm(tmp, { force: true });
  }
  if (!target.inRepo || !deps.git) return { ok: true, backup: null, commit: null, commitStatus: 'none', warning: null, repoCreated: false };
  try {
    const repoCreated = await deps.git.ensureRepo();
    const res = await deps.git.commitFile(target.real, `add: ${target.display} via Context Atlas`);
    const warning = res.status === 'secret' ? msg.edit.files.createdSecret : null;
    return { ok: true, backup: null, commit: res.status === 'committed' ? res.hash : null, commitStatus: res.status, warning, repoCreated };
  } catch (e) {
    return { ok: true, backup: null, commit: null, commitStatus: 'failed', warning: msg.edit.files.createdCommitFailed((e as Error).message.split('\n')[0].slice(0, 160)), repoCreated: false };
  }
}

/** A broken JSON file is skipped by Claude Code as a whole (with all permission rules and hooks in it). */
function jsonProblem(file: string, text: string): string | null {
  if (!file.endsWith('.json')) return null;
  const at = jsonErrorIndex(text);
  if (at >= 0) {
    const { line, column } = lineColumn(text, at);
    return msg.edit.files.jsonInvalid(line, column);
  }
  const value = JSON.parse(text) as unknown;
  if (path.basename(file) === 'settings.json' && (typeof value !== 'object' || value === null || Array.isArray(value))) return msg.edit.files.settingsNotObject;
  return null;
}

/** `before` null = the file must not exist yet; otherwise it must still hold exactly `before`. */
export async function saveProposedFile(target: ProposedFile, before: string | null, after: string, deps: Deps): Promise<FileSaveResult> {
  const invalid = jsonProblem(target.real, after);
  if (invalid) return { ok: false, invalid };
  if (before === null) return createFile(target, after, deps);
  if (!(await stat(target.real).catch(() => null))) return { ok: false, conflict: true };
  return saveComponentText({ file: target.abs, realFile: target.real, inRepo: target.inRepo }, before, after, deps);
}
