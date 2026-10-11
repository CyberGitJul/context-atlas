import type { Hint } from './model.js';

/** Warn-level hints that name a component (shown as a badge on its card). */
export function warningsFor(hints: Hint[], componentId: string): Hint[] {
  return hints.filter((h) => h.severity === 'warn' && h.componentIds.includes(componentId));
}
