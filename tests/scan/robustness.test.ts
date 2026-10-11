import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { computeHints } from '../../src/server/hints.js';
import { readJson, type ScanContext } from '../../src/server/scan/context.js';
import { scanGlobal } from '../../src/server/scan/index.js';
import { makeFixtureHome } from '../helpers/fixture.js';

let ctx: ScanContext;
beforeEach(async () => {
  ctx = await makeFixtureHome();
});

describe('robust scanning', () => {
  it('reports JSON errors by position only, never with file content', async () => {
    const file = path.join(ctx.claudeDir, 'settings.json');
    await writeFile(file, '{"env":{"MY_PW": hunter2secret}}');
    const res = await readJson(file);
    expect(res && !res.ok && res.error).toMatch(/line \d+, column \d+/);
    expect(JSON.stringify(res)).not.toContain('hunter2');
  });

  it('keeps the page alive when one MCP entry is null', async () => {
    await writeFile(path.join(ctx.homeDir, '.claude.json'), '{"mcpServers":{"a":null,"b":{"command":"npx","args":["srv"]}}}');
    const scan = await scanGlobal(ctx);
    expect(scan.components.some((c) => c.kind === 'hook')).toBe(true);
    expect(scan.components.some((c) => c.name === 'b')).toBe(true);
  });

  it('turns an unreadable settings.json into a warning without leaking its content', async () => {
    await writeFile(path.join(ctx.claudeDir, 'settings.json'), '{"env":{"MY_PW": hunter2secret}}');
    const scan = await scanGlobal(ctx);
    const hints = computeHints(scan.components, { projectScopedPlugins: scan.projectScopedPlugins, latentFiles: scan.latentFiles, problems: scan.problems });
    const hint = hints.find((h) => h.id === 'source-unreadable')!;
    expect(hint.severity).toBe('warn');
    expect(hint.text).toContain('settings.json');
    expect(JSON.stringify({ scan: { ...scan, internal: undefined }, hints })).not.toContain('hunter2');
  });
});
