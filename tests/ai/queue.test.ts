import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Explanation } from '../../src/shared/model.js';
import { createExplanationCache, defaultCacheFile } from '../../src/server/ai/cache.js';
import { createExplainQueue, MAX_ATTEMPTS, type BackgroundTask, type QueueEvent } from '../../src/server/ai/queue.js';
import { RouterBusyError, type ExplainJob } from '../../src/server/ai/router-client.js';

const job = (hash: string): ExplainJob => ({ hash, kind: 'hook', name: hash, input: 'x' });
const explanation = (hash: string): Explanation => ({ hash, title: 'T', summary: `S ${hash}`, injects: null, at: 'now' });

async function freshCache() {
  const cache = createExplanationCache(path.join(await mkdtemp(path.join(tmpdir(), 'atlas-cache-')), 'explanations.json'));
  await cache.load();
  return cache;
}

/** Waits until the queue reports idle (nothing pending, nothing running). */
function idle(events: QueueEvent[]) {
  return new Promise<void>((resolve) => {
    const check = () => {
      const last = [...events].reverse().find((e) => e.type === 'queue');
      if (last && last.type === 'queue' && !last.state.running && last.state.pending === 0) resolve();
      else setTimeout(check, 1);
    };
    check();
  });
}

describe('explain queue', () => {
  it('runs jobs strictly one after another', async () => {
    let active = 0;
    let maxActive = 0;
    const client = {
      explain: async (j: ExplainJob) => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 5));
        active--;
        return explanation(j.hash);
      },
    };
    const events: QueueEvent[] = [];
    const queue = createExplainQueue({ client, cache: await freshCache(), onEvent: (e) => events.push(e) });
    queue.enqueue([job('a'), job('b'), job('c')]);
    await idle(events);
    expect(maxActive).toBe(1);
    expect(events.filter((e) => e.type === 'explanation')).toHaveLength(3);
  });

  it('skips cached hashes and runs duplicates only once', async () => {
    const asked: string[] = [];
    const cache = await freshCache();
    await cache.set(explanation('cached'));
    const events: QueueEvent[] = [];
    const queue = createExplainQueue({ client: { explain: async (j) => (asked.push(j.hash), explanation(j.hash)) }, cache, onEvent: (e) => events.push(e) });
    queue.enqueue([job('cached'), job('new'), job('new')]);
    queue.enqueue([job('new')]);
    await idle(events);
    expect(asked).toEqual(['new']);
    expect(cache.get('new')?.summary).toBe('S new');
  });

  it('waits Retry-After on busy, gives up after 3 attempts and keeps going', async () => {
    const slept: number[] = [];
    const client = {
      explain: async (j: ExplainJob) => {
        if (j.hash === 'busy') throw new RouterBusyError(2000);
        return explanation(j.hash);
      },
    };
    const events: QueueEvent[] = [];
    const queue = createExplainQueue({ client, cache: await freshCache(), onEvent: (e) => events.push(e), sleep: async (ms) => void slept.push(ms) });
    queue.enqueue([job('busy'), job('after')]);
    await idle(events);
    expect(slept).toEqual([2000, 2000]);
    expect(queue.state().failed).toBe(1);
    expect(events.some((e) => e.type === 'explanation' && e.explanation.hash === 'after')).toBe(true);
  });

  it('counts each failed hash once and forgets it after a later success', async () => {
    let fail = true;
    const events: QueueEvent[] = [];
    const queue = createExplainQueue({
      client: { explain: async (j) => (fail ? Promise.reject(new Error('down')) : explanation(j.hash)) },
      cache: await freshCache(),
      onEvent: (e) => events.push(e),
      sleep: async () => {},
    });
    queue.enqueue([job('h')]);
    await idle(events);
    queue.enqueue([job('h')]);
    await idle(events);
    expect(queue.state()).toMatchObject({ failed: 1, failedHashes: ['h'] });
    fail = false;
    queue.enqueue([job('h')]);
    await idle(events);
    expect(queue.state()).toMatchObject({ failed: 0, failedHashes: [] });
  });

  it('waits 10 s after other errors', async () => {
    const slept: number[] = [];
    const events: QueueEvent[] = [];
    const queue = createExplainQueue({
      client: { explain: async () => Promise.reject(new Error('down')) },
      cache: await freshCache(),
      onEvent: (e) => events.push(e),
      sleep: async (ms) => void slept.push(ms),
    });
    queue.enqueue([job('x')]);
    await idle(events);
    expect(slept).toEqual([10_000, 10_000]);
  });

  it('pauses after the running job and resumes on request', async () => {
    const asked: string[] = [];
    const events: QueueEvent[] = [];
    const queue = createExplainQueue({
      client: { explain: async (j) => (asked.push(j.hash), await new Promise((r) => setTimeout(r, 5)), explanation(j.hash)) },
      cache: await freshCache(),
      onEvent: (e) => events.push(e),
    });
    queue.enqueue([job('a'), job('b')]);
    queue.pause();
    await new Promise((r) => setTimeout(r, 30));
    expect(asked).toEqual(['a']);
    expect(queue.state().pending).toBe(1);
    queue.resume();
    await idle(events);
    expect(asked).toEqual(['a', 'b']);
  });

  it('keeps one cache file per model so switching models re-explains everything', () => {
    expect(defaultCacheFile('opus')).toMatch(/explanations-opus\.json$/);
    expect(defaultCacheFile('haiku')).not.toBe(defaultCacheFile('opus'));
  });

  it('persists explanations so a new cache instance sees them', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'atlas-cache-'));
    const file = path.join(dir, 'sub', 'explanations.json');
    const first = createExplanationCache(file);
    await first.load();
    await first.set(explanation('p'));
    const second = createExplanationCache(file);
    await second.load();
    expect(second.get('p')?.summary).toBe('S p');
  });

  it('migrates an old cache file: en: entries are kept by hash, de: and bare-hash (German) entries are dropped', async () => {
    const file = path.join(await mkdtemp(path.join(tmpdir(), 'atlas-cache-')), 'e.json');
    await writeFile(file, JSON.stringify({ 'en:a': explanation('a'), 'de:b': explanation('b'), legacy: explanation('legacy') }));
    const cache = createExplanationCache(file);
    await cache.load();
    expect(Object.keys(cache.all())).toEqual(['a']);
    expect(cache.get('a')?.summary).toBe('S a');
    expect([cache.get('b'), cache.get('legacy')]).toEqual([undefined, undefined]);
    await cache.set(explanation('b'));
    expect(cache.get('b')?.summary).toBe('S b');
    const reloaded = createExplanationCache(file);
    await reloaded.load();
    expect(Object.keys(reloaded.all()).sort()).toEqual(['a', 'b']);
  });

  it('runExclusive waits for the running job, holds the queue while it runs, then resumes', async () => {
    const log: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const events: QueueEvent[] = [];
    const queue = createExplainQueue({
      client: {
        explain: async (j) => {
          log.push(`start ${j.hash}`);
          if (j.hash === 'a') await gate;
          log.push(`end ${j.hash}`);
          return explanation(j.hash);
        },
      },
      cache: await freshCache(),
      onEvent: (e) => events.push(e),
    });
    queue.enqueue([job('a'), job('b')]);
    await new Promise((r) => setTimeout(r, 5));
    const exclusive = queue.runExclusive(async () => {
      log.push('user action');
      await new Promise((r) => setTimeout(r, 10));
      return 42;
    });
    await new Promise((r) => setTimeout(r, 5));
    expect(log).toEqual(['start a']);
    release();
    expect(await exclusive).toBe(42);
    await idle(events);
    expect(log).toEqual(['start a', 'end a', 'user action', 'start b', 'end b']);
  });
});

