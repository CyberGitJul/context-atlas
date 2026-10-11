import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Component, Origin } from '../../shared/model.js';
import { msg } from '../messages/index.js';
import { redact } from '../redact.js';
import { isObject, readJsonChecked, readJson, sha256, truncate, type ScanContext } from './context.js';
import type { PluginInfo } from './plugins.js';

/** Sources Claude only sees at runtime (claude.ai connectors, IDE, browser) can't be scanned; they are listed by hand. */
const GENERIC_LIVE_SOURCES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'config', 'live-sources.json');

type ServerDef = { type?: string; command?: string; args?: string[]; url?: string; env?: Record<string, unknown>; headers?: Record<string, unknown> };
type LiveSource = { name: string; via: 'claude.ai' | 'ide' | 'chrome'; note?: string };

/** Only names of env vars and headers leave this function, never their values. */
function serverComponent(name: string, def: ServerDef, origin: Origin, sourcePath: string): Component {
  const args = Array.isArray(def.args) ? def.args.map(String) : [];
  const target = redact(typeof def.url === 'string' ? def.url : [typeof def.command === 'string' ? def.command : '', ...args].join(' ').trim());
  const envKeys = isObject(def.env) ? Object.keys(def.env) : [];
  const headerKeys = isObject(def.headers) ? Object.keys(def.headers) : [];
  const originKey = origin.type === 'plugin' ? `plugin:${origin.plugin}` : origin.type;
  return {
    id: `mcp:${originKey}:${name}`,
    kind: 'mcp',
    name,
    origin,
    phases: ['always'],
    sourcePath,
    enabled: true,
    summary: truncate(target, 120),
    contextWords: 0,
    hash: sha256([name, target, ...envKeys, ...headerKeys].join('\0')),
    detail: { type: def.type ?? (def.url ? 'http' : 'stdio'), target: truncate(target, 200), envKeys, headerKeys },
  };
}

function servers(json: unknown): Record<string, unknown> {
  const v = isObject(json) ? json.mcpServers : undefined;
  return isObject(v) ? v : {};
}

/** Valid server definitions only; anything else is reported, never shown. */
function validServers(defs: Record<string, unknown>, file: string, ctx: ScanContext): [string, ServerDef][] {
  const out: [string, ServerDef][] = [];
  for (const [name, def] of Object.entries(defs)) {
    if (isObject(def)) out.push([name, def as ServerDef]);
    else ctx.report?.({ file, error: msg.edit.scan.mcpNotObject(name) });
  }
  return out;
}

export async function scanMcp(ctx: ScanContext, plugins: PluginInfo[]): Promise<Component[]> {
  const out: Component[] = [];
  const userFile = path.join(ctx.homeDir, '.claude.json');
  const user = await readJsonChecked(ctx, userFile);
  if (user?.ok) for (const [name, def] of validServers(servers(user.value), userFile, ctx)) out.push(serverComponent(name, def, { type: 'user' }, userFile));

  for (const plugin of plugins.filter((p) => p.enabled)) {
    for (const file of [path.join(plugin.root, '.mcp.json'), path.join(plugin.root, '.claude-plugin', 'plugin.json')]) {
      const res = await readJsonChecked(ctx, file);
      if (!res?.ok) continue;
      if (!isObject(res.value)) continue;
      const defs = file.endsWith('.mcp.json') && !('mcpServers' in res.value) ? res.value : servers(res.value);
      for (const [name, def] of validServers(defs, file, ctx)) out.push(serverComponent(name, def, { type: 'plugin', plugin: plugin.id }, file));
    }
  }

  // The user's own list first; the generic one in config/ is empty.
  const live = (ctx.personalDir ? await readJson<LiveSource[]>(path.join(ctx.personalDir, 'live-sources.json')) : null) ?? (await readJson<LiveSource[]>(GENERIC_LIVE_SOURCES));
  for (const s of live?.ok ? live.value : []) {
    out.push({
      id: `mcp:live:${s.name}`,
      kind: 'mcp',
      name: s.name,
      origin: { type: 'live', via: s.via },
      phases: ['always'],
      sourcePath: null,
      enabled: true,
      summary: s.note ?? null,
      contextWords: 0,
      hash: sha256(`live:${s.name}`),
      detail: { liveOnly: true },
    });
  }
  return out;
}
