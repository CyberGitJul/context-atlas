import path from 'node:path';
import type { Component } from '../../shared/model.js';
import { listDir, readText, type ScanContext, type ScanProblem } from './context.js';
import { scanUserHooks, type ScannedHook } from './hooks.js';
import { parseImports, scanInstructions } from './instructions.js';
import { scanMcp } from './mcp.js';
import { scanMisc } from './misc.js';
import { scanPlugins } from './plugins.js';
import { scanSkills } from './skills.js';
import { msg } from '../messages/index.js';

export interface GlobalScan {
  components: Component[];
  /** Server-only data per component id (AI input for hooks). */
  internal: Map<string, ScannedHook>;
  projectScopedPlugins: string[];
  /** Markdown files in ~/.claude that nothing imports (present, but not loaded). */
  latentFiles: string[];
  /** Sources that could not be read or scanned; their content is missing from the overview. */
  problems: ScanProblem[];
}

function publicPart({ explainInput: _omit, ...component }: ScannedHook): Component {
  return component;
}

async function latentFiles(ctx: ScanContext): Promise<string[]> {
  const imported = new Set(parseImports((await readText(path.join(ctx.claudeDir, 'CLAUDE.md'))) ?? '').map((p) => path.basename(p)));
  return (await listDir(ctx.claudeDir)).filter((f) => f.endsWith('.md') && f !== 'CLAUDE.md' && !imported.has(f));
}

export async function scanGlobal(baseCtx: ScanContext): Promise<GlobalScan> {
  const problems = new Map<string, ScanProblem>();
  const tilde = (file: string) => (file.startsWith(baseCtx.homeDir + '/') ? '~' + file.slice(baseCtx.homeDir.length) : file);
  const ctx: ScanContext = { ...baseCtx, report: (p) => problems.set(`${p.file}\0${p.error}`, { file: tilde(p.file), error: p.error }) };
  /** One failing scanner must not take down the page: its part is reported and left out. */
  const m = msg.edit.scan;
  const safe = async <T>(label: string, fallback: T, run: () => Promise<T>): Promise<T> => {
    try {
      return await run();
    } catch (e) {
      problems.set(label, { file: label, error: m.aborted((e as Error)?.name ?? 'Error') });
      return fallback;
    }
  };

  const plugins = await safe('Plugins', { components: [], plugins: [], projectScoped: [], hooks: [] }, () => scanPlugins(ctx));
  const hooks = [...(await safe('Hooks', [], () => scanUserHooks(ctx))), ...plugins.hooks];
  const components = [
    ...(await safe(m.parts.instructions, [], () => scanInstructions(ctx))),
    ...(await safe(m.parts.misc, [], () => scanMisc(ctx, plugins.plugins))),
    ...(await safe(m.parts.mcp, [], () => scanMcp(ctx, plugins.plugins))),
    ...hooks.map(publicPart),
    ...(await safe('Skills', [], () => scanSkills(ctx, plugins.plugins))),
    ...plugins.components,
  ];
  return {
    components,
    internal: new Map(hooks.map((h) => [h.id, h])),
    projectScopedPlugins: plugins.projectScoped,
    latentFiles: await safe(m.parts.latent, [], () => latentFiles(ctx)),
    problems: [...problems.values()],
  };
}
