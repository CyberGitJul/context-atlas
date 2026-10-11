import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { scanMcp } from '../../src/server/scan/mcp.js';
import { scanPlugins } from '../../src/server/scan/plugins.js';
import type { ScanContext } from '../../src/server/scan/context.js';
import { makeFixtureHome } from '../helpers/fixture.js';

let ctx: ScanContext;
beforeEach(async () => {
  ctx = await makeFixtureHome();
});

describe('scanPlugins', () => {
  it('lists user-scope plugins as global and project-scope ones separately', async () => {
    const res = await scanPlugins(ctx);
    expect(res.plugins).toEqual([{ id: 'demo@market', root: expect.stringMatching(/demo\/1\.0\.0$/), enabled: true }]);
    expect(res.projectScoped).toEqual(['proj@market']);
    expect(res.components.find((c) => c.name === 'demo@market')!.kind).toBe('plugin');
  });

  it('includes plugin hooks with their resolved script', async () => {
    const hook = (await scanPlugins(ctx)).hooks.find((h) => h.origin.type === 'plugin')!;
    expect(hook.phases).toEqual(['session-start']);
    expect(hook.sourcePath).toMatch(/start\.mjs$/);
  });
});

describe('scanMcp', () => {
  it('lists user MCP servers with env key names only', async () => {
    const mcp = await scanMcp(ctx, (await scanPlugins(ctx)).plugins);
    const fc = mcp.find((m) => m.name === 'fc')!;
    expect(fc.detail.envKeys).toEqual(['FIRECRAWL_API_KEY']);
    expect(fc.phases).toEqual(['always']);
    expect(JSON.stringify(mcp)).not.toContain('fc-secret-999');
  });

  it('includes plugin MCP servers from plugin.json', async () => {
    const mcp = await scanMcp(ctx, (await scanPlugins(ctx)).plugins);
    expect(mcp.find((m) => m.name === 'demo-mcp')!.origin).toEqual({ type: 'plugin', plugin: 'demo@market' });
    expect(JSON.stringify(mcp)).not.toContain('demo-secret-1');
  });

  it('adds the live-only sources from the personal list, none from the generic one', async () => {
    const liveOf = async (c: ScanContext) => (await scanMcp(c, [])).filter((m) => m.origin.type === 'live').map((m) => m.name);
    expect(await liveOf({ ...ctx, personalDir: undefined })).toEqual([]);
    expect(await liveOf({ ...ctx, personalDir: path.join(ctx.homeDir, 'nothing-here') })).toEqual([]);
    expect(await liveOf(ctx)).toEqual(['Claude in Chrome', 'IDE']);
  });
});
