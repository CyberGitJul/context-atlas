import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { appDirs, migrateLegacyDirs } from '../src/server/paths.js';

async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), 'atlas-paths-'));
  const env = { XDG_CONFIG_HOME: path.join(root, 'config'), XDG_CACHE_HOME: path.join(root, 'cache'), XDG_DATA_HOME: path.join(root, 'data'), XDG_STATE_HOME: path.join(root, 'state') };
  return { root, env };
}

describe('app folders', () => {
  it('follow the XDG variables, or the usual folders below home', () => {
    expect(appDirs({}, '/home/x')).toEqual({
      config: '/home/x/.config/context-atlas',
      cache: '/home/x/.cache/context-atlas',
      data: '/home/x/.local/share/context-atlas',
      state: '/home/x/.local/state/context-atlas',
    });
    expect(appDirs({ XDG_CONFIG_HOME: '/cfg' }, '/home/x').config).toBe('/cfg/context-atlas');
  });

  it('moves folders of the former name once, and never over existing new ones', async () => {
    const { env } = await setup();
    await mkdir(path.join(env.XDG_CONFIG_HOME, 'local-claude-ecosystem', 'prompts'), { recursive: true });
    await writeFile(path.join(env.XDG_CONFIG_HOME, 'local-claude-ecosystem', 'prompts', '_personal.md'), 'me');
    await mkdir(path.join(env.XDG_CACHE_HOME, 'local-claude-ecosystem'), { recursive: true });
    await mkdir(path.join(env.XDG_CACHE_HOME, 'context-atlas'), { recursive: true });
    const moved = await migrateLegacyDirs(env, '/nowhere');
    expect(moved).toEqual([path.join(env.XDG_CONFIG_HOME, 'context-atlas')]);
    expect(await readFile(path.join(env.XDG_CONFIG_HOME, 'context-atlas', 'prompts', '_personal.md'), 'utf8')).toBe('me');
    expect(await migrateLegacyDirs(env, '/nowhere')).toEqual([]);
  });
});
