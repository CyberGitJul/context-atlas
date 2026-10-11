import type { Component, Kind } from '../../shared/model.js';
import { redact } from '../redact.js';
import { truncate } from '../scan/context.js';
import { KIND, LINKED_LIMIT, origin } from './chat.js';
import { RouterError, type ChatMessage, type RouterChatClient, type RouterMessage, type ToolCall, type ToolDef } from './router-client.js';
import { msg } from '../messages/index.js';

/** The chat's only tool: the full text of a component the page context shows in short form. */
export const READ_TOOL = 'read_component';
/** Requests that may read; one more follows that must answer (each request is a router round of ~20 s). */
export const MAX_TOOL_ROUNDS = 4;
/** Characters all reads of one answer may add together. */
export const READ_BUDGET = 120_000;
/** Calls per round that are carried out; the rest get a refusal as their result. */
const MAX_CALLS_PER_ROUND = 8;

const KINDS = Object.keys(KIND) as Kind[];

export const CHAT_TOOLS: ToolDef[] = [
  {
    type: 'function',
    function: {
      name: READ_TOOL,
      description:
        'Reads the full text of a component of the user\'s Claude Code configuration (CLAUDE.md section, rule, skill, agent, command, hook, …). ' +
        'Use it when the page context shows a component only in short form and you need the exact wording, for example to check for duplicates or contradictions. ' +
        'Secrets come masked (***).',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Name exactly as in the page context inside “…”, e.g. the heading of a CLAUDE.md section or the skill name.' },
          kind: { type: 'string', enum: KINDS, description: 'Kind, if known: instruction = CLAUDE.md section, rule, skill, hook, mcp, plugin, agent, command, output-style, setting, memory.' },
        },
        required: ['name'],
      },
    },
  },
];

export interface ReadResult {
  /** Shown in the chat while Opus reads ("reading …") and kept in the log. */
  label: string;
  content: string;
  found: boolean;
}

export type LoadText = (c: Component) => Promise<{ text: string; file: string | null }>;

