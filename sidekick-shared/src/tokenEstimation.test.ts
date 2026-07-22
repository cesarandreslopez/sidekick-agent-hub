import { describe, expect, it } from 'vitest';
import { estimateSerializedTokens, estimateTextTokens } from './tokenEstimation';

describe('estimateTextTokens', () => {
  it('returns zero for empty input', () => {
    expect(estimateTextTokens('')).toEqual({
      count: 0,
      method: 'sidekick-fallback-v1',
      confidence: 'medium',
      provenance: 'empty',
    });
  });

  it('uses the documented 3.5-character fallback for English and source code', () => {
    expect(estimateTextTokens('seven!!').count).toBe(2);
    expect(estimateTextTokens('const answer = 42;').count).toBe(Math.ceil(18 / 3.5));
  });

  it('counts CJK and emoji conservatively and deterministically', () => {
    expect(estimateTextTokens('你好').count).toBe(2);
    expect(estimateTextTokens('😀').count).toBe(2);
    expect(estimateTextTokens('你好😀').count).toBe(4);
    expect(estimateTextTokens('你好😀')).toEqual(estimateTextTokens('你好😀'));
  });

  it('uses a valid injected exact counter and rejects invalid results', () => {
    expect(estimateTextTokens('hello', { model: 'x', exactCounter: () => 1 }).method).toBe('exact');
    expect(estimateTextTokens('hello', { exactCounter: () => Number.NaN }).method).toBe(
      'sidekick-fallback-v1',
    );
    expect(
      estimateTextTokens('hello', {
        exactCounter: () => {
          throw new Error('counter unavailable');
        },
      }).method,
    ).toBe('sidekick-fallback-v1');
  });

  it('estimates serialized values', () => {
    expect(estimateSerializedTokens({ ok: true }).count).toBeGreaterThan(0);
  });
});
