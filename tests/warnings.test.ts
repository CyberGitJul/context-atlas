import { describe, expect, it } from 'vitest';
import type { Hint } from '../src/shared/model.js';
import { warningsFor } from '../src/shared/warnings.js';

const hints: Hint[] = [
  { id: 'a', severity: 'warn', text: 'A', componentIds: ['x', 'y'] },
  { id: 'b', severity: 'info', text: 'B', componentIds: ['x'] },
  { id: 'c', severity: 'warn', text: 'C', componentIds: ['x'] },
];

describe('warningsFor', () => {
  it('returns the warn-level hints that name a component', () => {
    expect(warningsFor(hints, 'x').map((h) => h.id)).toEqual(['a', 'c']);
    expect(warningsFor(hints, 'z')).toEqual([]);
  });
});
