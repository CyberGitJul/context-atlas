import { describe, expect, it } from 'vitest';
import { pushCommand } from '../src/shared/push-command.js';

describe('the push command the commit offer shows', () => {
  it('stays plain for an ordinary repo path, with ~ left for the shell', () => {
    expect(pushCommand('~/projects/standards')).toBe('git -C ~/projects/standards push');
  });

  it('quotes a path with spaces or shell characters, still expanding ~', () => {
    expect(pushCommand('~/my repos/standards')).toBe("git -C ~/'my repos/standards' push");
    expect(pushCommand("/srv/it's $here")).toBe("git -C '/srv/it'\\''s $here' push");
  });
});
