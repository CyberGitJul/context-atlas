import { beforeEach, describe, expect, it } from 'vitest';
import { scanInstructions } from '../../src/server/scan/instructions.js';
import type { ScanContext } from '../../src/server/scan/context.js';
import { makeFixtureHome } from '../helpers/fixture.js';

let ctx: ScanContext;
beforeEach(async () => {
  ctx = await makeFixtureHome();
});

describe('scanInstructions', () => {
  it('splits CLAUDE.md into one always-on component per ## section', async () => {
    const sections = (await scanInstructions(ctx)).filter((c) => c.kind === 'instruction');
    expect(sections.map((s) => s.name)).toEqual(['Rule A', 'Rule B']);
    for (const s of sections) {
      expect(s.phases).toEqual(['always']);
      expect(s.contextWords).toBeGreaterThan(0);
      expect(s.sourcePath).toMatch(/CLAUDE\.md$/);
    }
  });

  it('lists rules; a rule with paths frontmatter only loads on demand', async () => {
    const rules = (await scanInstructions(ctx)).filter((c) => c.kind === 'rule');
    expect(rules.find((r) => r.name === 'style.md')!.phases).toEqual(['always']);
    const scoped = rules.find((r) => r.name === 'scoped.md')!;
    expect(scoped.phases).toEqual(['on-demand']);
    expect(scoped.detail.paths).toEqual(['src/**/*.ts']);
  });
});
