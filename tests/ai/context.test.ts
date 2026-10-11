import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Component } from '../../src/shared/model.js';
import { buildContext } from '../../src/server/ai/context.js';
import { estimateActions } from '../../src/server/ai/actions.js';
import { loadComponentText } from '../../src/server/edit/resolve.js';
import type { ScanContext } from '../../src/server/scan/context.js';
import { scanGlobal } from '../../src/server/scan/index.js';
import { makeFixtureHome } from '../helpers/fixture.js';

let ctx: ScanContext;
let components: Component[];
const read = (c: Component) => loadComponentText(c, ctx).then((t) => t.text);
const ruleA = () => components.find((c) => c.name === 'Rule A')!;

beforeEach(async () => {
  ctx = await makeFixtureHome();
  components = (await scanGlobal(ctx)).components;
});

describe('buildContext', () => {
  it('lists the other active sources but not the component itself', async () => {
    const text = await buildContext(components, {}, ruleA().id, read);
    expect(text).toContain('Rule B');
    expect(text).toContain('Four five.');
    expect(text).toContain('good-skill');
    expect(text).not.toContain('Text one two three');
  });

  it('includes what hooks inject according to their explanation', async () => {
    const hook = components.find((c) => c.kind === 'hook')!;
    const text = await buildContext(components, { [hook.hash]: { hash: hook.hash, title: 'T', summary: 'S', injects: 'Progress from PROGRESS.md', at: 'x' } }, ruleA().id, read);
    expect(text).toContain('Progress from PROGRESS.md');
  });

  it('never contains secret values of other sources', async () => {
    await writeFile(path.join(ctx.claudeDir, 'rules', 'secret.md'), '# Secret\n\ntoken: 0123456789abcdef0123456789abcdef\n');
    components = (await scanGlobal(ctx)).components;
    expect(await buildContext(components, {}, ruleA().id, read)).not.toContain('0123456789abcdef0123456789abcdef');
  });

  it('cuts long sources and keeps the total budget', async () => {
    await writeFile(path.join(ctx.claudeDir, 'rules', 'long.md'), `# Long\n\n${'wort '.repeat(3000)}\n`);
    components = (await scanGlobal(ctx)).components;
    const text = await buildContext(components, {}, ruleA().id, read, { perSource: 500, total: 1200 });
    expect(text.length).toBeLessThanOrEqual(1200 + 200);
    expect(text).toContain('left out');
  });

  it('counts the context in the estimate of context actions', async () => {
    const cfg = { model: 'opus', promptsDir: path.join(process.cwd(), 'config', 'prompts') };
    const context = await buildContext(components, {}, ruleA().id, read);
    const est = await estimateActions(ruleA(), '## Rule A\n', cfg, context);
    const by = (id: string) => est.find((e) => e.id === id)!;
    expect(by('contradictions').available).toBe(true);
    expect(by('contradictions').inputWords).toBeGreaterThan(by('classify').inputWords);
  });
});
