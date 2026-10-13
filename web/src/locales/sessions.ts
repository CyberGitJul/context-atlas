import type { StepKind } from '../../../src/shared/sessions';

/** Interface texts of the session timeline (#/sessions): what came into Claude's context and what Claude did. */
export const sessions = {
  title: 'Sessions',
  lede: 'What came into Claude’s context during a session, and what Claude did with it. Read from the session files in ~/.claude/projects; nothing is changed.',
  back: 'Back to overview',
  loading: 'Reading sessions …',
  loadError: (message: string) => `The sessions could not be loaded (${message}).`,
  none: 'No sessions found in ~/.claude/projects.',
  latest: (n: number) => `The ${n} most recent sessions, newest first.`,
  unknownFolder: 'Unknown folder',
  when: (iso: string) => new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }),
  size: (bytes: number) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`),
  timeline: {
    loading: 'Reading the session …',
    about: (cwd: string | null, when: string, steps: number) => `${cwd ? `In ${cwd}, ` : ''}last change ${when}. ${steps} steps.`,
    filter: 'Show',
    filters: { all: 'Everything', incoming: 'What came in', claude: 'What Claude did' },
    shown: (n: number, total: number) => (n === total ? `${n} steps` : `${n} of ${total} steps`),
    lanes: { prompt: 'You', instructions: 'Instructions', hook: 'Hook', skill: 'Skill text', tool: 'Claude: tool', answer: 'Claude: answer', notice: 'System' } satisfies Record<StepKind, string>,
    failed: 'failed',
    chars: (n: number) => `${n.toLocaleString()} characters`,
    loadingStep: 'Loading the text …',
    stepError: (message: string) => `The text could not be loaded (${message}).`,
    cut: 'The text is longer; only the first 100,000 characters are shown.',
  },
};
