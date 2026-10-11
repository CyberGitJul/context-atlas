import { describe, expect, it } from 'vitest';
import { maskedCount, splitProposals } from '../src/shared/chat-proposals.js';

describe('splitProposals', () => {
  it('separates the explanation from a complete proposal, keeping inner code fences', () => {
    const answer = 'I will shorten it.\n\n````proposal\n## H\n```bash\nls\n```\nText\n````\n\nDone.';
    expect(splitProposals(answer)).toEqual([
      { kind: 'text', text: 'I will shorten it.\n\n' },
      { kind: 'proposal', text: '## H\n```bash\nls\n```\nText', complete: true },
      { kind: 'text', text: '\n\nDone.' },
    ]);
  });
  it('marks a block still being streamed as incomplete', () => {
    expect(splitProposals('Go:\n````proposal\n## H\nhalf')).toEqual([
      { kind: 'text', text: 'Go:\n' },
      { kind: 'proposal', text: '## H\nhalf', complete: false },
    ]);
  });
  it('reads file proposals with their path, next to a page proposal', () => {
    const answer = '````file ~/projects/INDEX.md\n# Index\n````\nand\n````proposal\n## H\n````';
    expect(splitProposals(answer)).toEqual([
      { kind: 'file', path: '~/projects/INDEX.md', text: '# Index', complete: true },
      { kind: 'text', text: '\nand\n' },
      { kind: 'proposal', text: '## H', complete: true },
    ]);
  });

  it('closes on a longer fence or one with trailing spaces, and reads CRLF answers', () => {
    expect(splitProposals('````proposal\n## H\n`````  \nAfter.')).toEqual([
      { kind: 'proposal', text: '## H', complete: true },
      { kind: 'text', text: '\nAfter.' },
    ]);
    expect(splitProposals('````proposal \r\n## H\r\n````\r\n')).toEqual([{ kind: 'proposal', text: '## H', complete: true }, { kind: 'text', text: '\n' }]);
  });

  it('leaves answers without proposal untouched', () => {
    expect(splitProposals('Plain text with ```code```.')).toEqual([{ kind: 'text', text: 'Plain text with ```code```.' }]);
  });
});

describe('maskedCount', () => {
  it('counts masked values but not a Markdown rule', () => {
    expect(maskedCount('a\n***\nb')).toBe(0);
    expect(maskedCount('token=***\nkey: ***')).toBe(2);
  });
});
