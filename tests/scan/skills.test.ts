import { beforeEach, describe, expect, it } from 'vitest';
import type { Component } from '../../src/shared/model.js';
import { scanPlugins } from '../../src/server/scan/plugins.js';
import { scanSkills } from '../../src/server/scan/skills.js';
import type { ScanContext } from '../../src/server/scan/context.js';
import { makeFixtureHome } from '../helpers/fixture.js';

let ctx: ScanContext;
let skills: Component[];
beforeEach(async () => {
  ctx = await makeFixtureHome();
  skills = await scanSkills(ctx, (await scanPlugins(ctx)).plugins);
});
const byName = (n: string) => skills.find((s) => s.name === n)!;

describe('scanSkills', () => {
  it('reads name and description; the description counts as context words', () => {
    const s = byName('good-skill');
    expect(s.enabled).toBe(true);
    expect(s.summary).toBe('Use when testing.');
    expect(s.phases).toEqual(['on-demand']);
    expect(s.contextWords).toBe(3);
  });

  it('marks skills switched off via skillOverrides', () => {
    expect(byName('old-skill').enabled).toBe(false);
  });

  it('keeps skills without description, with summary null', () => {
    expect(byName('no-desc').summary).toBeNull();
  });

  it('reports a dangling symlink instead of crashing', () => {
    expect(byName('linked').detail.dangling).toBe(true);
  });

  it('marks skills synced from claude.ai as externally managed', () => {
    expect(byName('synced-one').detail.managedBy).toBe('claude.ai');
  });

  it('reads synced skills inside their bucket folder and ignores bucket markers', () => {
    const names = skills.map((s) => s.name);
    expect(names).not.toContain('bucket-1');
    expect(names.some((n) => n.startsWith('.'))).toBe(false);
  });

  it('reads descriptions that are not strict YAML (colons, quotes) like Claude Code does', () => {
    expect(byName('colon-skill').summary).toBe('Use for research where facts matter: prices, "was kostet X", versions: all of it.');
  });

  it('only treats folders with a SKILL.md as skills', () => {
    expect(skills.map((s) => s.name)).not.toContain('.ignore');
  });

  it('includes skills contributed by enabled plugins', () => {
    expect(byName('demo-skill').origin).toEqual({ type: 'plugin', plugin: 'demo@market' });
  });
});
