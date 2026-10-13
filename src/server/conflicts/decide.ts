import type { ConflictFinding, Winner } from '../../shared/conflicts.js';

/** The skills of a theme, each once, in the order of its findings. */
export function themeSkills(findings: ConflictFinding[]): string[] {
  return [...new Set(findings.map((f) => f.skillName))];
}

/** Whether `winners` decides exactly the skills of the theme, each for `own` or `skill`. */
export function winnersProblem(skills: string[], winners: unknown): boolean {
  if (!winners || typeof winners !== 'object' || Array.isArray(winners)) return true;
  const entries = Object.entries(winners);
  return entries.length !== skills.length || entries.some(([name, w]) => !skills.includes(name) || (w !== 'own' && w !== 'skill'));
}

/** The rule, the decision per skill and every finding with both quotes. */
export function decidePrompt(rule: string, findings: ConflictFinding[], winners: Record<string, Winner>): string {
  return [
    '# RULE (add the precedence sentence here)',
    '',
    rule,
    '',
    '# DECISION PER SKILL',
    '',
    ...themeSkills(findings).map((name) => `- ${name}: ${winners[name] === 'own' ? 'OWN rule wins' : 'SKILL wins'}`),
    '',
    '# FINDINGS',
    ...findings.flatMap((f) => ['', `## ${f.skillName}: ${f.title}`, `Rule says: "${f.quoteOwn}"`, `Skill says: "${f.quoteSkill}"`, `When it bites: ${f.situation}`]),
  ].join('\n');
}

export const DECIDE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    after: { type: 'string' },
    changes: { type: 'array', items: { type: 'string' } },
  },
  required: ['after', 'changes'],
};

const FRONTMATTER = /^---\n[\s\S]*?\n---\n/;

/** A proposal must keep the heading line and, for a rule file, its frontmatter byte for byte. */
export function decideProblem(before: string, after: string): 'heading' | 'frontmatter' | null {
  if (before.split('\n')[0] !== after.split('\n')[0]) return 'heading';
  const head = before.match(FRONTMATTER)?.[0];
  if (head && !after.startsWith(head)) return 'frontmatter';
  return null;
}
