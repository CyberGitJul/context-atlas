import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CheckedFinding } from '../../src/server/conflicts/quotes.js';
import { createConflictStore, defaultConflictsFile, findingKey, type PairRun } from '../../src/server/conflicts/store.js';

const OWN = '## Rule A\nAlways ask several questions at once.\n\n## Precedence\nMy rules win over Superpowers.';
const SKILL = 'Ask exactly one question per message.';
const ID = 'skill:sp:brainstorming';
const f = (o: Partial<CheckedFinding> = {}): CheckedFinding => ({
  ownKey: 'CLAUDE.md#Rule A',
  type: 'contradiction',
  severity: 'high',
  title: 'One vs. many',
  quoteOwn: 'Always ask several questions at once.',
  quoteSkill: SKILL,
  situation: 's',
  whoWinsToday: 'w',
  precedence: 'none',
  precedenceQuote: null,
  ...o,
});
const run = (o: Partial<PairRun> = {}): PairRun => ({ skillId: ID, skillName: 'superpowers:brainstorming', hash: 'h1', at: 'T1', findings: [f()], dropped: 0, own: [{ key: 'CLAUDE.md#Rule A', text: OWN }], skillText: SKILL, ...o });
const own = { precedence: 'explicit-own' as const, precedenceQuote: 'My rules win over **Superpowers**.' };

async function freshStore(file?: string) {
  const store = createConflictStore(file ?? path.join(await mkdtemp(path.join(tmpdir(), 'atlas-conflicts-')), 'conflicts.json'));
  await store.load();
  return store;
}

