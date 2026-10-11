import type { Component } from './model.js';

/**
 * An instruction that moved its procedure into a skill keeps exactly this line: `Procedure: skill \`name\``.
 * The older German form `Ablauf: Skill \`name\`` still counts and is kept as written.
 * Only these fixed forms count as "belongs to"; a skill that is merely mentioned is no link.
 */
const POINTER_FORMS = ['Procedure: skill', 'Ablauf: Skill'] as const;
export type PointerForm = (typeof POINTER_FORMS)[number];
const POINTER_RE = new RegExp(`(${POINTER_FORMS.join('|')}) \`([^\`\\s]+)\``, 'g');

/** Fenced code blocks are examples, not links (``` or ~~~, closed by the same or a longer fence). */
const FENCED_RE = /^[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n[ \t]*\1[`~]*[ \t]*(?=\n|(?![\s\S]))|(?![\s\S]))/gm;

function pointerMatches(text: string): { form: PointerForm; name: string }[] {
  return [...text.replace(FENCED_RE, '').matchAll(POINTER_RE)].map((m) => ({ form: m[1] as PointerForm, name: m[2] }));
}

export function skillPointers(text: string): string[] {
  return [...new Set(pointerMatches(text).map((m) => m.name))];
}

/** The form the text uses for `name`, else for any pointer, else the English one: a German file stays German. */
export function pointerForm(text: string, name?: string): PointerForm {
  const matches = pointerMatches(text);
  return (matches.find((m) => m.name === name) ?? matches[0])?.form ?? POINTER_FORMS[0];
}

export function pointerLine(name: string, form: PointerForm = POINTER_FORMS[0]): string {
  return `${form} \`${name}\`.`;
}

export function retargetPointer(text: string, from: string, to: string): string {
  return POINTER_FORMS.reduce((t, form) => t.replaceAll(`${form} \`${from}\``, `${form} \`${to}\``), text);
}

/** Makes sure the text points to `name`: keeps it, follows a rename of `previous`, or appends the line. */
export function ensurePointer(text: string, name: string, previous?: string, form: PointerForm = pointerForm(text)): string {
  const pointers = skillPointers(text);
  if (pointers.includes(name)) return text;
  if (previous && pointers.includes(previous)) return retargetPointer(text, previous, name);
  const trailing = text.match(/\s*$/)![0];
  return `${text.slice(0, text.length - trailing.length)}\n\n${pointerLine(name, form)}${trailing.includes('\n') ? '\n' : ''}`;
}

/** After "Convert to skill": the remaining text points to `name` only (the section had no pointer before). */
export function pointOnlyTo(text: string, name: string): string {
  const others = skillPointers(text).filter((p) => p !== name);
  return ensurePointer(others.reduce((t, p) => retargetPointer(t, p, name), text), name);
}

/**
 * Pointers a proposal dropped are appended again: the link is only cut on purpose, never as a side effect
 * of shortening or rephrasing. Returns the names that were restored.
 */
export function keepPointers(before: string, after: string): { text: string; restored: string[] } {
  const restored = skillPointers(before).filter((p) => !skillPointers(after).includes(p));
  return { text: restored.reduce((t, p) => ensurePointer(t, p, undefined, pointerForm(before, p)), after), restored };
}

export type LinkState = 'ok' | 'disabled' | 'missing';

export interface SkillLink {
  name: string;
  /** missing: no skill with this name; disabled: it exists but Claude does not load it. */
  state: LinkState;
  skillId: string | null;
  /** For a broken pointer: the skill whose recorded source is this section (e.g. after a rename). */
  suggestion?: string | null;
}

/** Frontmatter `metadata` key in which a skill records the section it came from. */
export const SOURCE_KEY = 'atlas-source';
/** Written by the app under its former name; still read, never written. */
export const LEGACY_SOURCE_KEY = 'lce-source';

/** Stable name of an instruction or rule for the back-reference; the heading, not the position. */
export function sourceKeyOf(c: Component): string | null {
  if (c.kind === 'instruction' && c.detail.file === 'CLAUDE.md') return `CLAUDE.md#${c.name}`;
  if (c.kind === 'rule') return `rules/${c.name}`;
  return null;
}

/** Sections that point to a skill, and for a skill the sections pointing to it (detail page). */
export interface ComponentLinks {
  pointers: SkillLink[];
  referencedBy: { id: string; name: string }[];
  /** Enabled skills whose `atlas-source` names this section: it was converted already. */
  sourcedBy: { id: string; name: string }[];
  /** Skills a broken pointer can be corrected to; only sent when a pointer is broken. */
  choices: string[];
}

/** Claude Code names plugin skills `plugin:skill`; the installed id carries `@marketplace`, which is not part of it. */
const skillNames = (c: Component) => (c.origin.type === 'plugin' ? [c.name, `${c.origin.plugin.split('@')[0]}:${c.name}`] : [c.name]);
/** The name a pointer should use: plugin skills qualified, own skills plain. */
const pointerName = (c: Component) => skillNames(c).at(-1)!;

export function resolveLinks(pointers: string[], components: Component[]): SkillLink[] {
  const skills = components.filter((c) => c.kind === 'skill');
  return pointers.map((name) => {
    const matches = skills.filter((s) => skillNames(s).includes(name));
    const hit = matches.find((s) => s.enabled) ?? matches[0];
    return { name, state: !hit ? 'missing' : hit.enabled ? 'ok' : 'disabled', skillId: hit?.id ?? null };
  });
}

/** Pointers stored by the scanner on instructions and rules. */
export function pointersOf(c: Component): string[] {
  const p = c.detail.skillPointers;
  return Array.isArray(p) ? p : [];
}

export function linksFor(c: Component, components: Component[]): ComponentLinks {
  const key = sourceKeyOf(c);
  const sourced = key ? components.filter((s) => s.kind === 'skill' && s.enabled && s.detail.source === key) : [];
  const origin = sourced[0];
  const pointers = resolveLinks(pointersOf(c), components).map((l) => (l.state === 'ok' ? l : { ...l, suggestion: origin ? pointerName(origin) : null }));
  const referencedBy =
    c.kind === 'skill'
      ? components.filter((o) => resolveLinks(pointersOf(o), components).some((l) => l.skillId === c.id)).map((o) => ({ id: o.id, name: o.name }))
      : [];
  const choices = pointers.some((l) => l.state !== 'ok')
    ? components.filter((s) => s.kind === 'skill' && s.enabled).map(pointerName).sort()
    : [];
  return { pointers, referencedBy, sourcedBy: sourced.map((s) => ({ id: s.id, name: pointerName(s) })), choices };
}

/** Why converting a section into a skill is blocked: a code plus the skill names, worded by the server or the interface. */
export interface SkillifyBlock {
  /** moved: the draft already has a pointer; saved: the saved text has a working one; sourced: a skill names this section as its source. */
  code: 'moved' | 'saved' | 'sourced';
  names: string[];
}

/**
 * Why "Convert to skill" must not run (again) for this section, or null. Checked on the client and the server:
 * a pointer in the editor, a saved pointer that works, or a skill that names this section as its source.
 */
export function skillifyBlock(draft: string, links: Pick<ComponentLinks, 'pointers' | 'sourcedBy'>): SkillifyBlock | null {
  const inDraft = skillPointers(draft);
  if (inDraft.length) return { code: 'moved', names: inDraft };
  const saved = links.pointers.filter((l) => l.state === 'ok').map((l) => l.name);
  if (saved.length) return { code: 'saved', names: saved };
  if (links.sourcedBy.length) return { code: 'sourced', names: links.sourcedBy.map((s) => s.name) };
  return null;
}
