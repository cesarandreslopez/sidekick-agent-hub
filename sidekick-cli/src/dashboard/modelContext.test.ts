import { describe, it, expect } from 'vitest';
import { getContextWindowSize } from './modelContext';

describe('getContextWindowSize', () => {
  it('returns default for undefined model', () => {
    expect(getContextWindowSize(undefined)).toBe(200_000);
  });

  it('returns exact match for known model', () => {
    expect(getContextWindowSize('claude-opus-4')).toBe(200_000);
    expect(getContextWindowSize('gpt-4o')).toBe(128_000);
    expect(getContextWindowSize('gpt-4')).toBe(8_192);
  });

  it('matches by prefix for versioned model IDs', () => {
    expect(getContextWindowSize('claude-sonnet-4-20250514')).toBe(200_000);
    expect(getContextWindowSize('claude-3-5-sonnet-20241022')).toBe(200_000);
    expect(getContextWindowSize('gpt-4o-2024-08-06')).toBe(128_000);
  });

  it('returns default for unknown model', () => {
    expect(getContextWindowSize('llama-3.1-70b')).toBe(200_000);
  });
});
