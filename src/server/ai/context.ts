import type { Component, Explanation, Kind } from '../../shared/model.js';
import { redact } from '../redact.js';
import { truncate } from '../scan/context.js';

const ORDER: Kind[] = ['instruction', 'rule', 'skill', 'agent', 'hook'];
const LABEL: Partial<Record<Kind, string>> = { instruction: 'instruction', rule: 'rule', skill: 'skill description', agent: 'subagent description', hook: 'hook injects' };

export interface ContextLimits {
  perSource?: number;
  total?: number;
}

/**
 * Other active sources as one text for comparison actions: instructions and rules in full,
 * skills/agents by description, hooks by what they inject. Masked, cut per source, within a total budget.
 */
export async function buildContext(
  components: Component[],
  explanations: Record<string, Explanation>,
  exceptId: string,
  readText: (c: Component) => Promise<string | null>,
  limits: ContextLimits = {},
): Promise<string> {
  const perSource = limits.perSource ?? 4000;
  const total = limits.total ?? 80_000;
  const candidates = components
    .filter((c) => c.enabled && c.id !== exceptId && ORDER.includes(c.kind))
    .sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind));

  const blocks: string[] = [];
  let size = 0;
  let skipped = 0;
  for (const c of candidates) {
    let text: string | null;
    if (c.kind === 'instruction' || c.kind === 'rule') text = await readText(c);
    else if (c.kind === 'hook') text = explanations[c.hash]?.injects ?? null;
    else text = c.summary;
    if (!text?.trim()) continue;
    const origin = c.origin.type === 'plugin' ? `Plugin ${c.origin.plugin}` : c.origin.type === 'live' ? 'live only' : 'own';
    const block = `### [${c.id}] ${redact(c.name)} (${LABEL[c.kind] ?? c.kind}, ${origin})\n${truncate(redact(text.trim()), perSource)}\n`;
    if (size + block.length > total) {
      skipped++;
      continue;
    }
    blocks.push(block);
    size += block.length;
  }
  if (skipped) blocks.push(`(${skipped} further sources left out because of size)`);
  return blocks.join('\n');
}
