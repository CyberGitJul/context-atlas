import { open, readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { SessionSummary, SessionTimeline, StepDetail } from '../../shared/sessions.js';
import type { ScanContext } from '../scan/context.js';
import { maskText, parseTimeline, type FullStep, type ParsedSession } from './timeline.js';

/** How many sessions the list shows, newest first across all projects. */
export const LIST_LIMIT = 60;
/** Bytes read from the start and the end of a file for its list entry. */
const PEEK = 64 * 1024;
const DETAIL_MAX = 100_000;

// Folder names under ~/.claude/projects and session file names; nothing with a slash or a leading dot gets through.
const PROJECT = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;
const SESSION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const projectsDir = (ctx: ScanContext) => path.join(ctx.claudeDir, 'projects');

/** The transcript file of a session, or null if the names are not a session of this projects folder. */
function sessionFile(ctx: ScanContext, project: string, id: string): string | null {
  return PROJECT.test(project) && SESSION.test(id) ? path.join(projectsDir(ctx), project, `${id}.jsonl`) : null;
}

async function peek(file: string, size: number): Promise<{ head: string; tail: string }> {
  const fh = await open(file, 'r');
  try {
    const read = async (pos: number, len: number) => {
      const buf = Buffer.alloc(len);
      const { bytesRead } = await fh.read(buf, 0, len, pos);
      return buf.subarray(0, bytesRead).toString('utf8');
    };
    const head = await read(0, Math.min(size, PEEK));
    const tail = size > PEEK ? await read(size - PEEK, PEEK) : '';
    // Cut lines are dropped: the head loses its last line, the tail its first.
    return { head: size > PEEK ? head.slice(0, head.lastIndexOf('\n') + 1) : head, tail: tail.slice(tail.indexOf('\n') + 1) };
  } finally {
    await fh.close();
  }
}

/** The latest session title in a piece of transcript. */
function lastTitle(text: string): string | null {
  let title: string | null = null;
  for (const line of text.split('\n')) {
    if (!line.includes('"ai-title"')) continue;
    try {
      const e = JSON.parse(line);
      if (e?.type === 'ai-title' && typeof e.aiTitle === 'string') title = e.aiTitle;
    } catch {
      // A cut or broken line says nothing.
    }
  }
  return title;
}

/** The newest sessions of all projects; each entry reads only the start and the end of its file. */
export async function listSessions(ctx: ScanContext, limit = LIST_LIMIT): Promise<SessionSummary[]> {
  const root = projectsDir(ctx);
  const projects = await readdir(root, { withFileTypes: true }).catch(() => []);
  const files: { project: string; id: string; file: string; mtime: Date; size: number }[] = [];
  for (const p of projects) {
    if (!p.isDirectory() || !PROJECT.test(p.name)) continue;
    const names = await readdir(path.join(root, p.name)).catch(() => [] as string[]);
    for (const name of names) {
      const id = name.endsWith('.jsonl') ? name.slice(0, -6) : '';
      if (!SESSION.test(id)) continue;
      const file = path.join(root, p.name, name);
      const s = await stat(file).catch(() => null);
      if (s?.isFile()) files.push({ project: p.name, id, file, mtime: s.mtime, size: s.size });
    }
  }
  files.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
  return Promise.all(
    files.slice(0, limit).map(async (f) => {
      const { head, tail } = await peek(f.file, f.size).catch(() => ({ head: '', tail: '' }));
      const parsed = parseTimeline(head, ctx.homeDir);
      const title = lastTitle(tail) ?? parsed.title;
      return { project: f.project, cwd: parsed.cwd, id: f.id, title: title ? maskText(title, ctx.homeDir) : 'No messages', modified: f.mtime.toISOString(), bytes: f.size };
    }),
  );
}

export interface SessionReader {
  read(project: string, id: string): Promise<Omit<SessionTimeline, 'ai'> | null>;
  step(project: string, id: string, i: number): Promise<StepDetail | null>;
  /** All steps with their full texts, for "Why?". */
  steps(project: string, id: string): Promise<FullStep[] | null>;
}

/** Reads one session at a time and keeps it, so opening steps one after another does not parse the file again. */
export function createSessionReader(ctx: ScanContext): SessionReader {
  let cached: { key: string; summary: SessionSummary; parsed: ParsedSession } | null = null;

  const load = async (project: string, id: string) => {
    const file = sessionFile(ctx, project, id);
    if (!file) return null;
    const s = await stat(file).catch(() => null);
    if (!s?.isFile()) return null;
    const key = `${file}:${s.mtimeMs}:${s.size}`;
    if (cached?.key === key) return cached;
    const parsed = parseTimeline(await readFile(file, 'utf8'), ctx.homeDir);
    const summary: SessionSummary = { project, cwd: parsed.cwd, id, title: parsed.title ?? 'No messages', modified: s.mtime.toISOString(), bytes: s.size };
    cached = { key, summary, parsed };
    return cached;
  };

  return {
    // The full texts stay on the server until a step is opened.
    read: async (project, id) => {
      const loaded = await load(project, id);
      return loaded && { session: loaded.summary, steps: loaded.parsed.steps.map(({ text: _text, ...step }) => step) };
    },
    step: async (project, id, i) => {
      const step = (await load(project, id))?.parsed.steps[i];
      return step ? { i, text: step.text.slice(0, DETAIL_MAX), cut: step.text.length > DETAIL_MAX } : null;
    },
    steps: async (project, id) => (await load(project, id))?.parsed.steps ?? null,
  };
}