const norm = (s: string) =>
  s
    .trim()
    .replace(/^[„“”"'‚‘’]+|[„“”"'‚‘’]+$/g, '')
    .replace(/\s+/g, ' ')
    .toLowerCase();

const labelOf = (c: Component) => `${KIND[c.kind]} “${redact(c.name)}”`;

/** Carries out read_component calls against the scanned components; one reader per answer (shared budget). */
export function createReader(components: Component[], load: LoadText): (call: ToolCall) => Promise<ReadResult> {
  let used = 0;
  return async (call) => {
    if (call.name !== READ_TOOL) return { label: call.name, found: false, content: `Unknown tool ${call.name}. The only tool is ${READ_TOOL}.` };
    let args: { name?: unknown; kind?: unknown };
    try {
      args = JSON.parse(call.arguments || '{}') as typeof args;
    } catch {
      return { label: READ_TOOL, found: false, content: 'Arguments are not valid JSON. Expected: {"name": "…", "kind": "…"}.' };
    }
    const query = typeof args.name === 'string' ? norm(args.name) : '';
    if (!query) return { label: READ_TOOL, found: false, content: 'Without "name" I do not know what to read.' };
    const label = `“${redact(String(args.name).trim())}”`;
    if (used >= READ_BUDGET) return { label, found: false, content: 'Read budget of this answer is used up; work with what you have already read.' };

    const kind = KINDS.includes(args.kind as Kind) ? (args.kind as Kind) : null;
    const ofKind = kind ? components.filter((c) => c.kind === kind) : components;
    const pool = ofKind.length ? ofKind : components;
    const exact = pool.filter((c) => norm(c.name) === query);
    const partial = exact.length ? [] : pool.filter((c) => norm(c.name).includes(query) || query.includes(norm(c.name)));
    const hits = exact.length ? exact : partial.length === 1 ? partial : [];

    if (!hits.length) {
      const content = partial.length
        ? `Several match, use the exact name:\n${partial.slice(0, 20).map((c) => `- ${labelOf(c)}`).join('\n')}`
        : kind
          ? `Nothing found. Available (${KIND[kind]}):\n${ofKind.slice(0, 40).map((c) => `- “${redact(c.name)}”`).join('\n')}`
          : 'Nothing found. Use the name exactly as it appears in the page context inside “…”, and pass "kind" as well.';
      return { label: msg.app.chat.readNotFound(label), found: false, content };
    }

    const parts = await Promise.all(
      hits.map(async (c) => {
        const { text, file } = await load(c);
        const body = text || c.summary || '(no text in a file, acts only at runtime)';
        // A cut text must never come back as a whole new file: its tail would be lost.
        const cut = body.length > LINKED_LIMIT ? ` (cut: ${LINKED_LIMIT} of ${body.length} characters; do not rewrite as a whole file)` : '';
        const facts = [origin(c), c.enabled ? null : 'disabled'].filter(Boolean).join('; ');
        return [`### ${labelOf(c)} (${facts})${cut}`, `File: ${redact(file ?? '–')}`, '<<<', truncate(redact(body), LINKED_LIMIT), '>>>'].join('\n');
      }),
    );
    const content = parts.join('\n\n');
    used += content.length;
    return { label: hits.length > 1 ? `${labelOf(hits[0])} (${hits.length}×)` : labelOf(hits[0]), found: true, content };
  };
}

const NO_TOOLS = '\n\n(The read_component tool is not available right now. Work only with the page context and say when you lack a full text.)';
// Only the router answers 403 to tools (the other providers never set a status on their errors).

export interface ChatRun {
  client: RouterChatClient;
  system: string;
  messages: ChatMessage[];
  model: string;
  signal?: AbortSignal;
  read: (call: ToolCall) => Promise<ReadResult>;
  onText: (t: string) => Promise<void>;
  onRead: (label: string) => Promise<void>;
  onNote: (note: string) => Promise<void>;
}

/**
 * One chat answer with reading rounds: the model may call read_component, the server reads and sends the
 * result back, until it answers (at the latest in the round after MAX_TOOL_ROUNDS, where it may only answer).
 * Without the router's permission for tools it answers once without them. A provider that runs the tool loop
 * itself (Agent SDK) reads through `execute` within one round instead.
 */
export async function runChat(r: ChatRun): Promise<{ reply: string; reads: string[] }> {
  const history: RouterMessage[] = [...r.messages];
  const reads: string[] = [];
  let reply = '';
  let tools = true;
  let executed = 0;
  // Same limits as the rounds below: at most MAX_CALLS_PER_ROUND reads per round, MAX_TOOL_ROUNDS rounds.
  const execute = async (call: ToolCall) => {
    if (executed++ >= MAX_TOOL_ROUNDS * MAX_CALLS_PER_ROUND) return `At most ${MAX_TOOL_ROUNDS * MAX_CALLS_PER_ROUND} reads per answer; answer now with what you have read.`;
    const res = await r.read(call);
    reads.push(res.label);
    await r.onRead(res.label);
    return res.content;
  };
  for (let round = 0; ; round++) {
    const calls: ToolCall[] = [];
    let native: unknown;
    let text = '';
    try {
      const req = tools ? { system: r.system, tools: CHAT_TOOLS, toolChoice: round >= MAX_TOOL_ROUNDS ? ('none' as const) : ('auto' as const) } : { system: r.system + NO_TOOLS };
      for await (const ev of r.client.chat({ ...req, messages: history, model: r.model, signal: r.signal, execute, maxToolRounds: MAX_TOOL_ROUNDS })) {
        if (typeof ev !== 'string') {
          if ('native' in ev) native = ev.native;
          else calls.push(ev);
          continue;
        }
        // Text of a later round starts a new paragraph.
        if (!text && reply && !reply.endsWith('\n')) {
          reply += '\n\n';
          await r.onText('\n\n');
        }
        text += ev;
        reply += ev;
        await r.onText(ev);
      }
    } catch (e) {
      if (tools && round === 0 && !text && e instanceof RouterError && e.status === 403) {
        tools = false;
        round = -1;
        await r.onNote(msg.app.chat.noTools);
        continue;
      }
      throw e;
    }
    if (!calls.length || !tools) return { reply, reads };
    const paired = calls.map((c, i) => ({ ...c, id: c.id || `call_${round}_${i}` }));
    history.push({ role: 'assistant', content: text || null, tool_calls: paired.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments } })), ...(native === undefined ? {} : { native }) });
    for (const [i, c] of paired.entries()) {
      if (r.signal?.aborted) throw r.signal.reason ?? new Error('aborted');
      const res = i < MAX_CALLS_PER_ROUND ? await r.read(c) : { label: c.name, found: false, content: `At most ${MAX_CALLS_PER_ROUND} reads per round.` };
      if (i < MAX_CALLS_PER_ROUND) {
        reads.push(res.label);
        await r.onRead(res.label);
      }
      history.push({ role: 'tool', tool_call_id: c.id, content: res.content });
    }
  }
}