describe('conflict store', () => {
  it('an unconfirmed finding of a rule the latest check settled for this skill by an own sentence becomes deliberate too', async () => {
    const skillText = `${SKILL} Never bundle. Use a menu.`;
    const store = await freshStore();
    await store.applyRun(run({ skillText, findings: [f({ quoteSkill: 'Never bundle.' }), f({ quoteSkill: 'Use a menu.' })] }));
    // The decision run reports the same conflict under another skill passage, settled by the own sentence.
    await store.applyRun(run({ skillText, at: 'T2', findings: [f({ ...own, quoteSkill: SKILL })] }));
    const byQuote = Object.fromEntries(store.findings().map((x) => [x.quoteSkill, x]));
    expect(byQuote[SKILL]).toMatchObject({ state: 'deliberate', settledBy: 'own', unconfirmed: false });
    for (const q of ['Never bundle.', 'Use a menu.']) {
      expect(byQuote[q]).toMatchObject({ state: 'deliberate', settledBy: 'own', precedenceQuote: own.precedenceQuote, unconfirmed: true });
    }
  });

  it('an unconfirmed finding of another rule stays new when the check settled a different rule', async () => {
    const skillText = `${SKILL} Never bundle.`;
    const texts = [{ key: 'CLAUDE.md#Rule A', text: OWN }, { key: 'CLAUDE.md#Rule B', text: '## Rule B\nBe brief.' }];
    const store = await freshStore();
    await store.applyRun(run({ skillText, own: texts, findings: [f({ ownKey: 'CLAUDE.md#Rule B', quoteOwn: 'Be brief.', quoteSkill: 'Never bundle.' })] }));
    await store.applyRun(run({ skillText, own: texts, at: 'T2', findings: [f({ ...own })] }));
    expect(store.findings().find((x) => x.ownKey === 'CLAUDE.md#Rule B')).toMatchObject({ state: 'new', settledBy: null, unconfirmed: true });
  });

  it('stores a new finding as new with its pair hash', async () => {
    const store = await freshStore();
    await store.applyRun(run());
    expect(store.findings()).toHaveLength(1);
    expect(store.findings()[0]).toMatchObject({ state: 'new', settledBy: null, skillId: ID, skillName: 'superpowers:brainstorming', firstSeen: 'T1', unconfirmed: false });
    expect(store.pair(ID)).toEqual({ hash: 'h1', checkedAt: 'T1', dropped: 0, error: null });
  });

  it('marks a finding deliberate when the own text states the precedence verbatim', async () => {
    const store = await freshStore();
    await store.applyRun(run({ findings: [f(own)] }));
    expect(store.findings()[0]).toMatchObject({ state: 'deliberate', settledBy: 'own', precedenceQuote: own.precedenceQuote });
  });

  it('keeps it new when the precedence sentence is not in the own text', async () => {
    const store = await freshStore();
    await store.applyRun(run({ findings: [f({ precedence: 'explicit-own', precedenceQuote: 'Superpowers always loses.' })] }));
    expect(store.findings()[0]).toMatchObject({ state: 'new', settledBy: null });
  });

  it('counts "the skill defers" only when the quote is in the skill text', async () => {
    const yes = await freshStore();
    await yes.applyRun(run({ findings: [f({ precedence: 'explicit-skill', precedenceQuote: SKILL })] }));
    expect(yes.findings()[0]).toMatchObject({ state: 'deliberate', settledBy: 'skill' });
    const no = await freshStore();
    await no.applyRun(run({ findings: [f({ precedence: 'explicit-skill', precedenceQuote: 'Users decide.' })] }));
    expect(no.findings()[0]).toMatchObject({ state: 'new', settledBy: null });
  });

  it('keeps a deliberate state across runs while the sentence is still there', async () => {
    const store = await freshStore();
    await store.applyRun(run({ findings: [f(own)] }));
    await store.applyRun(run({ at: 'T2' }));
    expect(store.findings()).toHaveLength(1);
    expect(store.findings()[0]).toMatchObject({ state: 'deliberate', settledBy: 'own', firstSeen: 'T1', lastConfirmed: 'T2' });
  });

  it('turns a deliberate finding new again when its sentence is removed', async () => {
    const store = await freshStore();
    await store.applyRun(run({ findings: [f(own)] }));
    await store.applyRun(run({ at: 'T2', own: [{ key: 'CLAUDE.md#Rule A', text: '## Rule A\nAlways ask several questions at once.' }], findings: [] }));
    expect(store.findings()[0]).toMatchObject({ state: 'new', settledBy: null, precedenceQuote: null, unconfirmed: true });
  });

  it('keeps an unreported finding with both quotes present as unconfirmed', async () => {
    const store = await freshStore();
    await store.applyRun(run());
    await store.applyRun(run({ at: 'T2', findings: [] }));
    expect(store.findings()).toHaveLength(1);
    expect(store.findings()[0]).toMatchObject({ unconfirmed: true, lastConfirmed: 'T1' });
  });

  it('resolves a finding only when one of its quotes is gone', async () => {
    const store = await freshStore();
    await store.applyRun(run());
    await store.applyRun(run({ at: 'T2', findings: [], skillText: 'Something else.' }));
    expect(store.findings()).toEqual([]);
  });

  it('notes a changed skill passage that the own sentence still covers', async () => {
    const store = await freshStore();
    await store.applyRun(run({ findings: [f(own)] }));
    const changed = 'Ask only one question.';
    await store.applyRun(run({ at: 'T2', skillText: changed, findings: [f({ ...own, quoteSkill: changed })] }));
    expect(store.findings()).toHaveLength(1);
    expect(store.findings()[0]).toMatchObject({ quoteSkill: changed, state: 'deliberate', skillChangedAt: 'T2', firstSeen: 'T1' });
  });

  it('a changed skill passage that is no longer covered becomes new', async () => {
    const store = await freshStore();
    await store.applyRun(run({ findings: [f(own)] }));
    const changed = 'Ask only one question.';
    await store.applyRun(run({ at: 'T2', skillText: changed, findings: [f({ quoteSkill: changed })] }));
    expect(store.findings()).toHaveLength(1);
    expect(store.findings()[0]).toMatchObject({ quoteSkill: changed, state: 'new', skillChangedAt: null });
  });

  it('resolves an unreported finding whose own rule is gone (renamed heading)', async () => {
    const store = await freshStore();
    await store.applyRun(run());
    const renamed = OWN.replace('## Rule A', '## Rule Z');
    await store.applyRun(run({ at: 'T2', own: [{ key: 'CLAUDE.md#Rule Z', text: renamed }], findings: [f({ ownKey: 'CLAUDE.md#Rule Z' })] }));
    expect(store.findings().map((x) => x.ownKey)).toEqual(['CLAUDE.md#Rule Z']);
  });

  it('resolves an unreported finding whose own quote moved to another rule', async () => {
    const store = await freshStore();
    await store.applyRun(run());
    await store.applyRun(run({ at: 'T2', own: [{ key: 'CLAUDE.md#Rule A', text: '## Rule A\nBe brief.' }, { key: 'CLAUDE.md#Other', text: OWN }], findings: [] }));
    expect(store.findings()).toEqual([]);
  });

  it('recordError keeps the old hash so the pair stays due', async () => {
    const store = await freshStore();
    await store.applyRun(run());
    await store.recordError(ID, 'down');
    expect(store.pair(ID)).toMatchObject({ hash: 'h1', error: 'down' });
    await store.recordError('skill:other', 'down');
    expect(store.pair('skill:other')).toEqual({ hash: '', checkedAt: null, dropped: 0, error: 'down' });
  });

  it('persists and reloads; an unreadable file starts empty', async () => {
    const file = path.join(await mkdtemp(path.join(tmpdir(), 'atlas-conflicts-')), 'conflicts.json');
    const store = await freshStore(file);
    await store.applyRun(run());
    const again = await freshStore(file);
    expect(again.findings()).toEqual(store.findings());
    expect(again.pair(ID)?.hash).toBe('h1');
    await writeFile(file, '{');
    expect((await freshStore(file)).findings()).toEqual([]);
  });

  it('findingKey ignores markdown and whitespace in the skill quote', () => {
    expect(findingKey('k', 's', '**Ask**  one')).toBe(findingKey('k', 's', 'ask one'));
    expect(findingKey('k', 's', 'ask one')).not.toBe(findingKey('k2', 's', 'ask one'));
  });

  it('keeps the inventory next to the explanation cache', () => {
    expect(defaultConflictsFile()).toMatch(/context-atlas[/\\]conflicts\.json$/);
  });
});
