import { realpath } from 'node:fs/promises';
import path from 'node:path';
import type { Component, ComponentText } from '../../shared/model.js';
import { msg } from '../messages/index.js';
import { redact } from '../redact.js';
import { listDir, readText, realProjectRoots, type ScanContext } from '../scan/context.js';
import { sectionBounds } from './sections.js';

/** Where an edit of a component goes. Only components the scan found can be resolved; there is no free path input. */
export interface EditTarget {
  file: string;
  realFile: string;
  section?: { index: number; heading: string };
  inRepo: boolean;
}

const FILE_KINDS = new Set(['rule', 'agent', 'command', 'output-style', 'skill']);

function within(file: string, dir: string): boolean {
  return file.startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep);
}

/** Read-only reason, or null if this kind of component can be edited at all. */
function readOnlyReason(c: Component): string | null {
  const m = msg.edit.resolve;
  if (c.origin.type === 'plugin') return m.plugin(c.origin.plugin);
  if (c.origin.type === 'live') return m.live;
  if (c.detail.dangling === true) return m.dangling;
  if (c.detail.managedBy === 'claude.ai') return m.claudeAi;
  if (c.detail.managedBy === 'installer') return m.installer;
  if (c.detail.managedBy === 'external') return m.external;
  if (c.kind === 'hook' && c.detail.hasScript !== true) return m.hookCommand;
  if (c.kind === 'memory') return m.memory;
  if (c.kind === 'instruction' || c.kind === 'hook' || FILE_KINDS.has(c.kind)) return null;
  return m.laterSlice;
}

export async function resolveEditable(c: Component, ctx: ScanContext): Promise<EditTarget | { readOnly: string }> {
  const m = msg.edit.resolve;
  const reason = readOnlyReason(c);
  if (reason) return { readOnly: reason };
  if (!c.sourcePath) return { readOnly: m.noFile };
  const realFile = await realpath(c.sourcePath).catch(() => null);
  if (!realFile) return { readOnly: m.fileGone };
  const claudeDir = await realpath(ctx.claudeDir).catch(() => ctx.claudeDir);
  const projectRoots = await realProjectRoots(ctx);
  const inRepo = within(realFile, claudeDir);
  if (inRepo && (within(realFile, path.join(claudeDir, 'plugins')) || within(realFile, path.join(claudeDir, 'projects')))) {
    return { readOnly: m.managedArea };
  }
  if (!inRepo && !(c.kind === 'skill' && projectRoots.some((r) => within(realFile, r)))) return { readOnly: m.outside };
  if (c.kind === 'hook' && !within(realFile, path.join(claudeDir, 'hooks'))) return { readOnly: m.hookOutside };
  const target: EditTarget = { file: c.sourcePath, realFile, inRepo };
  if (c.kind === 'instruction') target.section = { index: Number(c.detail.index), heading: c.name };
  return target;
}

/** Section text or whole file; null if a section heading no longer matches (file changed since the scan). */
export async function readTargetText(target: EditTarget): Promise<string | null> {
  const text = await readText(target.realFile);
  if (text === null) return null;
  if (!target.section) return text;
  const b = sectionBounds(text, target.section.index, target.section.heading);
  return b ? text.slice(b.start, b.end) : null;
}

/** A memory folder as one text: the index first, then every note under a `==> file <==` line (as `head` prints several files). */
async function memoryText(dir: string): Promise<string> {
  const files = (await listDir(dir)).filter((f) => f.endsWith('.md'));
  files.sort((a, b) => (a === 'MEMORY.md' ? -1 : b === 'MEMORY.md' ? 1 : a.localeCompare(b)));
  const parts = await Promise.all(files.map(async (f) => `==> ${f} <==\n${((await readText(path.join(dir, f))) ?? '').trimEnd()}\n`));
  return parts.join('\n');
}

async function readOnlyText(c: Component): Promise<string> {
  if (!c.sourcePath || c.origin.type === 'live') return '';
  if (c.kind === 'memory') return memoryText(c.sourcePath);
  return (await readText(c.sourcePath)) ?? '';
}

export async function loadComponentText(c: Component, ctx: ScanContext): Promise<ComponentText> {
  const target = await resolveEditable(c, ctx);
  if ('readOnly' in target) {
    const raw = await readOnlyText(c);
    const masked = redact(raw);
    return { component: c, text: masked, editable: false, readOnlyReason: target.readOnly, file: c.sourcePath, hasSecrets: masked !== raw, inRepo: false };
  }
  const raw = await readTargetText(target);
  if (raw === null) {
    return { component: c, text: '', editable: false, readOnlyReason: msg.edit.resolve.changedSinceLoad, file: target.realFile, hasSecrets: false, inRepo: target.inRepo };
  }
  const masked = redact(raw);
  if (masked !== raw) {
    // Never show secret values; editing a masked text would write *** over the secret.
    return { component: c, text: masked, editable: false, readOnlyReason: msg.edit.resolve.secrets, file: target.realFile, hasSecrets: true, inRepo: target.inRepo };
  }
  return { component: c, text: raw, editable: true, readOnlyReason: null, file: target.realFile, hasSecrets: false, inRepo: target.inRepo };
}
