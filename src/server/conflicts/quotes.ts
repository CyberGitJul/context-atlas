import type { ConflictSeverity, ConflictType, Precedence } from '../../shared/conflicts.js';

/** Quotes are compared without markdown marks, case and whitespace differences. */
export function normQuote(s: string): string {
  return s.replace(/[*_`>]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Whether `quote` stands in `text` (normalized); an empty quote never does. */
export function hasQuote(text: string, quote: string | null): boolean {
  const q = normQuote(quote ?? '');
  return q !== '' && normQuote(text).includes(q);
}

/** One finding as the model returns it. */
export interface RawFinding {
  type: ConflictType;
  severity: ConflictSeverity;
  title: string;
  ownId: string;
  quoteOwn: string;
  quoteSkill: string;
  situation: string;
  whoWinsToday: string;
  precedence: Precedence;
  precedenceQuote: string | null;
}

/** A finding whose quotes stand in the texts, under the own rule that holds the own quote. */
export type CheckedFinding = Omit<RawFinding, 'ownId'> & { ownKey: string };

export interface OwnText {
  key: string;
  text: string;
}

/**
 * Keeps only findings whose quotes stand verbatim in the texts: invented or shortened quotes are dropped.
 * The own rule is where the own quote actually stands; the model's `ownId` counts only if the quote is there.
 */
export function verifyFindings(raw: RawFinding[], own: OwnText[], skillText: string): { findings: CheckedFinding[]; dropped: number } {
  const findings: CheckedFinding[] = [];
  for (const { ownId, ...f } of raw) {
    const named = own.find((o) => o.key === ownId.replace(/^\[|\]$/g, '').trim());
    const holder = named && hasQuote(named.text, f.quoteOwn) ? named : own.find((o) => hasQuote(o.text, f.quoteOwn));
    if (!holder || !hasQuote(skillText, f.quoteSkill)) continue;
    findings.push({ ...f, ownKey: holder.key });
  }
  return { findings, dropped: raw.length - findings.length };
}
