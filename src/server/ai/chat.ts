import path from 'node:path';
import { stepOf } from '../../shared/flow.js';
import type { Component, Explanation, Hint, Kind, NewKind } from '../../shared/model.js';
import type { ComponentLinks } from '../../shared/skill-links.js';
import { redact } from '../redact.js';
import { truncate } from '../scan/context.js';
import { PERSONAL_ADDITION, personalAddition, readPrompt, withAddition, type PromptDirs, type PromptSource } from './prompts.js';

/** Areas with their own chat prompt; `other` also covers everything without an own area yet. */
export const CHAT_AREAS = {
  overview: 'Overview',
  instruction: 'Optimize instruction',
  skill: 'Optimize skill',
  hook: 'Review hook',
  memory: 'Review memory',
  agent: 'Agent, command, output style',
  other: 'Other & third-party components',
  'new-skill': 'Create new skill',
  'new-rule': 'Create new rule',
  'new-agent': 'Create new subagent',
  'new-command': 'Create new slash command',
} as const satisfies Record<`new-${NewKind}`, string> & Record<string, string>;
export type ChatArea = keyof typeof CHAT_AREAS;

/** The shared base prompt, prepended in every area. */
export const BASE_PROMPT = '_base';
/** The personal addition (prompts.ts), editable in the chat like the other prompts. */
export const PERSONAL_PROMPT = '_personal';
export type ChatPromptFile = ChatArea | typeof BASE_PROMPT | typeof PERSONAL_PROMPT;

export function isChatPromptFile(v: unknown): v is ChatPromptFile {
  return v === BASE_PROMPT || v === PERSONAL_PROMPT || (typeof v === 'string' && Object.hasOwn(CHAT_AREAS, v));
}

/** Path of a chat prompt below the prompts folder of either layer; the personal addition is shared with the actions. */
export function chatPromptRel(file: ChatPromptFile): string {
  return file === PERSONAL_PROMPT ? PERSONAL_ADDITION : `chat/${file}.md`;
}

const AGENT_KINDS: Kind[] = ['agent', 'command', 'output-style'];

export function areaFor(c: Component | null, editable: boolean): ChatArea {
  if (!c) return 'overview';
  if (editable && (c.kind === 'instruction' || c.kind === 'rule')) return 'instruction';
  if (editable && c.kind === 'skill') return 'skill';
  // These areas review as much as they edit, so read-only ones (from a plugin, inline in settings.json) belong there too.
  if (c.kind === 'hook') return 'hook';
  if (c.kind === 'memory') return 'memory';
  if (AGENT_KINDS.includes(c.kind)) return 'agent';
  return 'other';
}

/** Area of a file proposed in the chat: a SKILL.md anywhere, the rest by where it lives in ~/.claude. */
export function areaForFile(abs: string, claudeDir: string): ChatArea {
  // A SKILL.md being created or refined is a skill to optimise, whatever page it came from.
  if (/\/skills\/[^/]+\/SKILL\.md$/.test(abs)) return 'skill';
  const rel = path.relative(claudeDir, abs).split(path.sep).join('/');
  if (/^(agents|commands|output-styles)\/.+\.md$/.test(rel)) return 'agent';
  if (/^hooks\/[^/]+$/.test(rel)) return 'hook';
  return 'other';
}

export const KIND: Record<Kind, string> = {
  instruction: 'Instruction (CLAUDE.md)',
  rule: 'Rule',
  skill: 'Skill',
  hook: 'Hook',
  mcp: 'MCP server',
  plugin: 'Plugin',
  agent: 'Subagent',
  command: 'Slash command',
  'output-style': 'Output style',
  setting: 'Setting',
  memory: 'Memory note',
};

/** A linked text is sent in full up to this size (a SKILL.md is usually far below). */
export const LINKED_LIMIT = 30_000;

export const origin = (c: Component) => (c.origin.type === 'plugin' ? `Plugin ${c.origin.plugin}` : c.origin.type === 'live' ? 'live only' : 'own');
const when = (c: Component) => stepOf(c)?.label ?? (c.phases.includes('always') ? 'always in context' : 'no fixed point in time');

