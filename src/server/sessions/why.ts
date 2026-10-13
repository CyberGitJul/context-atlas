import { EXPLAINABLE, type WhyItem, type WhyResult } from '../../shared/sessions.js';
import { hasQuote } from '../conflicts/quotes.js';
import type { FullStep } from './timeline.js';

/** Characters of source text sent along; the least important sources are left out beyond it. */
export const WHY_BUDGET = 150_000;
const BLOCK_MAX = 40_000;
const ACTION_MAX = 8_000;
const TURN_MAX = 30;

/** One text that was in Claude's context, quotable by its id. */
export interface WhyBlock {
  id: string;
  label: string;
  text: string;
}

export interface WhyContext {
  action: FullStep;
  /** Claude's earlier steps in the same turn. */
  turn: FullStep[];
  blocks: WhyBlock[];
  /** Sources left out for length, most important first. */
  dropped: string[];
}

/** The latest step per title, in the order of their latest appearance. */
function latestByTitle(steps: FullStep[]): FullStep[] {
  const last = new Map<string, FullStep>();
  for (const s of steps) {
    last.delete(s.title);
    last.set(s.title, s);
  }
  return [...last.values()];
}

/**
 * What "Why?" sends for step `i`: your message of that turn, the hook texts of the turn (and those that came back
 * with this step), the skill texts and instructions in effect, newest version only. Null unless Claude did the step.
 */
export function whyContext(steps: FullStep[], i: number, budget = WHY_BUDGET): WhyContext | null {
  const action = steps[i];
  if (!action || !EXPLAINABLE.has(action.kind)) return null;
  const before = steps.slice(0, i);
  const start = before.map((s) => s.kind).lastIndexOf('prompt');
  const inTurn = before.slice(start + 1);
  const after: FullStep[] = [];
  for (const s of steps.slice(i + 1)) {
    if (s.kind !== 'hook') break;
    after.push(s);
  }
  const instructions = latestByTitle(before.filter((s) => s.kind === 'instructions'));
  const candidates: { label: string; text: string }[] = [
    ...(start >= 0 ? [{ label: 'Your message', text: before[start].text }] : []),
    ...inTurn.filter((s) => s.kind === 'hook').map((s) => ({ label: s.title, text: s.text })),
    ...after.map((s) => ({ label: `${s.title} (arrived with the result of this step)`, text: s.text })),
    ...latestByTitle(before.filter((s) => s.kind === 'skill')).map((s) => ({ label: s.title, text: s.text })),
    ...instructions.filter((s) => s.title.startsWith('Instructions')).map((s) => ({ label: s.title, text: s.text })),
    ...latestByTitle(before.filter((s) => s.kind === 'hook' && s.title.startsWith('SessionStart'))).map((s) => ({ label: s.title, text: s.text })),
    ...instructions.filter((s) => !s.title.startsWith('Instructions')).map((s) => ({ label: s.title, text: s.text })),
  ];
  const blocks: WhyBlock[] = [];
  const dropped: string[] = [];
  let used = 0;
  for (const c of candidates) {
    const text = c.text.slice(0, BLOCK_MAX);
    // Cut by priority: once one source does not fit, all less important ones stay out too.
    if (dropped.length || used + text.length > budget) {
      dropped.push(c.label);
      continue;
    }
    used += text.length;
    blocks.push({ id: `S${blocks.length + 1}`, label: c.label, text });
  }
  return { action, turn: inTurn.filter((s) => EXPLAINABLE.has(s.kind)).slice(-TURN_MAX), blocks, dropped };
}

/** The action, Claude's earlier steps in the turn, then every source under its id. */
export function whyPrompt(c: WhyContext): string {
  return [
    `# CLAUDE’S ACTION (${c.action.title})`,
    c.action.text.slice(0, ACTION_MAX),
    '',
    '# EARLIER IN THIS TURN (Claude’s previous steps)',
    ...(c.turn.length ? c.turn.map((s) => `- ${s.title}`) : ['- none']),
    '',
    '# SOURCES (quote only from these, cite them by id)',
    ...c.blocks.flatMap((b) => ['', `## [${b.id}] ${b.label}`, b.text]),
    ...(c.dropped.length ? ['', `Left out for length: ${c.dropped.join(', ')}.`] : []),
  ].join('\n');
}

const item = (extra: string) => ({
  type: 'object',
  additionalProperties: false,
  properties: { source: { type: 'string' }, quote: { type: 'string' }, [extra]: { type: 'string' } },
  required: ['source', 'quote', extra],
});

export const WHY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    verdict: { type: 'string' },
    steered: { type: 'array', items: item('how') },
    ignored: { type: 'array', items: item('why') },
  },
  required: ['verdict', 'steered', 'ignored'],
};

/** The model's answer with source names instead of ids; each quote is checked against its own source. Throws when fields are missing. */
export function checkWhy(raw: unknown, c: WhyContext, model: string): WhyResult {
  const r = (raw ?? {}) as Record<string, unknown>;
  const items = (key: string, note: string): WhyItem[] => {
    const list = r[key];
    if (!Array.isArray(list)) throw new Error(`${key} missing`);
    return list.map((x: Record<string, unknown>) => {
      if (typeof x?.source !== 'string' || typeof x.quote !== 'string' || typeof x[note] !== 'string') throw new Error(`${key} incomplete`);
      const block = c.blocks.find((b) => b.id === x.source);
      return { source: block?.label ?? x.source, quote: x.quote, note: x[note] as string, quoteFound: !!block && hasQuote(block.text, x.quote) };
    });
  };
  if (typeof r.verdict !== 'string') throw new Error('verdict missing');
  return { verdict: r.verdict, steered: items('steered', 'how'), ignored: items('ignored', 'why'), sources: c.blocks.length, model };
}
