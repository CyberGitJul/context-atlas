import type { StepKind, TimelineStep } from '../../shared/sessions.js';
import { redact } from '../redact.js';

/** A step with its full (masked) text; the page gets the text only on demand. `uuid` (Claude's steps) stays on the server. */
export type FullStep = TimelineStep & { text: string; uuid?: string };

export interface ParsedSession {
  steps: FullStep[];
  /** The latest title Claude Code gave the session, else the first message. */
  title: string | null;
  cwd: string | null;
}

const TITLE_MAX = 140;
const PREVIEW_MAX = 220;

type Entry = Record<string, any>;
type Block = { type?: string; text?: string; [k: string]: unknown };

/** Text of a message or tool result: strings as they are, text blocks joined, images as a placeholder. */
function blocksText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return (content as Block[])
    .map((b) => (b.type === 'text' ? (b.text ?? '') : b.type === 'image' ? '[image]' : ''))
    .filter(Boolean)
    .join('\n');
}

const firstLine = (s: string) => s.split('\n').map((l) => l.trim()).find(Boolean) ?? '';
const shorten = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);
const inner = (s: string, tag: string) => s.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))?.[1]?.trim() ?? null;

/** The one thing that says what a tool call was about. */
function toolSubject(name: string, input: Record<string, unknown>): string | null {
  const str = (k: string) => (typeof input[k] === 'string' && input[k] ? (input[k] as string) : null);
  return (
    str('description') ?? str('skill') ?? str('file_path') ?? str('notebook_path') ?? str('pattern') ?? str('url') ?? str('query') ?? str('command') ?? str('prompt') ?? null
  );
}

/** A tool call's title as the timeline shows it: the tool and what it was about. */
export function toolTitle(name: string, input: Record<string, unknown>): string {
  const subject = toolSubject(name, input);
  return subject ? `${name}: ${firstLine(subject)}` : name;
}

/** Secret-like values masked, the home folder shown as ~ (screenshots and shared links don't carry the user name). */
export function maskText(s: string, homeDir: string): string {
  const masked = redact(s);
  return homeDir ? masked.split(homeDir).join('~') : masked;
}

/**
 * Reads a Claude Code session transcript (one JSON object per line) into timeline steps, in file order.
 * Subagent entries, thinking and bookkeeping entries are left out; every text is masked and shows ~ for the home folder.
 */