/** One line per component: what it is, where it comes from, when it acts, what it costs. */
function line(c: Component, explanations: Record<string, Explanation>): string {
  const about = explanations[c.hash]?.summary ?? c.summary;
  const facts = [origin(c), when(c), c.enabled ? null : 'disabled', c.contextWords ? `${c.contextWords} words in context` : null].filter(Boolean).join('; ');
  return `- ${KIND[c.kind]} “${redact(c.name)}” (${facts})${about ? `: ${truncate(redact(about), 200)}` : ''}`;
}

export interface OverviewPage {
  components: Component[];
  hints: Hint[];
  explanations: Record<string, Explanation>;
}

export function overviewContext(p: OverviewPage): string {
  const hints = p.hints.map((h) => `- ${h.severity === 'warn' ? 'Warning' : 'Info'}: ${redact(h.text)}`);
  return [
    'Page: overview of all components.',
    '',
    'Hint bar:',
    ...(hints.length ? hints : ['- none']),
    '',
    `Components (${p.components.length}):`,
    ...p.components.map((c) => line(c, p.explanations)),
  ].join('\n');
}

/** Long enough for any real description (the spec allows 1024 characters), short enough for 50+ skills. */
const DESCRIPTION_LIMIT = 700;

/** What the chat writes on a new-page and where it goes. */
const NEW_FILE: Record<NewKind, { what: string; where: string }> = {
  skill: { what: 'the new SKILL.md (and further files in the skill folder) go', where: '~/.claude/skills/<name>/SKILL.md. Plugin skills cannot be changed here.' },
  rule: { what: 'the new rule goes', where: '~/.claude/rules/<name>.md. It loads with every message like the CLAUDE.md; with `paths` in the header only for matching files.' },
  agent: { what: 'the new subagent goes', where: '~/.claude/agents/<name>.md.' },
  command: { what: 'the new slash command goes', where: '~/.claude/commands/<name>.md; the file name is the /name.' },
};

/**
 * Pages for creating something new: what exists of that kind in full, so the model can spot overlaps
 * before it writes (rule "nothing twice"), and the neighbouring kinds in short form.
 */
export function newContext(kind: NewKind, p: OverviewPage): string {
  const of = (kinds: Kind[], all = false) => p.components.filter((c) => kinds.includes(c.kind) && (all || c.enabled)).sort((a, b) => a.name.localeCompare(b.name));
  const described = (c: Component) =>
    `- \`${redact(c.name)}\` (${[origin(c), c.enabled ? null : 'disabled'].filter(Boolean).join('; ')}): ${c.summary ? truncate(redact(c.summary), DESCRIPTION_LIMIT) : 'no description'}`;
  const short = (c: Component) => line(c, p.explanations);
  const SHORT = '(short form; full text with read_component)';
  const CHECK = 'check against it for duplicates:';
  /** The list to check against: always shown, with its count, each entry in full. */
  const existing = (label: string, list: Component[], format = described) => ['', `${label} (${list.length})${format === short ? ` ${SHORT}` : ', with description'} – ${CHECK}`, ...list.map(format)];
  /** Neighbouring kinds: left out when empty. */
  const nearby = (label: string, list: Component[], format = short) => (list.length ? ['', `${label}:`, ...list.map(format)] : []);
  const lists: Record<NewKind, string[]> = {
    skill: [
      ...existing('Existing skills', of(['skill'], true)),
      ...nearby(`Instructions from CLAUDE.md and rules ${SHORT}`, of(['instruction', 'rule'])),
      ...nearby('Agents and commands', of(['agent', 'command'])),
    ],
    rule: [...existing('Instructions and rules', of(['instruction', 'rule'], true), short), ...nearby(`Skills ${SHORT}`, of(['skill']))],
    agent: [
      ...existing('Existing subagents', of(['agent'], true)),
      ...nearby(`Skills ${SHORT}`, of(['skill'])),
      ...nearby('Slash commands', of(['command'])),
    ],
    command: [
      ...existing('Existing slash commands', of(['command'], true)),
      ...nearby('Skills, with description (they are also invoked as /name; equal names clash)', of(['skill'], true), described),
      ...nearby(`Instructions ${SHORT}`, of(['instruction', 'rule'])),
    ],
  };
  return [
    `Page: ${CHAT_AREAS[`new-${kind}`]}. There is no text to edit here; ${NEW_FILE[kind].what} as a \`\`\`\`file block.`,
    'Editable: no (file proposals only).',
    `Target: ${NEW_FILE[kind].where}`,
    ...lists[kind],
  ].join('\n');
}

