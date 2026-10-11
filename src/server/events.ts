import type { QueueEvent } from './ai/queue.js';

export interface EventHub {
  publish(e: QueueEvent): void;
  subscribe(fn: (e: QueueEvent) => void): () => void;
}

/** Fan-out of queue events to connected SSE clients. */
export function createEventHub(): EventHub {
  const listeners = new Set<(e: QueueEvent) => void>();
  return {
    publish: (e) => listeners.forEach((fn) => fn(e)),
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
