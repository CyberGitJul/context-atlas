/** A CLAUDE.md or rule file in `## ` sections, as the server checks it and the page puts it back together. */

export interface Section {
  index: number;
  /** First line, `## …`; a rule file without sections has its first line here if that is a heading, else ''. */
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

/**
 * A rule file in sections: the frontmatter (and any text before the first `## `) stays as it is. Without `## `
 * headings the body is one section; its heading is the first line if that is a heading, else empty.
 */
export function splitRuleSections(text: string): { preamble: string; sections: Section[] } {
  const frontmatter = text.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/)?.[0] ?? '';
  const head = frontmatter + (text.slice(frontmatter.length).match(/^\s*/)?.[0] ?? '');
  const body = text.slice(head.length);
  const split = splitSections(body);
  if (split.sections.length) return { preamble: head + split.preamble, sections: split.sections };
  if (!body.trim()) return { preamble: text, sections: [] };
  const first = body.split('\n')[0];
  return { preamble: head, sections: [{ index: 0, heading: /^#{1,6} \S/.test(first) ? first : '', text: body }] };
}

/** Joins sections again; a section that lost its blank line before the next heading gets one. */
export function joinSections(preamble: string, texts: string[]): string {
  return preamble + texts.map((t, i) => (i < texts.length - 1 && !t.endsWith('\n\n') ? `${t.replace(/\n*$/, '')}\n\n` : t)).join('');
}