export interface DetailPage {
  component: Component;
  /** Text as currently in the editor (may hold unsaved changes). */
  text: string;
  savedText: string;
  editable: boolean;
  readOnlyReason: string | null;
  file: string | null;
  links: ComponentLinks;
  hints: Hint[];
  /** Other active components, as one line each (the chat knows the other sources). */
  others: Component[];
  /** Linked counterparts in full: the skill a section points to, or the sections pointing to a skill. */
  linked?: { component: Component; text: string }[];
  explanations: Record<string, Explanation>;
}

function linkLines(l: ComponentLinks): string[] {
  return [
    ...l.pointers.map((p) =>
      p.state === 'ok' ? `- Belongs to skill “${redact(p.name)}” (the procedure is there).` : `- Dangling pointer: skill “${redact(p.name)}” ${p.state === 'missing' ? 'does not exist' : 'is disabled'}.`,
    ),
    ...l.referencedBy.map((r) => `- Pointer from “${redact(r.name)}”: this instruction moves its procedure into this skill.`),
  ];
}

/** Facts only some kinds have: what a hook runs on and beside which other hooks, which project a memory belongs to. */
function kindLines(p: DetailPage): string[] {
  const c = p.component;
  if (c.kind === 'memory') {
    return ['', `Memory of project “${redact(c.name)}”: MEMORY.md is in context in every session of this project, Claude reads the individual notes when needed.`];
  }
  if (c.kind !== 'hook') return [];
  const d = c.detail;
  const event = String(d.event ?? '?');
  const explained = p.explanations[c.hash];
  const siblings = p.others.filter((o) => o.kind === 'hook' && o.id !== c.id && o.detail.event === event);
  const sibling = (o: Component) => {
    const facts = [`Matcher ${o.detail.matcher ?? '*'}`, origin(o), o.enabled ? null : 'disabled'].filter(Boolean).join('; ');
    const about = p.explanations[o.hash]?.summary ?? o.summary;
    return `- “${redact(o.name)}” (${facts})${about ? `: ${truncate(redact(about), 200)}` : ''}`;
  };
  return [
    '',
    'Hook data:',
    `- Event: ${event}, matcher: ${d.matcher ?? '*'}, type: ${d.type ?? 'command'}`,
    `- Command: ${redact(String(d.command ?? c.summary ?? '–'))}`,
    ...(explained ? [`- AI explanation: ${redact(explained.summary)}`] : []),
    ...(explained?.injects ? [`- Injects: ${redact(explained.injects)}`] : []),
    '',
    `Other hooks on ${event}:${siblings.length ? '' : ' none'}`,
    ...siblings.map(sibling),
  ];
}

