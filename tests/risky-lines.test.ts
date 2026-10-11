import { describe, expect, it } from 'vitest';
import { riskyLines } from '../src/shared/risky-lines.js';

describe('riskyLines', () => {
  it('names lines that run commands or grant rights, with their number', () => {
    const text = '---\nname: x\nallowed-tools: Bash(*)\nhooks:\n  PreToolUse: []\n---\n\nStatus: !`git status`\nNormal text.';
    expect(riskyLines(text).map((r) => [r.line, r.why])).toEqual([
      [3, 'allows-tools'],
      [4, 'attaches-hooks'],
      [8, 'runs-command'],
    ]);
  });
  it('finds hidden direction marks and leaves plain text alone', () => {
    expect(riskyLines('a‮b')[0].why).toBe('hidden-direction-marks');
    expect(riskyLines('Plain text with `code`.')).toEqual([]);
    expect(riskyLines('- Breaking Change: `!` nach type/scope plus Footer `BREAKING CHANGE: …`')).toEqual([]);
  });
});
