/** Byte range of the `## ` section with this index in a CLAUDE.md; null if the heading no longer matches. */
export function sectionBounds(text: string, index: number, heading: string): { start: number; end: number } | null {
  const headings = [...text.matchAll(/^## (.+)$/gm)];
  const h = headings[index];
  if (!h || h[1].trim() !== heading) return null;
  const end = index + 1 < headings.length ? headings[index + 1].index! : text.length;
  return { start: h.index!, end };
}
