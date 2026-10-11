/** Interface texts of the Condense page: CondensePage.tsx. */
export const condense = {
  title: 'Condense CLAUDE.md',
  back: 'Back to overview',
  lede: 'Your global CLAUDE.md goes to Claude in full with every message. Opus proposes a shorter version of each section, in full sentences rather than telegram style, and cuts boldly. Fixed checks without AI watch headings, pointer lines, code, paths, numbers, negations and mandatory words; a rule test checks rule by rule what was kept. A reviewer puts back what got lost, then the sections are tested again. You choose the sections; saving makes a backup and a commit.',
  start: 'Create proposal',
  startNote: 'Up to four AI passes in a row; this takes a few minutes.',
  steps: {
    proposing: 'Step 1 of 4: Opus condenses all sections',
    testing: 'Step 2 of 4: rule test, Opus checks every rule in the new text',
    repairing: 'Step 3 of 4: reviewer puts lost and weakened rules back',
    retesting: 'Step 4 of 4: rule test of the repaired sections',
  },
  /** The waiting line: the current step and the seconds it has been running. */
  waiting: (step: string, seconds: number) => `${step} … ${seconds} s`,
  /** Display labels of the rule statuses; the keys are the values the server sends. */
  status: { kept: 'kept', weakened: 'weakened', lost: 'lost', ambiguous: 'ambiguous', new: 'newly added' },
  ruleTestFailed: (message: string) => `The rule test failed (${message}). Without it, you apply sections on your own check.`,
  reviewFailed: (message: string) => `The reviewer pass failed (${message}). Sections with a finding or without a rule test are not preselected.`,
  summaryLabel: 'Summary',
  words: (before: number, after: number) => `${before} → ${after} words`,
  /** The rest of the total line; `delta` is the saved words with sign, or ±0. */
  totalRest: (delta: string, chosen: number, changed: number) => `(${delta}) with ${chosen} of ${changed} changed sections.`,
  saving: 'Saving …',
  apply: (n: number) => `Apply ${n} ${n === 1 ? 'section' : 'sections'}`,
  newProposal: 'New proposal',
  saved: (n: number, words: number) => `${n} ${n === 1 ? 'section' : 'sections'} applied, CLAUDE.md now has ${words} words.`,
  commit: (hash: string) => `Commit ${hash}.`,
  backup: (path: string) => `Backup: ${path}`,
  testRunning: 'Rule test running …',
  noTest: 'No rule test.',
  testResult: (kept: number, total: number, flagged: number) => `Rule test: ${kept} of ${total} rules kept${flagged ? `, ${flagged} with a finding` : ''}.`,
  reviewed: 'Improved by the reviewer:',
  compare: 'Comparison',
  outsourceLabel: 'Move out',
  outsourceTitle: 'Move out (text unchanged)',
  newTab: '(opens in a new tab)',
};
