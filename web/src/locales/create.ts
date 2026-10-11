import type { NewKind } from '../../../src/shared/model';
import type { RiskyWhy } from '../../../src/shared/risky-lines';

/** Interface texts of the Create pages and proposed files: NewPage.tsx, FilePage.tsx and the chat hints per kind. */
interface NewKindCopy {
  title: string;
  lede: string;
  steps: [string, string, string];
  /** Heading of the list of own components of this kind. */
  own: string;
  none: string;
  /** Plural for "… from plugins". */
  plural: string;
  /** First hint in the empty chat. */
  chat: string;
}

const review = '“Open in comparison” shows the file with a fixed check; “Create” writes it and commits.';

const kinds: Record<NewKind, NewKindCopy> = {
  skill: {
    title: 'Create a new skill',
    lede: 'Only a skill’s name and description are always in context; Claude loads its content when the description fits the task. Here it takes shape in a conversation with Opus, and nothing is created until you have checked it.',
    steps: [
      'In the chat on the right, describe when Claude should use the skill and what should happen then.',
      'Opus checks against your existing skills and your CLAUDE.md, asks if something is missing, and suggests extending one if the topic already exists.',
      'The SKILL.md arrives as a proposed file. “Open in comparison” shows it with a check of name and description; “Create” makes the folder and commits.',
    ],
    own: 'Your skills',
    none: 'No skills of your own yet.',
    plural: 'skills',
    chat: 'Describe the skill: when should Claude use it, and what should happen then? Opus checks against your existing skills and your CLAUDE.md, asks if something is missing, and returns the SKILL.md as a proposed file.',
  },
  rule: {
    title: 'Create a new rule',
    lede: 'A rule is its own file in ~/.claude/rules and works like a section of your CLAUDE.md: Claude reads it with every message. With `paths` in the header it applies only to matching files. Nothing is created until you have checked it.',
    steps: [
      'In the chat on the right, describe what Claude should follow: always, or only for certain files.',
      'Opus checks against your CLAUDE.md, rules and skills, and suggests adding to one if the topic already exists. Procedures for single tasks belong in a skill instead.',
      `The rule arrives as a proposed file. ${review}`,
    ],
    own: 'Your rules',
    none: 'No rules of your own yet.',
    plural: 'rules',
    chat: 'Describe the rule: what should Claude follow, always or only for certain files? Opus checks against your CLAUDE.md, rules and skills, and returns the file as a proposal.',
  },
  agent: {
    title: 'Create a new subagent',
    lede: 'A subagent handles a subtask in its own context and returns only its result. Claude always sees its name and description and starts it based on them. Nothing is created until you have checked it.',
    steps: [
      'In the chat on the right, describe which subtask it takes on, when Claude should start it and what it returns.',
      'Opus checks against your subagents and skills, clarifies tools and model, and tells you if a skill fits better.',
      `The subagent arrives as a proposed file. ${review}`,
    ],
    own: 'Your subagents',
    none: 'No subagents of your own yet.',
    plural: 'subagents',
    chat: 'Describe the subagent: which subtask does it take on, and when should Claude start it? Opus checks against your subagents and skills, and returns the file as a proposal.',
  },
  command: {
    title: 'Create a new slash command',
    lede: 'A slash command is a saved task you call with /name; whatever you type after it ends up in $ARGUMENTS. Skills are also called with /name. Nothing is created until you have checked it.',
    steps: [
      'In the chat on the right, describe what the command should do and what input it takes.',
      'Opus checks against your commands and skills, and suggests a skill if Claude should recognise the task without being called.',
      `The command arrives as a proposed file. ${review}`,
    ],
    own: 'Your commands',
    none: 'No commands of your own yet.',
    plural: 'commands',
    chat: 'Describe the command: what should /name do, and what input does it take? Opus checks against your commands and skills, and returns the file as a proposal.',
  },
};

export const create = {
  /** Shared closing sentence of the third step of rules, subagents and commands. */
  review,
  /** Wording of the pages for creating something new (#/new/<kind>), shared by the page, the overview and the chat. */
  kinds,
  page: {
    back: 'Back to overview',
    how: 'How it works',
    openChat: 'Open chat',
    loading: 'Loading …',
    off: '(switched off)',
    fromPlugins: (n: number, plural: string) => `Plus ${n} ${plural} from plugins; Opus knows all of them by description.`,
  },
  file: {
    pageName: (path: string) => `File ${path}`,
    backTo: (name: string) => `Back to “${name}”`,
    backOverview: 'Back to overview',
    loading: 'Loading …',
    existingProposed: 'Existing file, proposed in the chat.',
    newProposed: 'New file, created when you save it. Proposed in the chat.',
    inRepo: 'It is in ~/.claude: backup and commit.',
    outsideRepo: 'It is outside ~/.claude: backup, no commit.',
    riskyIntro: 'These lines in the proposal run something or grant permissions:',
    riskyLine: (line: number, why: string) => `Line ${line}, ${why}: `,
    /** Why a line is risky, by the code from `riskyLines`. */
    riskyWhy: {
      'runs-command': 'runs a command when loaded',
      'allows-tools': 'allows tools without asking',
      'attaches-hooks': 'attaches hooks',
      'changes-permission-mode': 'changes the permission mode',
      'hidden-direction-marks': 'contains hidden direction marks',
    } satisfies Record<RiskyWhy, string>,
    fixBeforeSave: 'To fix before saving:',
    fixBeforeCreate: 'To fix before creating:',
    reload: 'Reload',
    textLabel: 'Text',
    fixFirst: 'Fix the points above first (keep editing).',
    saving: 'Saving …',
    save: 'Save',
    create: 'Create',
    keepEditing: 'Keep editing',
    unsaved: 'Changes not saved yet.',
    notCreated: 'Not created yet.',
    unchanged: 'Unchanged.',
    editorLabel: (path: string) => `Text of ${path}`,
    reviewChanges: 'Review changes',
    discard: 'Discard',
    serverDown: 'The server cannot be reached. Nothing was saved; your draft is kept.',
    conflict: 'Conflict',
    saved: 'Saved.',
    created: 'Created.',
    commit: (hash: string) => `Commit ${hash}.`,
    noCommit: 'It is outside ~/.claude, so there is no commit.',
    backup: (path: string) => `Backup: ${path}`,
    reloadFailed: (reason: string) => `Reloading no longer works: ${reason}`,
  },
};
