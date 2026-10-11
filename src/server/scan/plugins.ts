import path from 'node:path';
import type { Component } from '../../shared/model.js';
import { isObject, readJsonChecked, sha256, type ScanContext } from './context.js';
import { scanHookFile, type ScannedHook } from './hooks.js';

export interface PluginInfo {
  id: string;
  root: string;
  enabled: boolean;
}

type Install = { scope?: string; installPath?: string; version?: string };

export interface PluginScan {
  components: Component[];
  plugins: PluginInfo[];
  /** Plugins installed only for single projects (not part of the global view). */
  projectScoped: string[];
  hooks: ScannedHook[];
}

export async function scanPlugins(ctx: ScanContext): Promise<PluginScan> {
  const installed = await readJsonChecked<{ plugins?: Record<string, Install[] | Install> }>(ctx, path.join(ctx.claudeDir, 'plugins', 'installed_plugins.json'));
  const settings = await readJsonChecked<{ enabledPlugins?: Record<string, boolean> }>(ctx, path.join(ctx.claudeDir, 'settings.json'));
  const enabledMap = settings?.ok && isObject(settings.value.enabledPlugins) ? settings.value.enabledPlugins : {};
  const result: PluginScan = { components: [], plugins: [], projectScoped: [], hooks: [] };
  if (!installed?.ok) return result;

  for (const [id, raw] of Object.entries(installed.value.plugins ?? {})) {
    const installs = (Array.isArray(raw) ? raw : [raw]).filter(isObject) as Install[];
    const user = installs.find((i) => i.scope === 'user');
    if (!user?.installPath) {
      result.projectScoped.push(id);
      continue;
    }
    const plugin: PluginInfo = { id, root: user.installPath, enabled: enabledMap[id] !== false };
    result.plugins.push(plugin);
    result.components.push({
      id: `plugin:${id}`,
      kind: 'plugin',
      name: id,
      origin: { type: 'plugin', plugin: id },
      phases: [],
      sourcePath: plugin.root,
      enabled: plugin.enabled,
      summary: user.version ? `Version ${user.version}` : null,
      contextWords: 0,
      hash: sha256(`${id}@${user.version ?? ''}`),
      detail: { version: user.version ?? '', scope: 'user' },
    });
    if (!plugin.enabled) continue;
    const hooksFile = path.join(plugin.root, 'hooks', 'hooks.json');
    const hooks = await readJsonChecked(ctx, hooksFile);
    if (hooks?.ok) result.hooks.push(...(await scanHookFile(hooks.value, { type: 'plugin', plugin: id }, plugin.root, ctx, hooksFile)));
  }
  return result;
}
