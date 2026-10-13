import { describe, expect, it } from 'vitest';
import { hasQuote, normQuote, verifyFindings, type OwnText, type RawFinding } from '../../src/server/conflicts/quotes.js';

const own: OwnText[] = [
  { key: 'CLAUDE.md#Rule A', text: '## Rule A\nAlways ask **several** questions at once.' },
  { key: 'CLAUDE.md#Rule B', text: '## Rule B\nBe brief.' },
];
const SKILL = 'Ask exactly one question per message.';
const raw = (o: Partial<RawFinding> = {}): RawFinding => ({
  type: 'contradiction',
  severity: 'high',
  title: 't',
  ownId: 'CLAUDE.md#Rule A',
  quoteOwn: 'Always ask several questions at once.',
  quoteSkill: 'Ask exactly one question per message.',
  situation: 's',
  whoWinsToday: 'w',
  precedence: 'none',
  precedenceQuote: null,
  ...o,
});

describe('quotes', () => {
  it('normQuote strips markdown marks, collapses whitespace, lowercases', () => {
    expect(normQuote('**Ask**  one\n`question`')).toBe('ask one question');
  });

  it('hasQuote is false for an empty quote', () => {
    expect(hasQuote('abc', '  ')).toBe(false);
  });

  it('keeps a finding whose quotes are verbatim, under its own rule', () => {
    const { findings, dropped } = verifyFindings([raw()], own, SKILL);
    const { ownId: _, ...rest } = raw();
    expect(dropped).toBe(0);
    expect(findings).toEqual([{ ...rest, ownKey: 'CLAUDE.md#Rule A' }]);
  });

  it('drops a finding whose skill quote is not verbatim in the skill', () => {
    expect(verifyFindings([raw({ quoteSkill: 'Ask one question…' })], own, SKILL)).toEqual({ findings: [], dropped: 1 });
  });

  it('maps a finding to the own rule that contains the quote, even with a wrong ownId', () => {
    expect(verifyFindings([raw({ ownId: '[CLAUDE.md#Rule B]' })], own, SKILL).findings[0].ownKey).toBe('CLAUDE.md#Rule A');
  });

  it('drops a finding whose own quote is in no own rule', () => {
    expect(verifyFindings([raw({ quoteOwn: 'Never ask.' })], own, SKILL).dropped).toBe(1);
  });
});