describe('background tasks', () => {
  const task = (id: string, log: string[], fails = false): BackgroundTask => ({
    id,
    run: async () => {
      if (fails) throw new Error(`boom ${id}`);
      log.push(id);
    },
  });

  it('runs background tasks after all pending explanation jobs', async () => {
    const log: string[] = [];
    const events: QueueEvent[] = [];
    const queue = createExplainQueue({ client: { explain: async (j) => (log.push(j.hash), explanation(j.hash)) }, cache: await freshCache(), onEvent: (e) => events.push(e) });
    queue.pause();
    queue.enqueueTask(task('t1', log));
    queue.enqueue([job('a'), job('b')]);
    queue.resume();
    await idle(events);
    expect(log).toEqual(['a', 'b', 't1']);
  });

  it('queues a task id only once while it is pending', async () => {
    const log: string[] = [];
    const events: QueueEvent[] = [];
    const queue = createExplainQueue({ client: { explain: async (j) => explanation(j.hash) }, cache: await freshCache(), onEvent: (e) => events.push(e) });
    queue.pause();
    queue.enqueueTask(task('t1', log));
    queue.enqueueTask(task('t1', log));
    queue.resume();
    await idle(events);
    expect(log).toEqual(['t1']);
  });

  it('retries a failing task and reports the last error once', async () => {
    let attempts = 0;
    const errors: string[] = [];
    const events: QueueEvent[] = [];
    const queue = createExplainQueue({ client: { explain: async (j) => explanation(j.hash) }, cache: await freshCache(), onEvent: (e) => events.push(e), sleep: async () => {} });
    queue.enqueueTask({
      id: 't1',
      run: async () => {
        attempts++;
        throw new Error('boom t1');
      },
      fail: (e) => errors.push(e.message),
    });
    await idle(events);
    expect(attempts).toBe(MAX_ATTEMPTS);
    expect(errors).toEqual(['boom t1']);
    expect(queue.state().failed).toBe(0);
  });

  it('lets a user call go before the next task', async () => {
    const log: string[] = [];
    const events: QueueEvent[] = [];
    const queue = createExplainQueue({ client: { explain: async (j) => explanation(j.hash) }, cache: await freshCache(), onEvent: (e) => events.push(e) });
    queue.enqueueTask({ id: 't1', run: async () => (await new Promise((r) => setTimeout(r, 5)), void log.push('t1')) });
    queue.enqueueTask(task('t2', log));
    await queue.runExclusive(async () => void log.push('user'));
    await idle(events);
    expect(log).toEqual(['t1', 'user', 't2']);
  });
});
