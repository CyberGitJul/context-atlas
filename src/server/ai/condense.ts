import { pointerForm, skillPointers } from '../../shared/skill-links.js';
import { msg } from '../messages/index.js';
import { redact } from '../redact.js';
import { wordCount } from '../scan/context.js';

/** "CLAUDE.md verdichten": the file in sections, fixed checks without AI, and the shapes of the two AI passes. */

export { joinSections, splitSections, type Section } from '../../shared/sections.js';
import type { Section } from '../../shared/sections.js';

/** Words whose loss changes a rule: negations, restrictions, obligations (German and English). */
const STRICT = /\b(nicht|nie|niemals|kein|keine|keinen|keinem|keiner|keines|nichts|nur|immer|muss|müssen|musst|darf|dürfen|darfst|verboten|never|not|no|only|always|must|may)\b/gi;

export function strictCounts(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const m of text.matchAll(STRICT)) counts.set(m[1].toLowerCase(), (counts.get(m[1].toLowerCase()) ?? 0) + 1);
  return counts;
}

/** Parts that must survive word for word: code spans, URLs, paths, numbers and dates. */
export function anchorsOf(text: string): Map<string, number> {
  const found = [
    ...text.matchAll(/`[^`\n]+`/g),
    ...text.matchAll(/https?:\/\/[^\s)>\]`]+/g),
    // A path starts the word: not inside one like „Tool-/Kontext“ or „Host/URL“.
    ...text.replace(/`[^`\n]+`/g, ' ').matchAll(/(?<![\w`\-/.])(?:~\/|\/)[\w.\-]+(?:\/[\w.\-]*)+/g),
    ...text.replace(/`[^`\n]+`/g, ' ').matchAll(/\b\d+(?:[.,:\-]\d+)*\b/g),
  ].map((m) => m[0].replace(/[.,;:]+$/, ''));
  const counts = new Map<string, number>();
  for (const a of found) counts.set(a, (counts.get(a) ?? 0) + 1);
  return counts;
}

export interface CondenseCheck {
  /** Something that must stay is gone: the section is not taken over unless the user ticks it. */
  errors: string[];
  /** Worth a look: fewer negations or obligations, a part mentioned less often. */
  warnings: string[];
}

export function checkCondensed(before: Section, after: string): CondenseCheck {
  const m = msg.edit.condense;
  const errors: string[] = [];
  const warnings: string[] = [];
  if (after.split('\n')[0] !== before.heading) errors.push(m.headingChanged);
  if (/\n## /.test(after)) errors.push(m.extraHeading);
  const lostPointers = skillPointers(before.text).filter((p) => !skillPointers(after).includes(p));
  if (lostPointers.length) errors.push(m.pointerMissing(lostPointers.map((p) => `${pointerForm(before.text, p)} \`${p}\``)));
  const kept = anchorsOf(after);
  const missing = [...anchorsOf(before.text).keys()].filter((a) => !kept.has(a));
  if (missing.length) errors.push(m.missingVerbatim(missing.slice(0, 8), Math.max(0, missing.length - 8)));
  const now = strictCounts(after);
  const fewer = [...strictCounts(before.text)].filter(([w, n]) => (now.get(w) ?? 0) < n).map(([w, n]) => ({ word: w, before: n, after: now.get(w) ?? 0 }));
  if (fewer.length) warnings.push(m.fewerStrict(fewer));
  // Prose like „als eigenes Token: `curl …`“ looks like a secret to the app: saved, it would lock editing and commits of the whole file.
  if (redact(after) !== after && redact(before.text) === before.text) {
    errors.push(m.secretLike);
  }
  return { errors, warnings };
}

export const words = (text: string) => wordCount(text);

/** First AI pass: every section, possibly condensed, with a note on what could move out. */
export const PROPOSE_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    sections: {
      type: 'array',
      items: {
        type: 'object',
        properties: { index: { type: 'integer' }, after: { type: 'string' }, changes: { type: 'array', items: { type: 'string' } }, outsource: { type: 'string' } },
        required: ['index', 'after', 'changes', 'outsource'],
        additionalProperties: false,
      },
    },
  },
  required: ['summary', 'sections'],
  additionalProperties: false,
};

export const RULE_STATUS = ['kept', 'weakened', 'lost', 'ambiguous', 'new'] as const;
export type RuleStatus = (typeof RULE_STATUS)[number];

/** Second AI pass: the rules of each old section and how each one fares in the new text. */
export const TEST_SCHEMA = {
  type: 'object',
  properties: {
    sections: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          index: { type: 'integer' },
          rules: {
            type: 'array',
            items: {
              type: 'object',
              properties: { rule: { type: 'string' }, status: { type: 'string', enum: [...RULE_STATUS] }, before: { type: 'string' }, after: { type: 'string' }, note: { type: 'string' } },
              required: ['rule', 'status', 'before', 'after', 'note'],
              additionalProperties: false,
            },
          },
        },
        required: ['index', 'rules'],
        additionalProperties: false,
      },
    },
  },
  required: ['sections'],
  additionalProperties: false,
};

/** Third AI pass, the reviewer: sections with findings get those findings fixed with as few words as possible. */
export const REPAIR_SCHEMA = {
  type: 'object',
  properties: {
    sections: {
      type: 'array',
      items: {
        type: 'object',
        properties: { index: { type: 'integer' }, after: { type: 'string' }, changes: { type: 'array', items: { type: 'string' } } },
        required: ['index', 'after', 'changes'],
        additionalProperties: false,
      },
    },
  },
  required: ['sections'],
  additionalProperties: false,
};

export function proposePrompt(sections: Section[]): string {
  return sections.map((s) => [`### Section ${s.index}`, '<<<', s.text.trimEnd(), '>>>'].join('\n')).join('\n\n');
}

export function testPrompt(pairs: { section: Section; after: string }[]): string {
  return pairs.map((p) => [`### Section ${p.section.index}`, 'Old:', '<<<', p.section.text.trimEnd(), '>>>', 'New:', '<<<', p.after.trimEnd(), '>>>'].join('\n')).join('\n\n');
}

export function repairPrompt(items: { section: Section; after: string; findings: string[] }[]): string {
  return items
    .map((p) => [testPrompt([p]), 'Findings:', ...p.findings.map((f) => `- ${f}`)].join('\n'))
    .join('\n\n');
}
