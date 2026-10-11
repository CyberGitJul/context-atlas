import { createHash } from 'node:crypto';
import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { msg } from '../messages/index.js';
import { appDirs } from '../paths.js';
import { jsonErrorIndex, lineColumn } from './json-position.js';

/** Where to scan. Injected so tests can point at a fixture home. */
export interface ScanContext {
  claudeDir: string;
  homeDir: string;
  /** Managed policy directory, default /etc/claude-code. */
  managedDir?: string;
  /** Folders with the user's projects (PROJECT_ROOTS): skills linked in from there can be edited. Default: none. */
  projectRoots?: string[];
  /** The user's own settings folder (live-sources.json); without it only the generic, empty list in config/ applies. */
  personalDir?: string;
  /** Receives sources that could not be read (set by scanGlobal). */
  report?: (problem: ScanProblem) => void;
}

/** A source that could not be read; `error` never contains file content. */
export interface ScanProblem {
  file: string;
  error: string;
}

export function defaultContext(): ScanContext {
  const homeDir = homedir();
  return {
    homeDir,
    claudeDir: process.env.CLAUDE_CONFIG_DIR || path.join(homeDir, '.claude'),
    projectRoots: parseProjectRoots(process.env.PROJECT_ROOTS, homeDir),
    personalDir: appDirs(process.env, homeDir).config,
  };
}

/** PROJECT_ROOTS: folders separated like PATH (":", on Windows ";"); "~" stands for the home folder, relative entries are ignored. */
export function parseProjectRoots(value: string | undefined, homeDir: string): string[] {
  return (value ?? '')
    .split(path.delimiter)
    .map((s) => s.trim())
    .map((s) => (s === '~' || s.startsWith('~/') ? path.join(homeDir, s.slice(1)) : s))
    .filter((s) => s && path.isAbsolute(s))
    .map((s) => path.resolve(s));
}

/** The project roots as real paths, so they compare with resolved link targets even when a root is itself a link. */
export async function realProjectRoots(ctx: ScanContext): Promise<string[]> {
  return Promise.all((ctx.projectRoots ?? []).map((r) => realpath(r).catch(() => r)));
}

export async function readText(p: string): Promise<string | null> {
  try {
    return await readFile(p, 'utf8');
  } catch {
    return null;
  }
}

export type JsonResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** null = file missing; ok:false = file present but not valid JSON. */
export async function readJson<T = unknown>(p: string): Promise<JsonResult<T> | null> {
  const text = await readText(p);
  if (text === null) return null;
  try {
    return { ok: true, value: JSON.parse(text) as T };
  } catch {
    // Never pass the parser message on: V8 quotes the text around the error, which may contain secrets.
    const { line, column } = lineColumn(text, Math.max(jsonErrorIndex(text), 0));
    return { ok: false, error: msg.edit.scan.invalidJson(line, column) };
  }
}

/** readJson that also reports an invalid file to the scan's problem list. */
export async function readJsonChecked<T = unknown>(ctx: ScanContext, p: string): Promise<JsonResult<T> | null> {
  const res = await readJson<T>(p);
  if (res && !res.ok) ctx.report?.({ file: p, error: res.error });
  return res;
}

export function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export async function listDir(p: string): Promise<string[]> {
  try {
    return (await readdir(p)).sort();
  } catch {
    return [];
  }
}

export async function isFile(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isFile();
  } catch {
    return false;
  }
}

export function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

export function wordCount(s: string): number {
  return s.split(/\s+/).filter(Boolean).length;
}

export function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

export interface Frontmatter {
  data: Record<string, unknown>;
  body: string;
}

/** Lenient `key: value` reader for frontmatter that is not valid YAML (Claude Code accepts e.g. unquoted colons). */
function parseLenient(block: string): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  let key: string | null = null;
  for (const line of block.split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_][\w-]*):\s?(.*)$/);
    if (kv) {
      key = kv[1];
      data[key] = kv[2].trim();
    } else if (key && /^\s+\S/.test(line)) {
      data[key] = `${data[key]} ${line.trim()}`.trim();
    }
  }
  return data;
}

/** YAML frontmatter between leading `---` lines; falls back to a lenient reader for invalid YAML. */
export function parseFrontmatter(text: string): Frontmatter {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { data: {}, body: text };
  let data: Record<string, unknown>;
  try {
    const parsed = parseYaml(m[1]);
    data = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    data = parseLenient(m[1]);
  }
  return { data, body: text.slice(m[0].length) };
}

export function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/** First non-empty, non-heading line, for card summaries. */
export function firstLine(text: string): string | null {
  const line = text.split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('#'));
  return line ? truncate(line, 160) : null;
}
