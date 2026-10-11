import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { appDirs } from '../paths.js';
import type { Explanation } from '../../shared/model.js';

/** One file per model, so switching the model re-explains everything instead of mixing answers. */
export function defaultCacheFile(model: string): string {
  return path.join(appDirs().cache, `explanations-${model}.json`);
}

export interface ExplanationCache {
  load(): Promise<void>;
  get(hash: string): Explanation | undefined;
  set(e: Explanation): Promise<void>;
  all(): Record<string, Explanation>;
}

/** Current file layout: `{ version, explanations }`, explanations keyed by content hash. */
const FORMAT = 2;

/**
 * Files from before the app was English-only are a flat map keyed `en:<hash>` / `de:<hash>` (or bare `<hash>`,
 * German, from before languages were kept apart). English entries move to `<hash>`; the German ones are dropped
 * and regenerated in English.
 */
function migrate(old: Record<string, Explanation>): Record<string, Explanation> {
  return Object.fromEntries(Object.entries(old).flatMap(([k, e]) => (k.startsWith('en:') ? [[k.slice(3), e]] : [])));
}

/** Explanations keyed by content hash, persisted as one JSON file (written atomically). */
export function createExplanationCache(file: string): ExplanationCache {
  let map: Record<string, Explanation> = {};
  return {
    async load() {
      try {
        const raw = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
        map = raw.version === FORMAT ? ((raw.explanations as Record<string, Explanation> | undefined) ?? {}) : migrate(raw as Record<string, Explanation>);
      } catch {
        map = {};
      }
    },
    get: (hash) => map[hash],
    async set(e) {
      map[e.hash] = e;
      await mkdir(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify({ version: FORMAT, explanations: map }, null, 1));
      await rename(tmp, file);
    },
    all: () => map,
  };
}
