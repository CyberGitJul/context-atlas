import { query as sdkQuery, type Options, type SDKMessage, type SDKUserMessage, type SessionStore, type SessionStoreEntry } from '@anthropic-ai/claude-agent-sdk';
import { splitSections } from '../../shared/sections.js';
import type { ReplayAction, ReplaySection } from '../../shared/sessions.js';
import { maskText, toolTitle } from './timeline.js';

/**
 * Debugger, third step: Claude's step once more, from a copy of the session cut right before it — as it was, and
 * without one passage of the instructions. The copy lives in memory; the Agent SDK resumes it in a temporary folder of
 * its own (with the Claude Code login), so nothing under ~/.claude is written, and no tool is ever run.
 */

type Entry = Record<string, any>;
export type QueryFn = (params: { prompt: AsyncIterable<SDKUserMessage>; options?: Options }) => AsyncIterable<SDKMessage>;

/**
 * Attachments Claude Code compares with its own environment when it resumes. The replay has none of the user's
 * instructions, MCP servers or agents, so Claude Code would announce them as removed; frozen into the text Claude saw,
 * they stay in effect.
 */
const TRACKED = new Set(['instructions', 'skill_listing', 'deferred_tools_delta', 'agent_listing_delta', 'mcp_instructions_delta']);
const DENY = 'Replay: tools are not run.';
/** A limit on one replay run, not on the session's length. */
const RUN_MS = 180_000;

/** The transcript's entries; broken lines are left out. */
export function parseEntries(jsonl: string): Entry[] {
  const out: Entry[] = [];
  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (e && typeof e === 'object') out.push(e);
    } catch {
      // A cut or broken line says nothing.
    }
  }
  return out;
}

/**
 * The entries before Claude's response that contains entry `uuid` (file order, up to its parent), and that whole
 * response. Claude Code writes one response as several entries (thinking, text, each tool call) with one message id.
 */
export function cutBefore(entries: Entry[], uuid: string): { kept: Entry[]; response: Entry[] } | null {
  const byUuid = new Map(entries.filter((e) => typeof e.uuid === 'string').map((e) => [e.uuid as string, e]));
  const target = byUuid.get(uuid);
  if (target?.type !== 'assistant') return null;
  const id = target.message?.id;
  let first = target;
  for (let p = byUuid.get(first.parentUuid); id && p?.type === 'assistant' && p.message?.id === id; p = byUuid.get(first.parentUuid)) first = p;
  const end = entries.findIndex((e) => e.uuid === first.parentUuid);
  if (end < 0) return null;
  const response = id ? entries.filter((e) => e.type === 'assistant' && !e.isSidechain && e.message?.id === id) : [target];
  return { kept: entries.slice(0, end + 1), response };
}

/** Text and tool calls of a response, masked, titled as in the timeline. */
export function actionsOf(blocks: unknown[], homeDir: string): ReplayAction[] {
  const out: ReplayAction[] = [];
  for (const b of blocks as Entry[]) {
    if (b?.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
      const text = maskText(b.text, homeDir);
      out.push({ kind: 'answer', title: text.split('\n').map((l) => l.trim()).find(Boolean) ?? '', text });
    } else if (b?.type === 'tool_use' && typeof b.name === 'string') {
      const input = (b.input && typeof b.input === 'object' ? b.input : {}) as Record<string, unknown>;
      out.push({ kind: 'tool', tool: b.name, title: maskText(toolTitle(b.name, input), homeDir), text: maskText(JSON.stringify(input, null, 2), homeDir) });
    }
  }
  return out;
}

export const responseBlocks = (response: Entry[]): unknown[] => response.flatMap((e) => (Array.isArray(e.message?.content) ? e.message.content : []));

/** A section the replay can leave out, with its raw text (never sent to the page). */
export type Passage = ReplaySection & { text: string };

