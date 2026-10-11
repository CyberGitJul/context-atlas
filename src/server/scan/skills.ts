import { lstat, readlink, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { Component, Origin } from '../../shared/model.js';
import { isFile, isObject, listDir, parseFrontmatter, readJsonChecked, readText, realProjectRoots, sha256, str, wordCount, type ScanContext } from './context.js';
import type { PluginInfo } from './plugins.js';
import { LEGACY_SOURCE_KEY, SOURCE_KEY } from '../../shared/skill-links.js';

type Overrides = Record<string, string>;

/** Who looks after a linked skill: a project (first folder below a project root), an installer, or someone else. */
function managedBy(target: string, roots: string[], ctx: ScanContext): string {
  for (const root of roots) {
    const prefix = root.endsWith(path.sep) ? root : root + path.sep;
    if (target.startsWith(prefix)) return `project:${target.slice(prefix.length).split(path.sep)[0]}`;
  }
  if (target.startsWith(path.join(ctx.homeDir, '.agents') + path.sep)) return 'installer';
  return 'external';
}

async function readSkill(dir: string, fallbackName: string, origin: Origin, overrides: Overrides, detail: Component['detail']): Promise<Component> {
  const file = path.join(dir, 'SKILL.md');
  const text = (await readText(file)) ?? '';
  const { data } = parseFrontmatter(text);
  const name = str(data.name) ?? fallbackName;
  const description = str(data.description);
  const enabled = overrides[name] !== 'off' && overrides[fallbackName] !== 'off';
  // Back-reference written by this app when it created the skill from a section.
  const source = isObject(data.metadata) ? (str(data.metadata[SOURCE_KEY]) ?? str(data.metadata[LEGACY_SOURCE_KEY])) : null;
  const originKey = origin.type === 'plugin' ? `plugin:${origin.plugin}` : origin.type;
  return {
    id: `skill:${originKey}:${path.basename(dir)}:${name}`,
    kind: 'skill',
    name,
    origin,
    phases: ['on-demand'],
    sourcePath: file,
    enabled,
    summary: description,
    contextWords: enabled && description ? wordCount(description) : 0,
    hash: sha256(text),
    detail: source ? { ...detail, source } : detail,
  };
}

async function userSkills(ctx: ScanContext, overrides: Overrides): Promise<Component[]> {
  const root = path.join(ctx.claudeDir, 'skills');
  const projectRoots = await realProjectRoots(ctx);
  const out: Component[] = [];
  for (const entry of (await listDir(root)).filter((e) => !e.startsWith('.'))) {
    const p = path.join(root, entry);
    if (entry === 'synced') {
      // Layout: synced/<bucket-id>/<skill>/SKILL.md; dotfiles are bucket markers.
      for (const bucket of (await listDir(p)).filter((e) => !e.startsWith('.'))) {
        for (const sub of await listDir(path.join(p, bucket))) {
          const dir = path.join(p, bucket, sub);
          if (await isFile(path.join(dir, 'SKILL.md'))) out.push(await readSkill(dir, sub, { type: 'user' }, overrides, { managedBy: 'claude.ai' }));
        }
      }
      continue;
    }
    const isLink = (await lstat(p).catch(() => null))?.isSymbolicLink() ?? false;
    if (!isLink) {
      if (await isFile(path.join(p, 'SKILL.md'))) out.push(await readSkill(p, entry, { type: 'user' }, overrides, {}));
      continue;
    }
    const target = await realpath(p).catch(() => null);
    if (target === null) {
      out.push({
        id: `skill:user:${entry}:${entry}`,
        kind: 'skill',
        name: entry,
        origin: { type: 'user' },
        phases: ['on-demand'],
        sourcePath: p,
        enabled: false,
        summary: null,
        contextWords: 0,
        hash: sha256(`dangling:${entry}`),
        detail: { dangling: true, linkTarget: await readlink(p).catch(() => '') },
      });
      continue;
    }
    out.push(await readSkill(p, entry, { type: 'user' }, overrides, { linkTarget: target, managedBy: managedBy(target, projectRoots, ctx) }));
  }
  return out;
}

export async function scanSkills(ctx: ScanContext, plugins: PluginInfo[]): Promise<Component[]> {
  const settings = await readJsonChecked<{ skillOverrides?: Overrides }>(ctx, path.join(ctx.claudeDir, 'settings.json'));
  const overrides = settings?.ok ? (settings.value.skillOverrides ?? {}) : {};
  const out = await userSkills(ctx, overrides);
  for (const plugin of plugins.filter((p) => p.enabled)) {
    const root = path.join(plugin.root, 'skills');
    for (const entry of (await listDir(root)).filter((e) => !e.startsWith('.'))) {
      if (await isFile(path.join(root, entry, 'SKILL.md'))) {
        out.push(await readSkill(path.join(root, entry), entry, { type: 'plugin', plugin: plugin.id }, overrides, {}));
      }
    }
  }
  return out;
}
