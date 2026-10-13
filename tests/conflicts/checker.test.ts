import { appendFile, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Component } from '../../src/shared/model.js';
import { createExplanationCache } from '../../src/server/ai/cache.js';
import { createExplainQueue, type BackgroundTask, type ExplainQueue } from '../../src/server/ai/queue.js';
import type { JsonRequest } from '../../src/server/ai/router-client.js';
import { createConflictChecker, pluginSkills, skillNameOf, type ConflictChecker } from '../../src/server/conflicts/checker.js';
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
  const signals: (AbortSignal | undefined)[] = [];
  const client = {
    json: async <T>(req: JsonRequest) => {
      prompts.push(req.prompt);
      signals.push(req.signal);
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
      await t.run(new AbortController().signal).catch(async (e: Error) => void (await t.fail?.(e)));
    }
  };
  return { ctx, store, tasks, prompts, signals, checker, components, runAll, changes: () => changes };
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

  it("passes the queue's abort signal to the AI request", async () => {
    const s = await setup();
    await s.checker.schedule(await s.components());
    const signal = new AbortController().signal;
    await s.tasks.shift()!.run(signal);
    expect(s.signals[0]).toBe(signal);
  });

  it('without AI it shows stored results and queues nothing', async () => {
    const s = await setup({ ai: false });
    await s.checker.schedule(await s.components());
    expect(s.tasks).toHaveLength(0);
    expect((await s.checker.view(await s.components())).aiOff).toBe(true);
  });
});

describe('conflict checker on the real queue', () => {
  it('runs a due check once even when every change reschedules, as the open page does', async () => {
    const ctx = await makeFixtureHome();
    const dir = await mkdtemp(path.join(tmpdir(), 'atlas-conflicts-'));
    const store = createConflictStore(path.join(dir, 'conflicts.json'));
    await store.load();
    const cache = createExplanationCache(path.join(dir, 'e.json'));
    await cache.load();
    const queue = createExplainQueue({ client: { explain: async () => Promise.reject(new Error('unused')) }, cache, onEvent: () => {}, sleep: async () => {} });
    let calls = 0;
    const client = {
      json: async <T>() => {
        calls++;
        await new Promise((r) => setTimeout(r, 20));
        return { result: { summary: '', findings: [] } as T, model: 'opus' };
      },
    };
    const components = async () => (await scanGlobal(ctx)).components;
    const checker: ConflictChecker = createConflictChecker({
      ctx,
      store,
      ai: { queue, client, model: 'opus', prompts: { generic: PROMPTS_DIR } },
      // Like the open Conflicts page before the fix: every change event reloads and schedules again.
      onChange: () => void components().then((c) => checker.schedule(c)),
    });
    await checker.schedule(await components());
    await new Promise((r) => setTimeout(r, 400));
    expect(calls).toBe(pluginSkills(await components()).length);
  });
});
