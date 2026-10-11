import { access } from 'node:fs/promises';
import path from 'node:path';
import type { Component } from '../../shared/model.js';
import { msg } from '../messages/index.js';
import type { ScanContext } from '../scan/context.js';

export interface StaleFinding {
  kind: 'path' | 'name';
  ref: string;
  problem: string;
  level: 'error' | 'note';
}

/** Names a text may refer to: skills (also `plugin:skill`), agents, commands, MCP servers, hook scripts. */
export function knownNamesFrom(components: Component[]): Set<string> {
  const names = new Set<string>();
  for (const c of components) {
    if (!['skill', 'agent', 'command', 'mcp', 'hook', 'plugin'].includes(c.kind)) continue;
    names.add(c.name.toLowerCase());
    if (c.origin.type === 'plugin') {
      const plugin = c.origin.plugin.split('@')[0].toLowerCase();
      names.add(plugin);
      names.add(`${plugin}:${c.name.toLowerCase()}`);
    }
  }
  return names;
}

// Typographic quotes, ellipsis and anchors end a path; /home/ only counts when not part of a URL.
const STOP = String.raw`\s\`'"()<>[\]{},;|*„“”‚‘’»«…#`;
const PATH_RE = new RegExp(String.raw`(?:~|\$HOME|\$\{HOME\})\/[^${STOP}]*|(?<![\w:/.-])\/home\/[A-Za-z0-9._-]+\/[^${STOP}]*`, 'g');
const NAME_RE = /`([A-Za-z0-9][A-Za-z0-9:_-]{1,63})`/g;
const KEYWORD_RE = /skill|subagent|agent|mcp|plugin|hook/i;

function isKnown(name: string, known: Set<string>): boolean {
  const n = name.toLowerCase();
  if (known.has(n)) return true;
  const afterColon = n.includes(':') ? n.slice(n.indexOf(':') + 1) : null;
  if (afterColon && known.has(afterColon)) return true;
  // MCP tool names are `<server>_<tool>`.
  return [...known].some((k) => n.startsWith(`${k}_`));
}

/** Local check without AI: missing paths are errors, unknown names next to a keyword are hints. */
export async function findStale(text: string, known: Set<string>, ctx: ScanContext): Promise<{ checked: number; findings: StaleFinding[] }> {
  const texts = msg.edit.stale;
  const findings: StaleFinding[] = [];
  let checked = 0;
  const seen = new Set<string>();

  for (const m of text.matchAll(PATH_RE)) {
    const ref = m[0].replace(/[.,:;!?]+$/, '').replace(/\/+$/, '');
    if (seen.has(ref) || /\/$|~$/.test(ref)) continue;
    seen.add(ref);
    checked++;
    const resolved = path.normalize(ref.replace(/^(~|\$HOME|\$\{HOME\})/, ctx.homeDir));
    const exists = await access(resolved).then(() => true, () => false);
    if (exists) continue;
    // Paths outside the own home (e.g. /home/pi on a Raspberry) may well exist on another machine.
    const local = resolved === ctx.homeDir || resolved.startsWith(ctx.homeDir + path.sep);
    findings.push(local
      ? { kind: 'path', ref, problem: texts.pathMissing, level: 'error' }
      : { kind: 'path', ref, problem: texts.pathOtherHost, level: 'note' });
  }

  for (const m of text.matchAll(NAME_RE)) {
    const name = m[1];
    const start = m.index ?? 0;
    const window = text.slice(Math.max(0, start - 40), start + m[0].length + 40);
    if (!KEYWORD_RE.test(window) || seen.has(name)) continue;
    seen.add(name);
    checked++;
    if (!isKnown(name, known)) findings.push({ kind: 'name', ref: name, problem: texts.nameUnknown, level: 'note' });
  }
  return { checked, findings };
}
