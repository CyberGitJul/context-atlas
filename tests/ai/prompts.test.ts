import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { personalAddition, readPrompt, withAddition, type PromptDirs } from '../../src/server/ai/prompts.js';

let dirs: PromptDirs;
const put = async (file: string, text: string) => {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text);
};
beforeEach(async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'atlas-prompts-'));
  dirs = { generic: path.join(root, 'generic'), personal: path.join(root, 'personal') };
  await put(path.join(dirs.generic, 'chat', 'skill.md'), 'Default');
  await put(path.join(dirs.generic, 'shorten.md'), 'Shorten, default');
});

describe('prompt layers', () => {
  it('uses the generic prompt unless an own version exists', async () => {
    expect(await readPrompt(dirs, 'chat/skill.md')).toEqual({ text: 'Default', source: 'generic' });
    await put(path.join(dirs.personal!, 'prompts', 'chat', 'skill.md'), 'Mine');
    expect(await readPrompt(dirs, 'chat/skill.md')).toEqual({ text: 'Mine', source: 'personal' });
    expect(await readPrompt(dirs, 'shorten.md')).toEqual({ text: 'Shorten, default', source: 'generic' });
    expect(await readPrompt({ generic: dirs.generic, personal: null }, 'chat/skill.md')).toEqual({ text: 'Default', source: 'generic' });
  });

  it('fails clearly when a prompt is missing in both layers', async () => {
    await expect(readPrompt(dirs, 'chat/does-not-exist.md')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('appends the personal addition only when it has text', async () => {
    expect(await personalAddition(dirs)).toEqual({ text: '', source: 'generic' });
    expect(withAddition('System', '')).not.toContain('# Personal');
    await put(path.join(dirs.personal!, 'prompts', '_personal.md'), '\nThe user is called Alex.\n');
    const own = await personalAddition(dirs);
    expect(own).toEqual({ text: 'The user is called Alex.', source: 'personal' });
    expect(withAddition('System\n', own.text)).toMatch(/^System\n\n# Personal\n\nThe user is called Alex\.\n\n# Language\n\nWrite explanations.* in English\./);
  });
});
