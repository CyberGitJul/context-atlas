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
  /** Ends the retry wait of the running background task when a user call needs the slot. */
  let taskAbort: AbortController | null = null;
  const failed = new Set<string>();

  const id = (job: ExplainJob) => job.hash;
  const state = (): QueueState => ({ pending: pending.length, running, failed: failed.size, failedHashes: [...failed] });
  const emitState = () => deps.onEvent({ type: 'queue', state: state() });

  /** Resolves when `signal` aborts; never without a signal. */
  const aborted = (signal?: AbortSignal) =>
    new Promise<void>((resolve) => {
      if (signal?.aborted) resolve();
      else signal?.addEventListener('abort', () => resolve(), { once: true });
    });

  /** Runs `fn` up to MAX_ATTEMPTS times; null on success, 'aborted' when `signal` fired, else the last error. */
  async function attempt(fn: () => Promise<void>, signal?: AbortSignal): Promise<Error | 'aborted' | null> {
    for (let n = 1; ; n++) {
      try {
        await fn();
        return null;
      } catch (e) {
        if (signal?.aborted) return 'aborted';
        if (n === MAX_ATTEMPTS) return e instanceof Error ? e : new Error(String(e));
        await Promise.race([sleep(e instanceof RouterBusyError ? e.retryAfterMs : ERROR_RETRY_MS), aborted(signal)]);
        if (signal?.aborted) return 'aborted';
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
    const controller = new AbortController();
    taskAbort = controller;
    try {
      const result = await attempt(task.run, controller.signal);
      // Made way for a user call during a retry wait: first in line again, no attempt lost.
      if (result === 'aborted') {
        if (!tasks.some((t) => t.id === task.id)) tasks.unshift(task);
      } else if (result) task.fail?.(result);
    } finally {
      taskAbort = null;
    }
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
        // A running request finishes (the router cannot cancel it and would keep its slot), but a background
        // task waiting to retry makes way instead of holding the user call back for its wait and further attempts.
        taskAbort?.abort();
        if (current) await current;
        return await fn();
      } finally {
        exclusive--;
        if (exclusive === 0) void pump();
      }
    },
  };
}
