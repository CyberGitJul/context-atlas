import { beforeEach, describe, expect, it } from 'vitest';
import { scanGlobal } from '../../src/server/scan/index.js';
import type { ScanContext } from '../../src/server/scan/context.js';
import { makeFixtureHome } from '../helpers/fixture.js';

let ctx: ScanContext;
beforeEach(async () => {
  ctx = await makeFixtureHome();
});

describe('scanGlobal', () => {
  it('never exposes secret values or account data', async () => {
    const out = JSON.stringify({ ...(await scanGlobal(ctx)), internal: undefined });
    for (const secret of ['do-not-leak-123', 'fc-secret-999', 'sk-abcdefghijklmnop123', 'demo-secret-1', 'x@y']) {
      expect(out).not.toContain(secret);
    }
  });

  it('combines all sources and reports extras', async () => {
    const scan = await scanGlobal(ctx);
    const kinds = new Set(scan.components.map((c) => c.kind));
    for (const k of ['instruction', 'rule', 'skill', 'hook', 'mcp', 'plugin', 'agent', 'setting', 'memory']) {
      expect(kinds).toContain(k);
    }
    expect(scan.projectScopedPlugins).toEqual(['proj@market']);
    expect(scan.latentFiles).toEqual(['HANDOFF.md']);
    expect(new Set(scan.components.map((c) => c.id)).size).toBe(scan.components.length);
  });

  it('shows the settings card with env key names but no values', async () => {
    const settings = (await scanGlobal(ctx)).components.find((c) => c.kind === 'setting')!;
    expect(settings.detail.model).toBe('opus');
    expect(settings.detail.envKeys).toEqual(['SECRET_TOKEN']);
  });

  it('adds one memory card per project memory folder', async () => {
    const memory = (await scanGlobal(ctx)).components.filter((c) => c.kind === 'memory');
    expect(memory).toHaveLength(1);
    expect(memory[0].detail.files).toBe(2);
  });
});
