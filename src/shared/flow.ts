import type { Component, Phase } from './model.js';

export interface FlowStep {
  id: 'start' | 'prompt' | 'think' | 'tool' | 'answer' | 'close';
  label: string;
  /** Short explanation of what happens at this step. */
  hint: string;
  phase: Phase;
  /** Hook events that fire at this step. */
  events: string[];
}

/** The steps of a session in order; the overview columns follow them. */
export const FLOW_STEPS: FlowStep[] = [
  { id: 'start', label: 'Start', hint: 'session begins, also after /clear and compaction', phase: 'session-start', events: ['SessionStart'] },
  { id: 'prompt', label: 'Your message', hint: 'before Claude reads it', phase: 'prompt', events: ['UserPromptSubmit'] },
  { id: 'think', label: 'Claude thinks', hint: 'loads skills and subagents on demand', phase: 'on-demand', events: [] },
  { id: 'tool', label: 'Tool call', hint: 'before and after every tool, repeats', phase: 'tool', events: ['PreToolUse', 'PermissionRequest', 'PostToolUse', 'PostToolUseFailure', 'Notification'] },
  { id: 'answer', label: 'Answer done', hint: 'Claude has finished the answer', phase: 'end', events: ['Stop', 'SubagentStop'] },
  { id: 'close', label: 'Compaction & end', hint: 'context full or session ended', phase: 'end', events: ['PreCompact', 'SessionEnd'] },
];

const STEP_BY_EVENT = new Map(FLOW_STEPS.flatMap((s) => s.events.map((e) => [e, s] as const)));

/** Step a component belongs to; null for always-on components (shown in the band above the flow). */
export function stepOf(c: Component): FlowStep | null {
  if (c.kind === 'hook') {
    const byEvent = STEP_BY_EVENT.get(String(c.detail.event));
    if (byEvent) return byEvent;
  }
  return FLOW_STEPS.find((s) => c.phases.includes(s.phase)) ?? null;
}

export type HookCounts = Record<string, { own: number; plugin: number }>;

export function hookCountsByEvent(components: Component[]): HookCounts {
  const counts: HookCounts = {};
  for (const c of components) {
    if (c.kind !== 'hook') continue;
    const event = String(c.detail.event);
    counts[event] ??= { own: 0, plugin: 0 };
    counts[event][c.origin.type === 'plugin' ? 'plugin' : 'own']++;
  }
  return counts;
}
