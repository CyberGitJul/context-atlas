import path from 'node:path';
import type { Component, Kind, Origin } from '../../shared/model.js';
import { redact } from '../redact.js';
import { isFile, listDir, parseFrontmatter, readJsonChecked, readText, sha256, str, truncate, wordCount, type ScanContext } from './context.js';
import type { PluginInfo } from './plugins.js';

type Settings = {
  model?: string;
  effortLevel?: string;
  outputStyle?: string;
  env?: Record<string, unknown>;
  permissions?: { allow?: unknown[]; deny?: unknown[] };
  statusLine?: { command?: string };
  autoMode?: unknown;
};

async function settingsCard(ctx: ScanContext): Promise<Component> {
  const file = path.join(ctx.claudeDir, 'settings.json');
  const res = await readJsonChecked<Settings>(ctx, file);
  const local = await readJsonChecked<Settings>(ctx, path.join(ctx.claudeDir, 'settings.local.json'));
  const s = res?.ok ? res.value : {};
  const detail: Component['detail'] = {
    model: s.model ?? '',
    effortLevel: s.effortLevel ?? '',
    outputStyle: s.outputStyle ?? '',
    permissionsAllow: s.permissions?.allow?.length ?? 0,
    permissionsDeny: s.permissions?.deny?.length ?? 0,
    localPermissionsAllow: local?.ok ? (local.value.permissions?.allow?.length ?? 0) : 0,
    envKeys: Object.keys(s.env ?? {}),
    autoMode: s.autoMode !== undefined,
    statusLine: redact(s.statusLine?.command ?? ''),
  };
  if (res && !res.ok) detail.error = res.error;
  return {
    id: 'setting:user:settings.json',
    kind: 'setting',
    name: 'Settings',
    origin: { type: 'user' },
    phases: ['always'],
    sourcePath: file,
    enabled: true,
    summary: [detail.model, detail.effortLevel && `effort ${detail.effortLevel}`].filter(Boolean).join(' · ') || null,
    contextWords: 0,
    hash: sha256(JSON.stringify(detail)),
    detail,
  };
}

async function managedPolicy(ctx: ScanContext): Promise<Component[]> {
  const file = path.join(ctx.managedDir ?? '/etc/claude-code', 'managed-settings.json');
  if (!(await isFile(file))) return [];
  return [{
    id: 'setting:managed',
    kind: 'setting',
    name: 'Managed Policy',
    origin: { type: 'user' },
    phases: ['always'],
    sourcePath: file,
    enabled: true,
    summary: 'Unternehmens-Richtlinie, hat Vorrang vor allen eigenen Settings',
    contextWords: 0,
    hash: sha256(file),
    detail: {},
  }];
}

/** agents/, commands/, output-styles/ — markdown files with frontmatter. */
async function markdownItems(dir: string, kind: Kind, origin: Origin, activeStyle: string | null): Promise<Component[]> {
  const out: Component[] = [];
  const originKey = origin.type === 'plugin' ? `plugin:${origin.plugin}` : origin.type;
  for (const f of (await listDir(dir)).filter((f) => f.endsWith('.md'))) {
    const file = path.join(dir, f);
    const text = (await readText(file)) ?? '';
    const { data } = parseFrontmatter(text);
    const name = str(data.name) ?? f.replace(/\.md$/, '');
    const description = str(data.description);
    const active = kind !== 'output-style' || name === activeStyle;
    out.push({
      id: `${kind}:${originKey}:${name}`,
      kind,
      name,
      origin,
      phases: [kind === 'output-style' && active ? 'always' : 'on-demand'],
      sourcePath: file,
      enabled: active,
      summary: description ? truncate(description, 160) : null,
      contextWords: kind === 'agent' && description ? wordCount(description) : 0,
      hash: sha256(text),
      detail: str(data.model) ? { model: str(data.model)! } : {},
    });
  }
  return out;
}

/** Claude Code names a memory folder after the project path with "/" and "." as "-"; inside a project root the project name is enough. */
function memoryName(dir: string, ctx: ScanContext): string {
  const flat = (p: string) => p.replace(/[/.]/g, '-');
  if (dir === flat(ctx.homeDir)) return '~ (Home)';
  const root = (ctx.projectRoots ?? []).map((r) => `${flat(r)}-`).find((prefix) => dir.startsWith(prefix));
  return root ? dir.slice(root.length) : dir;
}

async function memory(ctx: ScanContext): Promise<Component[]> {
  const out: Component[] = [];
  for (const dir of await listDir(path.join(ctx.claudeDir, 'projects'))) {
    const memDir = path.join(ctx.claudeDir, 'projects', dir, 'memory');
    const files = (await listDir(memDir)).filter((f) => f.endsWith('.md'));
    if (!files.length) continue;
    const index = (await readText(path.join(memDir, 'MEMORY.md'))) ?? '';
    out.push({
      id: `memory:user:${dir}`,
      kind: 'memory',
      name: memoryName(dir, ctx),
      origin: { type: 'user' },
      phases: ['always'],
      sourcePath: memDir,
      enabled: true,
      summary: `${files.length} Notizen`,
      contextWords: wordCount(index),
      hash: sha256(index + files.join(',')),
      detail: { files: files.length, project: dir },
    });
  }
  return out;
}

export async function scanMisc(ctx: ScanContext, plugins: PluginInfo[]): Promise<Component[]> {
  const settings = await settingsCard(ctx);
  const activeStyle = str(settings.detail.outputStyle);
  const out = [settings, ...(await managedPolicy(ctx))];
  out.push(...(await markdownItems(path.join(ctx.claudeDir, 'agents'), 'agent', { type: 'user' }, null)));
  out.push(...(await markdownItems(path.join(ctx.claudeDir, 'commands'), 'command', { type: 'user' }, null)));
  out.push(...(await markdownItems(path.join(ctx.claudeDir, 'output-styles'), 'output-style', { type: 'user' }, activeStyle)));
  for (const p of plugins.filter((p) => p.enabled)) {
    const origin: Origin = { type: 'plugin', plugin: p.id };
    out.push(...(await markdownItems(path.join(p.root, 'agents'), 'agent', origin, null)));
    out.push(...(await markdownItems(path.join(p.root, 'commands'), 'command', origin, null)));
  }
  out.push(...(await memory(ctx)));
  return out;
}
