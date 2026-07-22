/**
 * @fileoverview Tests for tokenEstimator — token estimation and diff truncation.
 *
 * @module tokenEstimator.test
 */

import { describe, it, expect } from 'vitest';
import { estimateTextTokens } from 'sidekick-shared';
import { estimateTokens, truncateDiffIntelligently, DEFAULT_MAX_TOKENS } from './tokenEstimator';

describe('estimateTokens', () => {
  it('returns 0 for an empty string', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('uses the canonical 3.5-character Latin/code fallback', () => {
    expect(estimateTokens('a')).toBe(1);
    expect(estimateTokens('ab')).toBe(1);
    expect(estimateTokens('abc')).toBe(1);
    expect(estimateTokens('abcd')).toBe(2);
  });

  it('uses Math.ceil so 5 chars becomes 2 tokens', () => {
    expect(estimateTokens('abcde')).toBe(2);
  });

  it('estimates correctly for longer strings', () => {
    expect(estimateTokens('x'.repeat(100))).toBe(Math.ceil(100 / 3.5));
  });

  it('rounds up for non-divisible lengths', () => {
    expect(estimateTokens('x'.repeat(101))).toBe(Math.ceil(101 / 3.5));
  });

  it('handles strings with special characters', () => {
    const special = '!@#$%^&*()_+-={}[]|\\:";\'<>?,./~`';
    expect(estimateTokens(special)).toBe(estimateTextTokens(special).count);
  });

  it('handles multi-byte unicode characters', () => {
    // JS string length counts UTF-16 code units
    const emoji = '\u{1F600}'; // grinning face — 2 code units in JS
    expect(estimateTokens(emoji)).toBe(estimateTextTokens(emoji).count);
  });

  it('handles strings with newlines and whitespace', () => {
    const text = 'line1\nline2\n  indented\n';
    expect(estimateTokens(text)).toBe(estimateTextTokens(text).count);
  });
});

describe('truncateDiffIntelligently', () => {
  const makeDiffSection = (filename: string, lines: number): string => {
    let section = `diff --git a/${filename} b/${filename}\n`;
    section += `--- a/${filename}\n`;
    section += `+++ b/${filename}\n`;
    section += '@@ -1,3 +1,4 @@\n';
    for (let i = 0; i < lines; i++) {
      section += `+added line ${i}\n`;
    }
    return section;
  };

  it('returns the original diff when under the token limit', () => {
    const smallDiff = makeDiffSection('small.ts', 2);
    expect(truncateDiffIntelligently(smallDiff)).toBe(smallDiff);
  });

  it('returns the original diff when exactly at the estimated token limit', () => {
    const maxChars = DEFAULT_MAX_TOKENS * 3.5;
    const diff = 'x'.repeat(maxChars);
    expect(truncateDiffIntelligently(diff)).toBe(diff);
  });

  it('truncates large diffs by keeping complete file sections', () => {
    // Create sections that each take ~100 chars
    const section1 = makeDiffSection('file1.ts', 2);
    const section2 = makeDiffSection('file2.ts', 2);

    // Use a very small token limit so we can only fit the first section
    const maxTokens = estimateTokens(section1); // just enough for section 1
    const largeDiff = section1 + section2;

    const result = truncateDiffIntelligently(largeDiff, maxTokens);

    expect(result).toBe(section1);
    expect(result).not.toContain('file2.ts');
  });

  it('returns empty string when first section exceeds limit', () => {
    const section = makeDiffSection('huge.ts', 1000);
    // Token limit too small for even the first section
    const result = truncateDiffIntelligently(section, 1);
    expect(result).toBe('');
  });

  it('preserves section boundaries — never breaks mid-hunk', () => {
    const section1 = makeDiffSection('a.ts', 5);
    const section2 = makeDiffSection('b.ts', 5);
    const section3 = makeDiffSection('c.ts', 5);

    const fullDiff = section1 + section2 + section3;
    const twoSectionsChars = (section1 + section2).length;
    // Allow just enough for 2 sections but not 3
    const maxTokens = estimateTokens(fullDiff.slice(0, twoSectionsChars));

    const result = truncateDiffIntelligently(fullDiff, maxTokens);

    expect(result).toBe(section1 + section2);
    expect(result).not.toContain('c.ts');
  });

  it('handles empty diff', () => {
    expect(truncateDiffIntelligently('')).toBe('');
  });

  it('handles diff with no "diff --git" markers', () => {
    const plainText = 'This is just some plain text\nwithout diff markers\n';
    expect(truncateDiffIntelligently(plainText)).toBe(plainText);
  });

  it('uses DEFAULT_MAX_TOKENS when no maxTokens parameter given', () => {
    // Create a diff that is just under the default limit
    const maxChars = DEFAULT_MAX_TOKENS * 3.5;
    const diff = 'x'.repeat(maxChars - 1);
    expect(truncateDiffIntelligently(diff)).toBe(diff);

    // Create a diff that exceeds the default limit (no sections, so empty after split)
    const bigDiff = `diff --git a/big.ts b/big.ts\n${'x'.repeat(maxChars + 100)}`;
    const result = truncateDiffIntelligently(bigDiff);
    expect(estimateTokens(result)).toBeLessThanOrEqual(DEFAULT_MAX_TOKENS);
  });

  it('handles a single section that exactly fits', () => {
    const section = makeDiffSection('exact.ts', 3);
    const maxTokens = estimateTokens(section);
    expect(truncateDiffIntelligently(section, maxTokens)).toBe(section);
  });
});

describe('DEFAULT_MAX_TOKENS', () => {
  it('is 8000', () => {
    expect(DEFAULT_MAX_TOKENS).toBe(8000);
  });
});
