import { describe, expect, it } from 'vitest';
import { parseLimit } from './parseLimit';

describe('parseLimit', () => {
  it('accepts positive base-10 integers', () => {
    expect(parseLimit(undefined)).toBeUndefined();
    expect(parseLimit('12')).toBe(12);
  });

  it.each(['abc', '12abc', '0x10', '0', '-1', '1.5'])('rejects %s', (value) => {
    expect(() => parseLimit(value)).toThrow('Limit must be a positive integer');
  });
});