export function parseTimeline(jsonl: string, homeDir: string): ParsedSession {
  const clean = (s: string) => maskText(s, homeDir);
  const steps: FullStep[] = [];
  /** The tool result per tool step: the preview shows it instead of the call's input. */
  const results = new Map<FullStep, string>();
  const tools = new Map<string, { name: string; step: FullStep; subject: string | null }>();
  let title: string | null = null;
  let firstPrompt: string | null = null;
  let cwd: string | null = null;

  const add = (kind: StepKind, at: string, rawTitle: string, text: string, extra: Partial<FullStep> = {}): FullStep => {
    const step: FullStep = { i: steps.length, at, kind, title: shorten(clean(rawTitle) || kind, TITLE_MAX), preview: '', chars: 0, text: clean(text), ...extra };
    steps.push(step);
    return step;
  };

  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue;
    let e: Entry;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (!e || typeof e !== 'object') continue;
    if (e.type === 'ai-title' && typeof e.aiTitle === 'string') title = e.aiTitle;
    if (e.isSidechain) continue;
    if (!cwd && typeof e.cwd === 'string') cwd = clean(e.cwd);
    const at = typeof e.timestamp === 'string' ? e.timestamp : '';

    if (e.type === 'user') {
      const content = e.message?.content;
      if (Array.isArray(content) && content.some((b: Block) => b.type === 'tool_result')) {
        for (const b of content as Block[]) {
          if (b.type !== 'tool_result' || typeof b.tool_use_id !== 'string') continue;
          const tool = tools.get(b.tool_use_id);
          if (!tool) continue;
          const result = clean(blocksText(b.content));
          results.set(tool.step, result);
          tool.step.text += `\n\n--- Result ---\n${result}`;
          if (b.is_error) tool.step.error = true;
        }
        continue;
      }
      const text = blocksText(content);
      if (e.isCompactSummary) {
        add('notice', at, 'Summary after compaction', text);
        continue;
      }
      if (e.isMeta) {
        if (text.startsWith('<local-command-caveat>')) continue;
        const source = typeof e.sourceToolUseID === 'string' ? tools.get(e.sourceToolUseID) : undefined;
        if (source?.name === 'Skill') add('skill', at, `Skill text: ${source.subject ?? 'skill'}`, text);
        else if (text.startsWith('Stop hook feedback')) add('hook', at, 'Stop hook feedback', text);
        else add('notice', at, firstLine(text), text);
        continue;
      }
      const command = inner(text, 'command-name');
      if (command) {
        const args = inner(text, 'command-args');
        add('notice', at, command, args ? `${command} ${args}` : command);
        continue;
      }
      const stdout = inner(text, 'local-command-stdout');
      if (stdout !== null) {
        if (stdout) add('notice', at, 'Command output', stdout);
        continue;
      }
      if (text.trimStart().startsWith('<task-notification>')) {
        add('notice', at, 'Task notification', text);
        continue;
      }
      if (!text.trim()) continue;
      firstPrompt ??= firstLine(text);
      add('prompt', at, firstLine(text), text);
      continue;
    }

    if (e.type === 'assistant') {
      for (const b of (Array.isArray(e.message?.content) ? e.message.content : []) as Block[]) {
        const uuid = typeof e.uuid === 'string' ? e.uuid : undefined;
        if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) add('answer', at, firstLine(b.text), b.text, { uuid });
        if (b.type === 'tool_use' && typeof b.id === 'string' && typeof b.name === 'string') {
          const input = (b.input && typeof b.input === 'object' ? b.input : {}) as Record<string, unknown>;
          const subject = toolSubject(b.name, input);
          const step = add('tool', at, toolTitle(b.name, input), JSON.stringify(input, null, 2), { tool: b.name, uuid });
          tools.set(b.id, { name: b.name, step, subject });
        }
      }
      continue;
    }

    if (e.type === 'attachment') {
      const a = (e.attachment ?? {}) as Entry;
      switch (a.type) {
        case 'instructions': {
          const files = (Array.isArray(a.files) ? a.files : []) as Entry[];
          if (!files.length) break;
          add('instructions', at, `Instructions: ${files.map((f) => f.path).join(', ')}`, files.map((f) => `# ${f.path} (${f.type})\n\n${f.content ?? ''}`).join('\n\n'));
          break;
        }
        case 'skill_listing':
          add('instructions', at, `Skill list (${a.skillCount ?? '?'} skills)`, String(a.content ?? ''));
          break;
        case 'mcp_instructions_delta':
          if (Array.isArray(a.addedNames) && a.addedNames.length) add('instructions', at, `MCP instructions: ${a.addedNames.join(', ')}`, (a.addedBlocks ?? []).join('\n\n'));
          break;
        case 'hook_additional_context': {
          const tool = typeof a.toolUseID === 'string' ? tools.get(a.toolUseID) : undefined;
          const text = Array.isArray(a.content) ? a.content.join('\n\n') : String(a.content ?? '');
          add('hook', at, `${a.hookEvent ?? 'Unknown'} hook${tool ? ` on ${tool.name}` : ''}`, text);
          break;
        }
        case 'hook_blocking_error':
        case 'hook_non_blocking_error': {
          const err = a.blockingError ?? {};
          const text = [err.blockingError ?? a.stderr ?? a.content ?? '', err.command ?? a.command ? `\n\nCommand: ${err.command ?? a.command}` : ''].join('');
          add('hook', at, `${a.hookEvent ?? 'Unknown'} hook ${a.type === 'hook_blocking_error' ? 'blocked' : 'failed'}`, text, { error: true });
          break;
        }
        case 'queued_command': {
          const text = blocksText(a.prompt);
          if (a.commandMode === 'task-notification') add('notice', at, 'Task notification', text);
          else if (text.trim()) add('prompt', at, firstLine(text), text);
          break;
        }
      }
      continue;
    }

    if (e.type === 'system') {
      if (e.subtype === 'compact_boundary') {
        const m = e.compactMetadata ?? {};
        add('notice', at, `Context compacted (${m.trigger ?? 'unknown'}, ${m.preTokens ?? '?'} tokens before)`, String(e.content ?? ''));
      } else if (e.subtype === 'stop_hook_summary') {
        const extra = [...(e.hookAdditionalContext ?? []), ...(e.hookErrors ?? [])].map(String).filter(Boolean);
        if (extra.length) add('hook', at, 'Stop hook', extra.join('\n\n'), { error: (e.hookErrors ?? []).length > 0 || undefined });
      }
    }
  }

  for (const s of steps) {
    const basis = results.get(s) ?? s.text;
    s.preview = shorten(basis.replace(/\s+/g, ' ').trim(), PREVIEW_MAX);
    s.chars = s.text.length;
  }
  return { steps, title: title ? clean(title) : firstPrompt ? shorten(clean(firstPrompt), TITLE_MAX) : null, cwd };
}
