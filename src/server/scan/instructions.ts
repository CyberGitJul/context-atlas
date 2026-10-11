import path from 'node:path';
import type { Component } from '../../shared/model.js';
import { skillPointers } from '../../shared/skill-links.js';
import { firstLine, listDir, parseFrontmatter, readText, sha256, wordCount, type ScanContext } from './context.js';

/** `@path` imports in a CLAUDE.md (outside code spans). */
export function parseImports(text: string): string[] {
  return [...text.matchAll(/(?:^|\s)@([~./\w-][^\s`]*)/g)].map((m) => m[1]);
}

/** Pointers to skills (`Procedure: skill \`name\``, older `Ablauf: Skill \`name\``), stored only when present. */
function withPointers(detail: Component['detail'], text: string): Component['detail'] {
  const pointers = skillPointers(text);
  return pointers.length ? { ...detail, skillPointers: pointers } : detail;
}

async function claudeMdSections(ctx: ScanContext): Promise<Component[]> {
  const file = path.join(ctx.claudeDir, 'CLAUDE.md');
  const text = await readText(file);
  if (text === null) return [];
  const headings = [...text.matchAll(/^## (.+)$/gm)];
  return headings.map((h, i) => {
    const end = i + 1 < headings.length ? headings[i + 1].index : text.length;
    const section = text.slice(h.index, end).trim();
    return {
      id: `instruction:user:CLAUDE.md#${i}`,
      kind: 'instruction',
      name: h[1].trim(),
      origin: { type: 'user' },
      phases: ['always'],
      sourcePath: file,
      enabled: true,
      summary: firstLine(section.slice(h[0].length)),
      contextWords: wordCount(section),
      hash: sha256(section),
      detail: withPointers({ file: 'CLAUDE.md', index: i }, section),
    } satisfies Component;
  });
}

async function listMarkdown(dir: string, rel = ''): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await listDir(path.join(dir, rel))) {
    const r = path.join(rel, entry);
    if (entry.endsWith('.md')) out.push(r);
    else out.push(...(await listMarkdown(dir, r)));
  }
  return out;
}

async function rules(ctx: ScanContext): Promise<Component[]> {
  const dir = path.join(ctx.claudeDir, 'rules');
  const out: Component[] = [];
  for (const rel of await listMarkdown(dir)) {
    const file = path.join(dir, rel);
    const text = (await readText(file)) ?? '';
    const { data, body } = parseFrontmatter(text);
    const paths = typeof data.paths === 'string' ? [data.paths] : Array.isArray(data.paths) ? data.paths.map(String) : [];
    out.push({
      id: `rule:user:${rel}`,
      kind: 'rule',
      name: rel,
      origin: { type: 'user' },
      phases: [paths.length ? 'on-demand' : 'always'],
      sourcePath: file,
      enabled: true,
      summary: firstLine(body),
      contextWords: paths.length ? 0 : wordCount(body),
      hash: sha256(text),
      detail: withPointers(paths.length ? { paths } : {}, body),
    });
  }
  return out;
}

export async function scanInstructions(ctx: ScanContext): Promise<Component[]> {
  return [...(await claudeMdSections(ctx)), ...(await rules(ctx))];
}
