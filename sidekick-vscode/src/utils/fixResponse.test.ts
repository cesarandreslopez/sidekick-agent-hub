import { describe, expect, it } from 'vitest';
import { isFixRefusal } from './fixResponse';

describe('isFixRefusal', () => {
  it.each(['I cannot fix this safely.', 'Unable to determine a fix.', 'Need more context.'])(
    'recognizes a leading refusal: %s',
    (response) => expect(isFixRefusal(response)).toBe(true),
  );

  it('does not reject code containing common error text', () => {
    expect(isFixRefusal("throw new Error('Cannot read properties of undefined');")).toBe(false);
    expect(isFixRefusal('// unable to connect\nreturn reconnect();')).toBe(false);
  });
});
