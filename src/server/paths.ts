import { access, mkdir, rename } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

/** Folder name of the app below the XDG base folders. */
export const APP_DIR = 'context-atlas';
/** The app's former name; its folders are moved once on start. */
const LEGACY_DIR = 'local-claude-ecosystem';

type Env = Record<string, string | undefined>;

const bases = (env: Env, home: string) => ({
  config: env.XDG_CONFIG_HOME || path.join(home, '.config'),
  cache: env.XDG_CACHE_HOME || path.join(home, '.cache'),
  data: env.XDG_DATA_HOME || path.join(home, '.local', 'share'),
  state: env.XDG_STATE_HOME || path.join(home, '.local', 'state'),
});

/**
 * Where the app keeps its own files: config (own prompts, chat-files.json, live-sources.json), cache (explanations,
 * backups), data (the git history of ~/.claude) and state (chat logs).
 */
export function appDirs(env: Env = process.env, home: string = homedir()): Record<'config' | 'cache' | 'data' | 'state', string> {
  const b = bases(env, home);
  return { config: path.join(b.config, APP_DIR), cache: path.join(b.cache, APP_DIR), data: path.join(b.data, APP_DIR), state: path.join(b.state, APP_DIR) };
}

const exists = (p: string) => access(p).then(() => true, () => false);

/** Moves each folder of the former name to the new one, unless the new one exists already. Returns the new folders. */
export async function migrateLegacyDirs(env: Env = process.env, home: string = homedir()): Promise<string[]> {
  const moved: string[] = [];
  for (const base of Object.values(bases(env, home))) {
    const from = path.join(base, LEGACY_DIR);
    const to = path.join(base, APP_DIR);
    if (!(await exists(from)) || (await exists(to))) continue;
    await mkdir(base, { recursive: true });
    await rename(from, to);
    moved.push(to);
  }
  return moved;
}
