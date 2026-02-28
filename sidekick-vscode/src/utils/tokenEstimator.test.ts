/**
 * @fileoverview Tests for tokenEstimator — token estimation and diff truncation.
 *
 * @module tokenEstimator.test
 */

import { describe, it, expect } from 'vitest';
import {
  estimateTokens,
  truncateDiffIntelligently,
  DEFAULT_MAX_TOKENS,
} from './tokenEstimator';

describe('estimateTokens', () => {
  it('returns 0 for an empty string', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('estimates 1 token for 1-4 characters', () => {
    expect(estimateTokens('a')).toBe(1);
    expect(estimateTokens('ab')).toBe(1);
    expect(estimateTokens('abc')).toBe(1);
    expect(estimateTokens('abcd')).toBe(1);
  });

  it('uses Math.ceil so 5 chars becomes 2 tokens', () => {
    expect(estimateTokens('abcde')).toBe(2);
  });

  it('estimates correctly for longer strings', () => {
    // 100 chars / 4 = 25 tokens exactly
    expect(estimateTokens('x'.repeat(100))).toBe(25);
  });

  it('rounds up for non-divisible lengths', () => {
    // 101 chars / 4 = 25.25 -> ceil -> 26
    expect(estimateTokens('x'.repeat(101))).toBe(26);
  });

  it('handles strings with special characters', () => {
    const special = '!@#$%^&*()_+-={}[]|\\:";\'<>?,./~`';
    expect(estimateTokens(special)).toBe(Math.ceil(special.length / 4));
  });

  it('handles multi-byte unicode characters', () => {
    // JS string length counts UTF-16 code units
    const emoji = '\u{1F600}'; // grinning face — 2 code units in JS
    expect(estimateTokens(emoji)).toBe(Math.ceil(emoji.length / 4));
  });

  it('handles strings with newlines and whitespace', () => {
    const text = 'line1\nline2\n  indented\n';
    expect(estimateTokens(text)).toBe(Math.ceil(text.length / 4));
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

  it('returns the original diff when exactly at the character limit', () => {
    // DEFAULT_MAX_TOKENS * 4 chars
    const maxChars = DEFAULT_MAX_TOKENS * 4;
    const diff = 'x'.repeat(maxChars);
    expect(truncateDiffIntelligently(diff)).toBe(diff);
  });

  it('truncates large diffs by keeping complete file sections', () => {
    // Create sections that each take ~100 chars
    const section1 = makeDiffSection('file1.ts', 2);
    const section2 = makeDiffSection('file2.ts', 2);

    // Use a very small token limit so we can only fit the first section
    const maxTokens = Math.ceil(section1.length / 4); // just enough for section 1
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
    const maxTokens = Math.ceil(twoSectionsChars / 4);

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
    const maxChars = DEFAULT_MAX_TOKENS * 4;
    const diff = 'x'.repeat(maxChars - 1);
    expect(truncateDiffIntelligently(diff)).toBe(diff);

    // Create a diff that exceeds the default limit (no sections, so empty after split)
    const bigDiff = `diff --git a/big.ts b/big.ts\n${'x'.repeat(maxChars + 100)}`;
    const result = truncateDiffIntelligently(bigDiff);
    expect(result.length).toBeLessThanOrEqual(maxChars);
  });

  it('handles a single section that exactly fits', () => {
    const section = makeDiffSection('exact.ts', 3);
    const maxTokens = Math.ceil(section.length / 4);
    expect(truncateDiffIntelligently(section, maxTokens)).toBe(section);
  });
});

describe('DEFAULT_MAX_TOKENS', () => {
  it('is 8000', () => {
    expect(DEFAULT_MAX_TOKENS).toBe(8000);
  });
});
