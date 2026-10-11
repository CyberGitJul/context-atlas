/** Why a line is risky; a code, worded by the interface (this file also runs in the browser). */
export type RiskyWhy = 'runs-command' | 'allows-tools' | 'attaches-hooks' | 'changes-permission-mode' | 'hidden-direction-marks';

/** Lines of a proposed file that make Claude run something or allow something without asking. */
const RISKY: { re: RegExp; why: RiskyWhy }[] = [
  // !`cmd` runs a command when the skill or command loads; `!` written as inline code is just text.
  { re: /(?<!`)!`[^`\n]+`/, why: 'runs-command' },
  { re: /^\s*allowed-tools\s*:/i, why: 'allows-tools' },
  { re: /^\s*hooks\s*:/, why: 'attaches-hooks' },
  { re: /permissionMode/, why: 'changes-permission-mode' },
  { re: /[‪-‮⁦-⁩]/, why: 'hidden-direction-marks' },
];

export interface RiskyLine {
  line: number;
  text: string;
  why: RiskyWhy;
}

export function riskyLines(text: string): RiskyLine[] {
  return text.split('\n').flatMap((l, i) => {
    const hit = RISKY.find((r) => r.re.test(l));
    return hit ? [{ line: i + 1, text: l.trim().slice(0, 120), why: hit.why }] : [];
  });
}
