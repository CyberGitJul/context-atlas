import path from 'node:path';
import type { Component, Origin, Phase } from '../../shared/model.js';
import { redact } from '../redact.js';
import { isFile, isObject, readJsonChecked, readText, sha256, truncate, type ScanContext } from './context.js';

/** Hook component plus server-only input for the AI explanation (never sent over the API). */
export interface ScannedHook extends Component {
  explainInput: string;
}

const PHASE_BY_EVENT: Record<string, Phase> = {
  SessionStart: 'session-start',
  UserPromptSubmit: 'prompt',
  Stop: 'end',
  SubagentStop: 'end',
  PreCompact: 'end',
  SessionEnd: 'end',
};

export function eventToPhase(event: string): Phase {
  return PHASE_BY_EVENT[event] ?? 'tool';
}

/** Launchers that run the real script; their own binaries are never the script. */
const LAUNCHERS = new Set(['env', 'node', 'bash', 'sh', 'zsh', 'python', 'python3', 'deno', 'bun', 'npx', 'tsx', 'exec', 'sudo', 'nohup', 'setsid']);
const SCRIPT_READ_LIMIT = 20_000;

interface Script {
  file: string;
  text: string;
}

/** Reads a text file; null for missing or binary files (NUL byte in the first 8 KB). */
async function readScript(file: string): Promise<Script | null> {
  if (!(await isFile(file))) return null;
  const text = await readText(file);
  if (text === null || text.slice(0, 8192).includes('\u0000')) return null;
  return { file, text: text.slice(0, SCRIPT_READ_LIMIT) };
}

function tokenize(command: string): string[] {
  return command.split(/[\s;|&()]+/).map((t) => t.replace(/["']/g, '')).filter(Boolean);
}

/**
 * Scripts a hook command runs: the first path-like argument that is a text file
 * (launchers like env/bash skipped), plus plain arguments that name a file next to it
 * — so a wrapper like `run-hook.cmd session-start` also yields the real script.
 */
export async function resolveScripts(command: string, ctx: ScanContext, pluginRoot?: string | null): Promise<Script[]> {
  const tokens = tokenize(command);
  const scripts: Script[] = [];
  for (const raw of tokens) {
    if (scripts.length === 0) {
      if (!/^(\$\{CLAUDE_PLUGIN_ROOT\}|\$HOME|\$\{HOME\}|~\/|\/)/.test(raw)) continue;
      if (raw.startsWith('${CLAUDE_PLUGIN_ROOT}') && !pluginRoot) continue;
      const expanded = raw
        .replace('${CLAUDE_PLUGIN_ROOT}', pluginRoot ?? '')
        .replace(/^(\$HOME|\$\{HOME\})/, ctx.homeDir)
        .replace(/^~\//, ctx.homeDir + '/');
      if (LAUNCHERS.has(path.basename(expanded))) continue;
      const script = await readScript(expanded);
      if (script) scripts.push(script);
      continue;
    }
    if (raw.startsWith('-') || raw.includes('$') || raw.includes('/')) continue;
    const sibling = await readScript(path.join(path.dirname(scripts[0].file), raw));
    if (sibling && !scripts.some((s) => s.file === sibling.file)) scripts.push(sibling);
  }
  return scripts;
}

function originKey(origin: Origin): string {
  return origin.type === 'plugin' ? `plugin:${origin.plugin}` : origin.type;
}

/** Turns a `{ hooks: { Event: [groups] } }` object (settings.json or plugin hooks.json) into components; malformed entries are skipped. */
export async function scanHookFile(
  json: unknown,
  origin: Origin,
  pluginRoot: string | null,
  ctx: ScanContext,
  file: string,
  enabled = true,
): Promise<ScannedHook[]> {
  const events = isObject(json) ? json.hooks : undefined;
  if (!isObject(events)) return [];
  const out: ScannedHook[] = [];
  for (const [event, groups] of Object.entries(events)) {
    if (!Array.isArray(groups)) continue;
    for (const [gi, group] of groups.entries()) {
      if (!isObject(group) || !Array.isArray(group.hooks)) continue;
      const matcher = typeof group.matcher === 'string' && group.matcher ? group.matcher : '*';
      for (const [hi, hook] of group.hooks.entries()) {
        if (!isObject(hook)) continue;
        const raw = [hook.command, hook.prompt, hook.url].find((v) => typeof v === 'string') as string | undefined;
        if (!raw) continue;
        const isCommand = typeof hook.command === 'string';
        const scripts = isCommand ? await resolveScripts(raw, ctx, pluginRoot) : [];
        const shown = redact(raw);
        const main = scripts[0];
        out.push({
          id: `hook:${originKey(origin)}:${path.basename(file)}:${event}:${gi}:${hi}`,
          kind: 'hook',
          name: main ? path.basename(main.file) : truncate(shown, 40),
          origin,
          phases: [eventToPhase(event)],
          sourcePath: main?.file ?? file,
          enabled,
          summary: truncate(shown, 160),
          contextWords: 0,
          hash: sha256([event, matcher, raw, ...scripts.map((s) => s.text)].join('\0')),
          detail: { event, matcher, type: typeof hook.type === 'string' ? hook.type : 'command', file, command: truncate(shown, 300), hasScript: scripts.length > 0 },
          explainInput: [`Befehl: ${shown}`, ...scripts.map((s) => `Skript ${path.basename(s.file)}:\n${redact(s.text)}`)].join('\n\n'),
        });
      }
    }
  }
  return out;
}

/** Hooks from ~/.claude/settings.json and settings.local.json. Broken or missing files yield no hooks (and a reported problem). */
export async function scanUserHooks(ctx: ScanContext): Promise<ScannedHook[]> {
  const out: ScannedHook[] = [];
  for (const name of ['settings.json', 'settings.local.json']) {
    const file = path.join(ctx.claudeDir, name);
    const res = await readJsonChecked<unknown>(ctx, file);
    if (!res?.ok) continue;
    const disabled = isObject(res.value) && res.value.disableAllHooks === true;
    out.push(...(await scanHookFile(res.value, { type: 'user' }, null, ctx, file, !disabled)));
  }
  return out;
}
