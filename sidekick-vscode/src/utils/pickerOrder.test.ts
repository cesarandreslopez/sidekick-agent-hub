import { describe, expect, it } from 'vitest';
import { currentFirst } from './pickerOrder';

const types = [
  { label: 'Gotcha', value: 'gotcha', description: 'Something surprising' },
  { label: 'Pattern', value: 'pattern' },
  { label: 'Tip', value: 'tip', description: 'A useful shortcut' },
];

describe('currentFirst', () => {
  it('puts the current value first, so Enter keeps it', () => {
    const ordered = currentFirst(types, 'tip');
    expect(ordered.map((t) => t.value)).toEqual(['tip', 'gotcha', 'pattern']);
    expect(ordered[0].description).toBe('(current) A useful shortcut');
  });

  it('marks a current value that has no description', () => {
    expect(currentFirst(types, 'pattern')[0]).toMatchObject({
      value: 'pattern',
      description: '(current)',
    });
  });

  it('leaves the order alone when the current value is unknown', () => {
    expect(currentFirst(types, 'legacy').map((t) => t.value)).toEqual(['gotcha', 'pattern', 'tip']);
    expect(currentFirst(types, undefined)).toEqual(types);
  });

  it('does not change the items it was given', () => {
    currentFirst(types, 'tip');
    expect(types[2].description).toBe('A useful shortcut');
  });
});