/** The sections of the instruction files in effect at the cut (the latest copy of each file). */
export function passages(kept: Entry[], homeDir: string): Passage[] {
  const files = new Map<string, string>();
  for (const e of kept) {
    const a = e.type === 'attachment' ? e.attachment : null;
    if (a?.type !== 'instructions') continue;
    for (const p of Array.isArray(a.removed) ? a.removed : []) files.delete(p);
    for (const f of Array.isArray(a.files) ? a.files : []) if (typeof f?.path === 'string' && typeof f.content === 'string') files.set(f.path, f.content);
  }
  const out: Passage[] = [];
  [...files].forEach(([file, content], fi) => {
    const { preamble, sections } = splitSections(content);
    // Text before the first heading counts as a passage of its own; each text without trailing space, as Claude Code trims files.
    const parts = [...(preamble.trim() ? [{ heading: preamble.trim().split('\n')[0].replace(/^#+\s*/, '') || '(start of file)', text: preamble.trim() }] : []), ...sections.map((x) => ({ heading: x.heading.slice(3).trim(), text: x.text.trimEnd() }))];
    parts.forEach((x, si) => out.push({ id: `${fi}.${si}`, file: maskText(file, homeDir), heading: maskText(x.heading, homeDir), chars: x.text.length, text: x.text }));
  });
  return out;
}

/** Replaces `from` with `to` in every string of a JSON value. */
function replaceDeep(v: unknown, from: string, to: string): unknown {
  if (typeof v === 'string') return v.split(from).join(to);
  if (Array.isArray(v)) return v.map((x) => replaceDeep(x, from, to));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, replaceDeep(x, from, to)]));
  return v;
}

/**
 * The copy Claude Code resumes: under its own session id, the tracked attachments frozen into the text Claude saw
 * (`rendered`), and with `swap` the passage replaced in every text it appears in. `hits` counts the entries it changed.
 */
export function prepareCopy(kept: Entry[], sessionId: string, swap?: { from: string; to: string }): { entries: Entry[]; hits: number } {
  let hits = 0;
  const entries = kept.map((orig) => {
    let e = structuredClone(orig);
    if ('sessionId' in e) e.sessionId = sessionId;
    if (swap?.from) {
      const before = JSON.stringify(e);
      e = replaceDeep(e, swap.from, swap.to) as Entry;
      if (JSON.stringify(e) !== before) hits++;
    }
    if (e.type === 'attachment' && TRACKED.has(e.attachment?.type) && Array.isArray(e.rendered)) {
      const { attachment: _a, rendered, renderedRole: _r, ...rest } = e;
      const content = (rendered as Entry[]).flatMap((r) => (typeof r?.content === 'string' ? [{ type: 'text', text: r.content }] : Array.isArray(r?.content) ? r.content : []));
      e = { ...rest, type: 'user', isMeta: true, message: { role: 'user', content } };
    }
    return e;
  });
  return { entries, hits };
}

export interface ReplayRun {
  entries: Entry[];
  sessionId: string;
  /** The session's working folder; Claude Code resumes there (tools never run). */
  cwd: string;
  model: string;
  query?: QueryFn;
  signal?: AbortSignal;
}

/** Claude's next response from the copy: its text and tool calls, raw. Claude Code continues the cut turn by itself. */
export async function replayOnce(run: ReplayRun): Promise<unknown[]> {
  const q = run.query ?? (sdkQuery as QueryFn);
  // Serves the prepared copy for the resume; what Claude Code mirrors back is not kept.
  const store: SessionStore = { append: async () => {}, load: async ({ sessionId }) => (sessionId === run.sessionId ? (run.entries as SessionStoreEntry[]) : null) };
  const abort = new AbortController();
  const stop = () => abort.abort();
  run.signal?.addEventListener('abort', stop, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    stop();
  }, RUN_MS);
  // No new message: the input stays open and empty until the end, so the response continues the cut turn.
  const ended = new Promise<void>((resolve) => abort.signal.addEventListener('abort', () => resolve(), { once: true }));
  const noInput = async function* (): AsyncGenerator<SDKUserMessage> {
    await ended;
  };
  const deny = async () => ({ hookSpecificOutput: { hookEventName: 'PreToolUse' as const, permissionDecision: 'deny' as const, permissionDecisionReason: DENY } });
  const blocks: unknown[] = [];
  const why = (fallback: string) => (timedOut ? 'timed out' : run.signal?.aborted ? 'stopped' : fallback);
  try {
    for await (const m of q({
      prompt: noInput(),
      options: {
        cwd: run.cwd,
        resume: run.sessionId,
        sessionStore: store,
        model: run.model,
        settingSources: [],
        strictMcpConfig: true,
        permissionMode: 'dontAsk',
        canUseTool: async () => ({ behavior: 'deny', message: DENY }),
        hooks: { PreToolUse: [{ hooks: [deny] }] },
        maxTurns: 1,
        abortController: abort,
        env: { ...process.env, CLAUDE_CODE_RESUME_INTERRUPTED_TURN: '1', CLAUDE_AGENT_SDK_CLIENT_APP: 'context-atlas' },
      },
    })) {
      if (m.type === 'assistant' && m.parent_tool_use_id === null) blocks.push(...(m.message.content as unknown[]));
      // The refused first tool call comes back as a tool result: the response is complete.
      else if (m.type === 'user' && blocks.length) break;
      else if (m.type === 'result') {
        if (!blocks.length) throw new Error(m.subtype === 'success' ? m.result || 'no response' : [m.subtype, ...m.errors].join(': '));
        break;
      }
    }
  } catch (e) {
    throw new Error(why((e as Error).message));
  } finally {
    clearTimeout(timer);
    run.signal?.removeEventListener('abort', stop);
    abort.abort();
  }
  if (!blocks.length) throw new Error(why('no response'));
  return blocks;
}
