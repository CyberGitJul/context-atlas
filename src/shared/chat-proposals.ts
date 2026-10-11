export type Segment =
  | { kind: 'text'; text: string }
  /** New full text for the component of the page the answer was written on. */
  | { kind: 'proposal'; text: string; complete: boolean }
  /** New full text for another (or a new) file, by path. */
  | { kind: 'file'; path: string; text: string; complete: boolean };

/**
 * Splits a chat answer into text, ````proposal blocks and ````file <path> blocks. The fence may have 3+ backticks;
 * as in Markdown it closes on a line with at least as many (trailing spaces allowed). A block without its closing
 * fence is still being streamed.
 */
export function splitProposals(raw: string): Segment[] {
  const content = raw.replace(/\r\n/g, '\n');
  const out: Segment[] = [];
  const re = /(`{3,})(proposal|file[ \t]+([^\n`]+?))[ \t]*\n([\s\S]*?)(\n\1`*[ \t]*(?=\n|$)|$)/g;
  let last = 0;
  for (let m = re.exec(content); m; m = re.exec(content)) {
    if (m.index > last) out.push({ kind: 'text', text: content.slice(last, m.index) });
    const complete = m[5] !== '';
    out.push(m[3] ? { kind: 'file', path: m[3].trim(), text: m[4], complete } : { kind: 'proposal', text: m[4], complete });
    last = m.index + m[0].length;
  }
  if (last < content.length) out.push({ kind: 'text', text: content.slice(last) });
  return out;
}

/**
 * How many values the app masked as *** before sending (a line of just *** is a Markdown rule, not a mask).
 * A proposal with more of them than the text it replaces would write *** over a secret.
 */
export function maskedCount(text: string): number {
  return text
    .split('\n')
    .filter((l) => l.trim() !== '***')
    .join('\n')
    .split('***').length - 1;
}
