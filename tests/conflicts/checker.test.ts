import { appendFile, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Component } from '../../src/shared/model.js';
import type { BackgroundTask, ExplainQueue } from '../../src/server/ai/queue.js';
import type { JsonRequest } from '../../src/server/ai/router-client.js';
import { createConflictChecker, pluginSkills, skillNameOf } from '../../src/server/conflicts/checker.js';
import type { RawFinding } from '../../src/server/conflicts/quotes.js';
import { createConflictStore } from '../../src/server/conflicts/store.js';
import { scanGlobal } from '../../src/server/scan/index.js';
import { makeFixtureHome } from '../helpers/fixture.js';

const PROMPTS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'config', 'prompts');

/** Rule A of the fixture CLAUDE.md against the description of the fixture's plugin skill. */
const FINDING: RawFinding = {
  type: 'tension',
  severity: 'medium',
  title: 'Demo tension',
  ownId: 'CLAUDE.md#Rule A',
  quoteOwn: 'Text one two three.',
  quoteSkill: 'Demo plugin skill.',
  situation: 's',
  whoWinsToday: 'The skill. It is loaded later.',
  precedence: 'none',
  precedenceQuote: null,
};

type Result = { summary: string; findings: RawFinding[] };

async function setup(opts: { result?: () => Result; ai?: boolean } = {}) {
  const ctx = await makeFixtureHome();
  const store = createConflictStore(path.join(await mkdtemp(path.join(tmpdir(), 'atlas-conflicts-')), 'conflicts.json'));
  await store.load();
  const tasks: BackgroundTask[] = [];
  const prompts: string[] = [];
  const queue: ExplainQueue = {
    enqueue() {},
    enqueueTask: (t) => void tasks.push(t),
    pause() {},
    resume() {},
    state: () => ({ pending: 0, running: false, failed: 0, failedHashes: [] }),
    runExclusive: (fn) => fn(),
  };
  const client = {
    json: async <T>(req: JsonRequest) => {
      prompts.push(req.prompt);
      return { result: (opts.result ?? (() => ({ summary: '', findings: [FINDING] })))() as T, model: 'opus' };
    },
  };
  let changes = 0;
  const checker = createConflictChecker({
    ctx,
    store,
    ai: opts.ai === false ? null : { queue, client, model: 'opus', prompts: { generic: PROMPTS_DIR } },
    onChange: () => void changes++,
    now: () => 'T1',
  });
  const components = async () => (await scanGlobal(ctx)).components;
  const runAll = async () => {
    while (tasks.length) {
      const t = tasks.shift()!;
      await t.run().catch(async (e: Error) => void (await t.fail?.(e)));
    }
  };
  return { ctx, store, tasks, prompts, checker, components, runAll, changes: () => changes };
}

const skillOf = (components: Component[]) => pluginSkills(components)[0];

describe('conflict checker', () => {
  it('schedules one check per active plugin skill and nothing more while texts are unchanged', async () => {
    const s = await setup();
    const components = await s.components();
    expect(pluginSkills(components).length).toBeGreaterThanOrEqual(1);
    await s.checker.schedule(components);
    expect(s.tasks).toHaveLength(pluginSkills(components).length);
    await s.runAll();
    await s.checker.schedule(await s.components());
    expect(s.tasks).toHaveLength(0);
  });

  it('a changed own rule makes every pair due again', async () => {
    const s = await setup();
    await s.checker.schedule(await s.components());
    await s.runAll();
    await appendFile(path.join(s.ctx.claudeDir, 'rules', 'style.md'), '- New.\n');
    await s.checker.schedule(await s.components());
    expect(s.tasks).toHaveLength(1);
  });

  it('sends masked texts with each own rule under its key in square brackets', async () => {
    const s = await setup();
    // Assembled at runtime: a literal in GitHub's PAT format would trip push protection and secret scanners.
    await writeFile(path.join(s.ctx.claudeDir, 'rules', 'secret.md'), `# Secret\n\ntoken=${['ghp', 'abcdefghijklmnopqrstuvwxyz0123456789'].join('_')}\n`);
    await s.checker.schedule(await s.components());
    await s.runAll();
    expect(s.prompts[0]).toContain('[CLAUDE.md#Rule A]');
    expect(s.prompts[0]).toContain('[rules/style.md]');
    expect(s.prompts[0]).toContain('Demo plugin skill.');
    expect(s.prompts[0]).not.toMatch(/ghp_abc/);
  });

  it('builds themes from a finished check', async () => {
    const s = await setup();
    await s.checker.schedule(await s.components());
    await s.runAll();
    const view = await s.checker.view(await s.components());
    expect(view.themes).toHaveLength(1);
    expect(view.themes[0]).toMatchObject({ ownKey: 'CLAUDE.md#Rule A', ownName: 'Rule A', ownId: 'instruction:user:CLAUDE.md#0', minor: false });
    expect(view.themes[0].findings[0]).toMatchObject({ state: 'new', title: 'Demo tension' });
    expect(view.deliberate).toEqual([]);
    expect(view.progress).toEqual({ total: 1, upToDate: 1, running: null, failed: [], lastCheck: 'T1' });
    expect(view.aiOff).toBe(false);
    expect(s.changes()).toBeGreaterThanOrEqual(2);
  });

  it('a removed own rule keeps its finding, named by its key, without a link', async () => {
    const s = await setup();
    await s.checker.schedule(await s.components());
    await s.runAll();
    const file = path.join(s.ctx.claudeDir, 'CLAUDE.md');
    await writeFile(file, (await readFile(file, 'utf8')).replace('## Rule A', '## Rule Z'));
    const view = await s.checker.view(await s.components());
    expect(view.themes[0]).toMatchObject({ ownKey: 'CLAUDE.md#Rule A', ownName: 'CLAUDE.md#Rule A', ownId: null });
  });

  it('hides findings of a plugin skill that is switched off', async () => {
    const s = await setup();
    await s.checker.schedule(await s.components());
    await s.runAll();
    const components = await s.components();
    const skill = skillOf(components);
    const off = await s.checker.view(components.map((c) => (c.id === skill.id ? { ...c, enabled: false } : c)));
    expect(off.themes).toEqual([]);
    expect(off.progress.total).toBe(0);
    expect((await s.checker.view(components)).themes).toHaveLength(1);
  });

  it('a failing check records the error, stays due and is reported', async () => {
    const s = await setup({
      result: () => {
        throw new Error('down');
      },
    });
    const components = await s.components();
    await s.checker.schedule(components);
    await s.runAll();
    const view = await s.checker.view(components);
    expect(view.progress.failed).toEqual([skillNameOf(skillOf(components))]);
    expect(view.progress.upToDate).toBe(0);
    expect(view.progress.running).toBeNull();
    await s.checker.schedule(components);
    expect(s.tasks).toHaveLength(1);
  });

  it('without AI it shows stored results and queues nothing', async () => {
    const s = await setup({ ai: false });
    await s.checker.schedule(await s.components());
    expect(s.tasks).toHaveLength(0);
    expect((await s.checker.view(await s.components())).aiOff).toBe(true);
  });
});
