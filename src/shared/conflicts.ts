// Conflicts between the user's own instructions and plugin skills, shared by server and web UI.

export type ConflictType = 'contradiction' | 'tension' | 'duplicate';
export type ConflictSeverity = 'high' | 'medium' | 'low';
/** Who settles a finding according to the model: an own sentence, the skill itself, or nobody. */
export type Precedence = 'explicit-own' | 'explicit-skill' | 'none';

export interface ConflictFinding {
  key: string;
  /** The own rule, by `sourceKeyOf`: `CLAUDE.md#<heading>` or `rules/<file>`. */
  ownKey: string;
  skillId: string;
  /** As Claude Code names it, e.g. "superpowers:brainstorming". */
  skillName: string;
  type: ConflictType;
  severity: ConflictSeverity;
  title: string;
  quoteOwn: string;
  quoteSkill: string;
  situation: string;
  whoWinsToday: string;
  state: 'new' | 'deliberate';
  /** Deliberate: an own sentence settles it, or the skill gives way at exactly this point. */
  settledBy: 'own' | 'skill' | null;
  precedenceQuote: string | null;
  firstSeen: string;
  lastConfirmed: string;
  /** The latest check of its pair did not report it, but both quotes are still there. */
  unconfirmed: boolean;
  /** The quoted skill passage changed on this date and the own sentence still covers it. */
  skillChangedAt: string | null;
}

/** All open findings of one own rule. */
export interface ConflictTheme {
  ownKey: string;
  /** Section heading or rules/<file>; the key itself when the rule is gone. */
  ownName: string;
  /** Component id for the link, null when the rule no longer exists. */
  ownId: string | null;
  /** Only `low` findings: listed under "Minor". */
  minor: boolean;
  findings: ConflictFinding[];
}

/** Deliberate findings settled by the same sentence. */
export interface DeliberateGroup {
  settledBy: 'own' | 'skill';
  quote: string;
  findings: ConflictFinding[];
}

export interface ConflictsView {
  themes: ConflictTheme[];
  deliberate: DeliberateGroup[];
  progress: { total: number; upToDate: number; running: string | null; failed: string[]; lastCheck: string | null };
  /** No AI provider: stored results only, nothing is checked. */
  aiOff: boolean;
}

/** Who wins for one skill of a theme: the own rule or the skill. */
export type Winner = 'own' | 'skill';

/** A precedence sentence written into the rule, for review before it is saved. */
export interface DecideProposal {
  ownId: string;
  ownName: string;
  /** ~/… path of the file the rule lives in. */
  file: string | null;
  before: string;
  after: string;
  changes: string[];
  /** Pointer lines the proposal dropped and the app put back. */
  restored: string[];
  /** Words added to the instructions (negative when shorter). */
  wordsDelta: number;
  model: string;
}
