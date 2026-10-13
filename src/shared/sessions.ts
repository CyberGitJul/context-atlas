/**
 * The session timeline (slice 7, debugger): what came in (your messages, loaded instructions, hook texts, skill
 * bodies) and what Claude did (tool calls, answers), read from a Claude Code session jsonl. Nothing is written.
 */

/** `prompt` your message; `instructions` loaded files and lists; `hook` text a hook added; `skill` a skill body that was loaded; `tool` and `answer` what Claude did; `notice` commands, notifications, compaction. */
export type StepKind = 'prompt' | 'instructions' | 'hook' | 'skill' | 'tool' | 'answer' | 'notice';

/** Steps that brought text into Claude's context, as opposed to Claude's own actions. */
export const INCOMING: ReadonlySet<StepKind> = new Set(['prompt', 'instructions', 'hook', 'skill', 'notice']);

export interface TimelineStep {
  /** Position in the timeline; the detail endpoint takes it. */
  i: number;
  at: string;
  kind: StepKind;
  title: string;
  /** First line or two of the text, already masked. */
  preview: string;
  /** Length of the full text, so the page can say how much is behind a click. */
  chars: number;
  /** Tool name for `tool` steps. */
  tool?: string;
  /** The tool failed, or a hook blocked. */
  error?: boolean;
}

export interface SessionSummary {
  /** Folder name under ~/.claude/projects. */
  project: string;
  /** Working folder of the session (from the transcript), with ~ for the home folder. */
  cwd: string | null;
  id: string;
  title: string;
  modified: string;
  bytes: number;
}

export interface SessionTimeline {
  session: SessionSummary;
  steps: TimelineStep[];
  /** An AI provider is set up, so "Why?" can explain Claude's steps. */
  ai: boolean;
}

/** Steps "Why?" explains: what Claude did. */
export const EXPLAINABLE: ReadonlySet<StepKind> = new Set(['tool', 'answer']);

/** One instruction the assessment points to, with the quote checked against its source. */
export interface WhyItem {
  source: string;
  quote: string;
  /** How it shaped the action, or why it was not followed. */
  note: string;
  quoteFound: boolean;
}

/** "Why?" for one of Claude's steps: which instructions steered it and which applied but were not followed. */
export interface WhyResult {
  verdict: string;
  steered: WhyItem[];
  ignored: WhyItem[];
  /** How many texts went to the model as sources. */
  sources: number;
  model: string;
}

export interface StepDetail {
  i: number;
  text: string;
  /** The text was longer than the page shows. */
  cut: boolean;
}

/** A passage the replay can leave out: one `## ` section of an instruction file that was in effect at the step. */
export interface ReplaySection {
  id: string;
  /** The file, with ~ for the home folder. */
  file: string;
  heading: string;
  chars: number;
}

/** What the replay page needs before a run: the passages to choose from and how big the context is. */
export interface ReplayOptions {
  sections: ReplaySection[];
  /** Tokens Claude had in context at this step (from the session), so the page can say what a run costs. */
  tokens: number | null;
  /** Why replay cannot run here (no Agent SDK, folder gone); null when it can. */
  off: string | null;
}

/** One thing Claude did in its response: a tool call (title like the timeline's, input as text) or an answer. */
export interface ReplayAction {
  kind: 'tool' | 'answer';
  title: string;
  text: string;
  tool?: string;
}

/** The step as it happened, Claude's step again from the same context, and once more without the chosen passage. */
export interface ReplayResult {
  original: ReplayAction[];
  asIs: ReplayAction[];
  changed: ReplayAction[];
  section: ReplaySection;
  model: string;
  ms: number;
}