export function detailContext(p: DetailPage): string {
  const c = p.component;
  const links = linkLines(p.links);
  const hints = p.hints.filter((h) => h.componentIds.includes(c.id)).map((h) => `- ${redact(h.text)}`);
  const linked = p.linked ?? [];
  const shown = new Set([c.id, ...linked.map((l) => l.component.id)]);
  const otherKinds: Kind[] = ['instruction', 'rule', 'skill', ...(AGENT_KINDS.includes(c.kind) ? AGENT_KINDS : ['agent' as const])];
  const others = p.others.filter((o) => !shown.has(o.id) && o.enabled && otherKinds.includes(o.kind));
  // Its text would be the whole settings.json; the command is in the hook facts.
  const inlineHook = c.kind === 'hook' && c.detail.hasScript !== true;
  return [
    `Page: detail page of ${KIND[c.kind]} “${redact(c.name)}” (${origin(c)}).`,
    `File: ${redact(p.file ?? c.sourcePath ?? '–')}`,
    `Acts: ${when(c)}${c.contextWords ? `, ${c.contextWords} words in context` : ''}.`,
    `Editable: ${p.editable ? 'yes' : `no (${p.readOnlyReason ?? 'read-only'})`}.`,
    `Unsaved changes in the editor: ${p.text === p.savedText ? 'no' : 'yes'}.`,
    ...(links.length ? ['', 'Links:', ...links] : []),
    ...(hints.length ? ['', 'Hints on this component:', ...hints] : []),
    ...kindLines(p),
    '',
    ...(inlineHook
      ? ['Text: the command is directly in settings.json (see hook data); the rest of the file is left out here.']
      : ['Text (as currently in the editor):', '<<<', redact(p.text), '>>>']),
    ...(linked.length
      ? [
          '',
          linked.some((l) => l.text.length > LINKED_LIMIT) ? 'Linked components:' : 'Linked components (in full):',
          ...linked.flatMap((l) => {
            // A cut text must never come back as a whole new file: its tail would be lost.
            const cut = l.text.length > LINKED_LIMIT ? ` (cut: ${LINKED_LIMIT} of ${l.text.length} characters; do not rewrite as a whole file)` : '';
            return ['', `### ${KIND[l.component.kind]} “${redact(l.component.name)}” (${origin(l.component)})${cut}`, '<<<', truncate(redact(l.text), LINKED_LIMIT), '>>>'];
          }),
        ]
      : []),
    '',
    'Other active sources (short form; full text with read_component):',
    ...others.map((o) => line(o, p.explanations)),
  ].join('\n');
}

export interface ChatPrompts {
  base: string;
  area: string;
  /** Personal addition, empty when there is none. */
  personal: string;
  /** Which layer each part comes from: the user's own version or the generic one. */
  sources: { base: PromptSource; area: PromptSource; personal: PromptSource };
}

export async function loadChatPrompts(dirs: PromptDirs, area: ChatArea): Promise<ChatPrompts> {
  const [base, own, personal] = await Promise.all([readPrompt(dirs, chatPromptRel(BASE_PROMPT)), readPrompt(dirs, chatPromptRel(area)), personalAddition(dirs)]);
  return { base: base.text, area: own.text, personal: personal.text, sources: { base: base.source, area: own.source, personal: personal.source } };
}

export function assembleSystem(prompts: Pick<ChatPrompts, 'base' | 'area'> & { personal?: string }, area: ChatArea, context: string): string {
  return [withAddition(prompts.base, prompts.personal ?? ''), '', `# Area: ${CHAT_AREAS[area]}`, '', prompts.area.trim(), '', '# Current page', '', context].join('\n');
}

export interface FilePage {
  display: string;
  exists: boolean;
  warning: string | null;
  text: string;
  savedText: string | null;
}

/** A proposed file opened from the chat: a ````proposal block on this page replaces its text. */
export function fileContext(p: FilePage): string {
  return [
    `Page: file ${p.display} (${p.exists ? 'exists' : 'will be created'}), opened from a chat proposal.`,
    'Editable: yes. A ````proposal block replaces the text of this file in the comparison.',
    ...(p.warning ? [`Warning: ${p.warning}`] : []),
    `Unsaved changes in the editor: ${p.text === (p.savedText ?? '') ? 'no' : 'yes'}.`,
    '',
    'Text (as currently in the editor):',
    '<<<',
    redact(p.text),
    '>>>',
  ].join('\n');
}

/** Where a ````file block may point to outside ~/.claude; part of every page's context. */
export function extraFilesLine(extraFiles: string[]): string {
  return `Released single files outside ~/.claude (for \`file\` blocks): ${extraFiles.length ? extraFiles.join(', ') : 'none'}.`;
}
