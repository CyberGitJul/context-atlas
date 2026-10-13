import type { AiState, Explanation } from '../../shared/model.js';
import type { ExplanationCache } from './cache.js';
import { RouterBusyError, type ExplainClient, type ExplainJob } from './router-client.js';

export const MAX_ATTEMPTS = 3;
const ERROR_RETRY_MS = 10_000;

export type QueueState = Omit<AiState, 'enabled'>;
export type QueueEvent = { type: 'explanation'; explanation: Explanation } | { type: 'queue'; state: QueueState } | { type: 'conflicts' };

/** Other background work on the same router slot, e.g. a conflict check; runs after the explanations. */
export interface BackgroundTask {
  /** Queued once while a task with this id is pending (a running one does not block). */
  id: string;
  run: () => Promise<void>;
  /** Called once, with the last error, after the final failed attempt. */
  fail?: (e: Error) => void;
}

export interface ExplainQueue {
  enqueue(jobs: ExplainJob[]): void;
  enqueueTask(task: BackgroundTask): void;
  pause(): void;
  resume(): void;
  state(): QueueState;
  /** Runs a user-triggered router call with priority: waits for the running job, holds the queue meanwhile. */
  runExclusive<T>(fn: () => Promise<T>): Promise<T>;
}

interface Deps {
  client: ExplainClient;
  cache: ExplanationCache;
  onEvent: (e: QueueEvent) => void;
  sleep?: (ms: number) => Promise<void>;
}

/** Background queue: one router request at a time, results cached by hash. */
export function createExplainQueue(deps: Deps): ExplainQueue {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const pending: ExplainJob[] = [];
  const tasks: BackgroundTask[] = [];
  const inflight = new Set<string>();
  let running = false;
  let paused = false;
  let exclusive = 0;
  let current: Promise<void> | null = null;
  const failed = new Set<string>();

  const id = (job: ExplainJob) => job.hash;
  const state = (): QueueState => ({ pending: pending.length, running, failed: failed.size, failedHashes: [...failed] });
  const emitState = () => deps.onEvent({ type: 'queue', state: state() });

  /** Runs `fn` up to MAX_ATTEMPTS times; returns null on success, else the last error. */
  async function attempt(fn: () => Promise<void>): Promise<Error | null> {
    for (let n = 1; ; n++) {
      try {
        await fn();
        return null;
      } catch (e) {
        if (n === MAX_ATTEMPTS) return e instanceof Error ? e : new Error(String(e));
        await sleep(e instanceof RouterBusyError ? e.retryAfterMs : ERROR_RETRY_MS);
      }
    }
  }

  async function run(job: ExplainJob): Promise<void> {
    const error = await attempt(async () => {
      const explanation = await deps.client.explain(job);
      await deps.cache.set(explanation);
      failed.delete(id(job));
      deps.onEvent({ type: 'explanation', explanation });
    });
    if (error) failed.add(id(job));
  }

  async function runTask(task: BackgroundTask): Promise<void> {
    const error = await attempt(task.run);
    if (error) task.fail?.(error);
  }

  async function pump(): Promise<void> {
    if (running) return;
    running = true;
    while ((pending.length || tasks.length) && !paused && exclusive === 0) {
      // Explanations first: a background task only starts when no job is waiting.
      const job = pending.shift();
      const task = job ? undefined : tasks.shift()!;
      emitState();
      current = job ? run(job) : runTask(task!);
      await current;
      current = null;
      if (job) inflight.delete(id(job));
    }
    running = false;
    emitState();
  }

  return {
    enqueue(jobs) {
      for (const job of jobs) {
        if (deps.cache.get(job.hash) || inflight.has(id(job))) continue;
        inflight.add(id(job));
        pending.push(job);
      }
      emitState();
      void pump();
    },
    enqueueTask(task) {
      if (!tasks.some((t) => t.id === task.id)) tasks.push(task);
      void pump();
    },
    pause() {
      paused = true;
    },
    resume() {
      paused = false;
      void pump();
    },
    state,
    async runExclusive(fn) {
      exclusive++;
      try {
        if (current) await current;
        return await fn();
      } finally {
        exclusive--;
        if (exclusive === 0) void pump();
      }
    },
  };
}
