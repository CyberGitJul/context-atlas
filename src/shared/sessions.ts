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
}

export interface StepDetail {
  i: number;
  text: string;
  /** The text was longer than the page shows. */
  cut: boolean;
}
