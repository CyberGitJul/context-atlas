import { cp, mkdtemp, readFile, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ScanContext } from '../../src/server/scan/context.js';

const FIXTURE_SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'home');

/** Copies the fixture home into a fresh temp dir, resolves __FIXTURE__ placeholders, adds a dangling skill symlink. */
export async function makeFixtureHome(): Promise<ScanContext> {
  const home = await mkdtemp(path.join(tmpdir(), 'atlas-home-'));
  await cp(FIXTURE_SRC, home, { recursive: true });
  const installed = path.join(home, '.claude', 'plugins', 'installed_plugins.json');
  await writeFile(installed, (await readFile(installed, 'utf8')).replaceAll('__FIXTURE__', home));
  await symlink(path.join(home, 'does-not-exist'), path.join(home, '.claude', 'skills', 'linked'));
  return { claudeDir: path.join(home, '.claude'), homeDir: home, managedDir: path.join(home, 'no-managed-policy'), personalDir: path.join(home, '.config', 'context-atlas') };
}
