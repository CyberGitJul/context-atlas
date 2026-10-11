import { describe, expect, it } from 'vitest';
import { anchorsOf, checkCondensed, joinSections, splitSections, strictCounts } from '../../src/server/ai/condense.js';

const FILE = '# Global\n\nPreamble.\n\n## Rule A\nText one.\n\n## Rule B (2026-06-13)\nNever run `rm -rf` in ~/projects/x. Ablauf: Skill `upkeep`.\n';

describe('sections', () => {
  it('splits after the preamble and joins back byte for byte', () => {
    const { preamble, sections } = splitSections(FILE);
    expect(preamble).toBe('# Global\n\nPreamble.\n\n');
    expect(sections.map((s) => s.heading)).toEqual(['## Rule A', '## Rule B (2026-06-13)']);
    expect(joinSections(preamble, sections.map((s) => s.text))).toBe(FILE);
  });

  it('keeps a blank line before the next heading when a new text lost it', () => {
    const { preamble, sections } = splitSections(FILE);
    expect(joinSections(preamble, ['## Rule A\nShorter.', sections[1].text])).toContain('## Rule A\nShorter.\n\n## Rule B');
  });
});

describe('fixed checks', () => {
  const section = splitSections(FILE).sections[1];

  it('finds code, paths, numbers and dates as parts that must stay', () => {
    expect([...anchorsOf(section.text).keys()]).toEqual(expect.arrayContaining(['`rm -rf`', '`upkeep`', '~/projects/x', '2026-06-13']));
    expect(strictCounts('Never, not and only NEVER.').get('never')).toBe(2);
  });

  it('counts German keywords too (German input)', () => {
    expect(strictCounts('Nie, nicht und nur NIE.').get('nie')).toBe(2);
    expect(checkCondensed(splitSections('## Regel\nNie `rm -rf` ausführen.\n').sections[0], '## Regel\n`rm -rf` ausführen.\n').warnings.join(' ')).toContain('“nie” 1 → 0');
  });

  it('passes a shorter text that keeps everything that must stay', () => {
    expect(checkCondensed(section, '## Rule B (2026-06-13)\nNever `rm -rf` in ~/projects/x. Ablauf: Skill `upkeep`.\n')).toEqual({ errors: [], warnings: [] });
  });

  it('does not take words joined by a slash for a path', () => {
    expect([...anchorsOf('Tool-/context-compaction/large-output and host/URL').keys()]).toEqual([]);
  });

  it('refuses a new text that would look like a secret to the app', () => {
    const r = checkCondensed(section, '## Rule B (2026-06-13)\nNever `rm -rf` in ~/projects/x, own token: `curl -o x`. Ablauf: Skill `upkeep`.\n');
    expect(r.errors.join(' ')).toContain('secret detection');
  });

  it('reports a changed heading, a lost pointer line, lost parts and a dropped negation', () => {
    const r = checkCondensed(section, '## Rule B\nNo deleting in projects.\n');
    expect(r.errors.join(' ')).toContain('heading has changed');
    expect(r.errors.join(' ')).toContain('Ablauf: Skill `upkeep`');
    expect(r.errors.join(' ')).toContain('`rm -rf`');
    expect(r.errors.join(' ')).toContain('~/projects/x');
    expect(r.warnings.join(' ')).toContain('“never” 1 → 0');
  });
});
