import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { appDirs } from '../paths.js';

/**
 * Prompts come in two layers: the generic ones shipped with the app (config/prompts) and the user's own versions
 * in the personal config dir (prompts/ with the same relative paths). An own version replaces the generic file.
 * `_personal.md` is empty in the generic layer and appended to every system prompt, so personal details can be
 * added without replacing (and freezing) the other prompts.
 */
export interface PromptDirs {
  generic: string;
  /** Root of the personal config (prompts/, chat-files.json); null keeps everything generic. */
  personal?: string | null;
}

export type PromptSource = 'personal' | 'generic';

/** Relative path of the personal addition, appended to every system prompt. */
export const PERSONAL_ADDITION = '_personal.md';

/** ~/.config/context-atlas (or $XDG_CONFIG_HOME): own prompts and settings, outside the repo. */
export function defaultPersonalDir(): string {
  return appDirs().config;
}

export const personalPromptPath = (dirs: PromptDirs, rel: string) => (dirs.personal ? path.join(dirs.personal, 'prompts', rel) : null);
export const genericPromptPath = (dirs: PromptDirs, rel: string) => path.join(dirs.generic, rel);

/** The prompt that applies: the own version if there is one, else the generic one (which must exist). */
export async function readPrompt(dirs: PromptDirs, rel: string): Promise<{ text: string; source: PromptSource }> {
  const own = personalPromptPath(dirs, rel);
  if (own) {
    const text = await readFile(own, 'utf8').catch((e: NodeJS.ErrnoException) => {
      if (e.code === 'ENOENT') return null;
      throw e;
    });
    if (text !== null) return { text, source: 'personal' };
  }
  return { text: await readFile(genericPromptPath(dirs, rel), 'utf8'), source: 'generic' };
}

/** The personal addition, trimmed; empty when neither layer has one. */
export async function personalAddition(dirs: PromptDirs): Promise<{ text: string; source: PromptSource }> {
  return readPrompt(dirs, PERSONAL_ADDITION).then(
    (p) => ({ text: p.text.trim(), source: p.source }),
    () => ({ text: '', source: 'generic' as const }),
  );
}

/** The language section every system prompt ends with: the app is English, the user’s own files may be any language. */
const LANGUAGE_SECTION =
  'Write explanations, notes, findings and every other text shown in the app in English. ' +
  'In the chat, answer in the language the user writes in. ' +
  'Text you write into the user’s own files (proposed sections, rewritten text, new skills or rules) keeps the language of that file or of the user’s request.';

/**
 * A system prompt with the personal addition after it, when there is one, and the language section at the end.
 */
export function withAddition(system: string, addition: string): string {
  const parts = [system.trim()];
  if (addition) parts.push('# Personal', addition);
  parts.push('# Language', LANGUAGE_SECTION);
  return parts.join('\n\n');
}
