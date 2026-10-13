import { describe, expect, it } from 'vitest';
import type { ConflictFinding } from '../../src/shared/conflicts.js';
import { decidePrompt, decideProblem, themeSkills, winnersProblem } from '../../src/server/conflicts/decide.js';
import { conflicts } from '../../web/src/locales/conflicts.js';

const f = (skill: string): ConflictFinding => ({
  key: `k-${skill}`,
  ownKey: 'CLAUDE.md#Rule A',
  skillId: `plugin:${skill}`,
  skillName: `superpowers:${skill}`,
  type: 'tension',
  severity: 'medium',
  title: `title of ${skill}`,
  quoteOwn: 'Ask in tabs.',
  quoteSkill: `quote of ${skill}`,
  situation: `situation of ${skill}`,
  whoWinsToday: 'w',
  state: 'new',
  settledBy: null,
  precedenceQuote: null,
  firstSeen: 'T0',
  lastConfirmed: 'T0',
  unconfirmed: false,
  skillChangedAt: null,
});

describe('decide', () => {
  it('themeSkills lists each skill once, in finding order', () => {
    expect(themeSkills([f('a'), f('b'), f('a')])).toEqual(['superpowers:a', 'superpowers:b']);
  });

  it('winnersProblem rejects a missing, a foreign or an invalid winner', () => {
    const skills = ['superpowers:a', 'superpowers:b'];
    expect(winnersProblem(skills, { 'superpowers:a': 'own', 'superpowers:b': 'skill' })).toBe(false);
    expect(winnersProblem(skills, { 'superpowers:a': 'own' })).toBe(true);
    expect(winnersProblem(skills, { 'superpowers:a': 'own', 'superpowers:b': 'own', 'superpowers:x': 'own' })).toBe(true);
    expect(winnersProblem(skills, { 'superpowers:a': 'own', 'superpowers:b': 'maybe' })).toBe(true);
    expect(winnersProblem(skills, null)).toBe(true);
    expect(winnersProblem(skills, ['own', 'skill'])).toBe(true);
  });

  it('decidePrompt carries the rule, each decision and both quotes of every finding', () => {
    const p = decidePrompt('## Rule A\nAsk in tabs.', [f('a'), f('b')], { 'superpowers:a': 'own', 'superpowers:b': 'skill' });
    expect(p).toContain('## Rule A\nAsk in tabs.');
    expect(p).toContain('- superpowers:a: OWN rule wins');
    expect(p).toContain('- superpowers:b: SKILL wins');
    expect(p).toContain('Rule says: "Ask in tabs."');
    expect(p).toContain('Skill says: "quote of a"');
    expect(p).toContain('When it bites: situation of b');
  });

  it('decideProblem flags a changed heading or frontmatter', () => {
    expect(decideProblem('## A\nx', '## A\nx\n- y')).toBeNull();
    expect(decideProblem('## A\nx', '## B\nx')).toBe('heading');
    expect(decideProblem('---\npaths: a\n---\n# R\nx', '---\npaths: a\n---\n# R\nx\n- y')).toBeNull();
    expect(decideProblem('---\npaths: a\n---\n# R\nx', '---\npaths: b\n---\n# R\nx')).toBe('frontmatter');
    expect(decideProblem('---\npaths: a\n---\n# R\nx', '# R\nx')).toBe('heading');
  });

  // The recheck reports an own sentence as explicit-own in either direction ("your rule wins" or "the skill wins").
  it('labels a group settled by an own sentence without claiming who wins', () => {
    expect(conflicts.ownWins).not.toMatch(/win/i);
  });
});
