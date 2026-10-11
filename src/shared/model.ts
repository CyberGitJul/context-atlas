// Data model shared by server and web UI.

export type Kind =
  | 'instruction'
  | 'rule'
  | 'skill'
  | 'hook'
  | 'mcp'
  | 'plugin'
  | 'agent'
  | 'command'
  | 'output-style'
  | 'setting'
  | 'memory';

/** Kinds that can be created on their own page (#/new/<kind>) with the chat. */
/** The quick actions on a detail page; their labels live in the interface dictionary. */
export type ActionId = 'classify' | 'deterministic' | 'enforce' | 'contradictions' | 'precedence' | 'skillify' | 'align' | 'shorten' | 'stale' | 'testcases' | 'rationale';

export const NEW_KINDS = ['skill', 'rule', 'agent', 'command'] as const;
export type NewKind = (typeof NEW_KINDS)[number];
export const isNewKind = (v: unknown): v is NewKind => (NEW_KINDS as readonly unknown[]).includes(v);

/** When a component influences a session (columns of the overview). */
export type Phase = 'always' | 'session-start' | 'prompt' | 'tool' | 'end' | 'on-demand';

export type Origin =
  | { type: 'user' }
  | { type: 'plugin'; plugin: string }
  | { type: 'live'; via: 'claude.ai' | 'ide' | 'chrome' };

export interface Component {
  id: string;
  kind: Kind;
  name: string;
  origin: Origin;
  phases: Phase[];
  /** File the component comes from (script for hooks), null for live-only sources. */
  sourcePath: string | null;
  enabled: boolean;
  /** Static one-liner: skill description, redacted hook command, … */
  summary: string | null;
  /** Words this component puts into every message (0 if none). */
  contextWords: number;
  /** sha256 over the content an explanation depends on. */
  hash: string;
  detail: Record<string, string | number | boolean | string[]>;
}

export interface Hint {
  id: string;
  severity: 'warn' | 'info';
  text: string;
  componentIds: string[];
}

export interface Explanation {
  hash: string;
  /** Short readable name (useful for inline hook commands). */
  title: string;
  summary: string;
  injects: string | null;
  at: string;
  /** Model the router reports for this answer. */
  model?: string;
}

export interface AiState {
  enabled: boolean;
  /** Name of the AI provider in use (Agent SDK, Anthropic-API, KI-Router). */
  provider?: string | null;
  /** Why AI is off, when it is. */
  off?: string | null;
  pending: number;
  running: boolean;
  /** Number of distinct components whose explanation failed (retried on the next page load). */
  failed: number;
  failedHashes: string[];
}

export interface Overview {
  scannedAt: string;
  components: Component[];
  hints: Hint[];
  explanations: Record<string, Explanation>;
  ai: AiState;
}

export const PHASES: { id: Phase; label: string }[] = [
  { id: 'always', label: 'Immer im Kontext' },
  { id: 'session-start', label: 'Session-Start' },
  { id: 'prompt', label: 'Jede Nachricht' },
  { id: 'tool', label: 'Rund um Tool-Aufrufe' },
  { id: 'end', label: 'Ende / Kompaktierung' },
  { id: 'on-demand', label: 'Bei Bedarf' },
];

/** A text component as the editor sees it. */
export interface ComponentText {
  component: Component;
  text: string;
  editable: boolean;
  readOnlyReason: string | null;
  /** File that is read and written (after resolving symlinks). */
  file: string | null;
  /** Secret-like values found: AI actions are blocked for this text. */
  hasSecrets: boolean;
  /** The file lives in ~/.claude and is committed there on save. */
  inRepo: boolean;
}
