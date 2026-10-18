import { describe, expect, it } from 'vitest';
import {
  ASCII_CHARS_PER_TOKEN,
  estimateSerializedTokens,
  estimateTextTokens,
} from './tokenEstimation';

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

describe('estimateTextTokens ASCII fast path', () => {
  // The pre-fast-path algorithm, kept here to pin equivalence.
  function referenceCount(text: string): { count: number; confidence: string } {
    const cjk = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
    const emoji = /\p{Extended_Pictographic}/u;
    let asciiChars = 0;
    let conservativeTokens = 0;
    for (const codePoint of text) {
      if (emoji.test(codePoint)) conservativeTokens += 2;
      else if (cjk.test(codePoint)) conservativeTokens += 1;
      else if ((codePoint.codePointAt(0) ?? 128) <= 127) asciiChars += codePoint.length;
      else conservativeTokens += 1;
    }
    return {
      count: Math.ceil(asciiChars / 3.5) + conservativeTokens,
      confidence: conservativeTokens > 0 ? 'low' : 'medium',
    };
  }

  it.each([
    'a',
    'const x = 1;\n\tfunction f() { return x * 2; }\n',
    '#*0123456789 ~!@$%^&()_+`-=[]{}|;\':",./<>?',
    '\u0000\u007f control',
    '日本語のテキスト',
    '한국어 텍스트 and English',
    'emoji 🎉🚀 and ✅ ok',
    'café naïve résumé',
    'ascii first then 中文 then ascii again',
    '👨‍👩‍👧 family',
    '\ud800 lone surrogate',
    'x'.repeat(10_000) + 'é',
  ])('matches the reference count for %j', (text) => {
    const estimate = estimateTextTokens(text);
    expect({ count: estimate.count, confidence: estimate.confidence }).toEqual(
      referenceCount(text),
    );
    expect(estimate.provenance).toBe('chars-per-token-3.5+cjk1+emoji2');
  });

  it('publishes the characters-per-token ratio it uses', () => {
    expect(ASCII_CHARS_PER_TOKEN).toBe(3.5);
    expect(estimateTextTokens('x'.repeat(35)).count).toBe(35 / ASCII_CHARS_PER_TOKEN);
  });
});
