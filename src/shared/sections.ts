/** A CLAUDE.md in `## ` sections, as the server checks it and the page puts it back together. */

export interface Section {
  index: number;
  /** First line, `## …`. */
  heading: string;
  /** The whole section, heading included, up to the next `## ` heading. */
  text: string;
}

/** Text before the first `## ` heading stays as it is; the sections follow in order. */
export function splitSections(text: string): { preamble: string; sections: Section[] } {
  const starts = [...text.matchAll(/^## .+$/gm)].map((m) => m.index!);
  if (!starts.length) return { preamble: text, sections: [] };
  const sections = starts.map((start, i) => {
    const body = text.slice(start, starts[i + 1] ?? text.length);
    return { index: i, heading: body.split('\n')[0], text: body };
  });
  return { preamble: text.slice(0, starts[0]), sections };
}

/** Joins sections again; a section that lost its blank line before the next heading gets one. */
export function joinSections(preamble: string, texts: string[]): string {
  return preamble + texts.map((t, i) => (i < texts.length - 1 && !t.endsWith('\n\n') ? `${t.replace(/\n*$/, '')}\n\n` : t)).join('');
}
