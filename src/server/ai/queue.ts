import type { AiState, Explanation } from '../../shared/model.js';
import type { ExplanationCache } from './cache.js';
import { RouterBusyError, type ExplainClient, type ExplainJob } from './router-client.js';

export const MAX_ATTEMPTS = 3;
const ERROR_RETRY_MS = 10_000;

export type QueueState = Omit<AiState, 'enabled'>;
export type QueueEvent = { type: 'explanation'; explanation: Explanation } | { type: 'queue'; state: QueueState };

export interface ExplainQueue {
  enqueue(jobs: ExplainJob[]): void;
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
  const inflight = new Set<string>();
  let running = false;
  let paused = false;
  let exclusive = 0;
  let current: Promise<void> | null = null;
  const failed = new Set<string>();

  const id = (job: ExplainJob) => job.hash;
  const state = (): QueueState => ({ pending: pending.length, running, failed: failed.size, failedHashes: [...failed] });
  const emitState = () => deps.onEvent({ type: 'queue', state: state() });

  async function run(job: ExplainJob): Promise<void> {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const explanation = await deps.client.explain(job);
        await deps.cache.set(explanation);
        failed.delete(id(job));
        deps.onEvent({ type: 'explanation', explanation });
        return;
      } catch (e) {
        if (attempt === MAX_ATTEMPTS) break;
        await sleep(e instanceof RouterBusyError ? e.retryAfterMs : ERROR_RETRY_MS);
      }
    }
    failed.add(id(job));
  }

  async function pump(): Promise<void> {
    if (running) return;
    running = true;
    while (pending.length && !paused && exclusive === 0) {
      const job = pending.shift()!;
      emitState();
      current = run(job);
      await current;
      current = null;
      inflight.delete(id(job));
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
