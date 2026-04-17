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

  it('returns 1M for Claude Opus 4.6', () => {
    expect(getContextWindowSize('claude-opus-4-6')).toBe(1_000_000);
    expect(getContextWindowSize('claude-opus-4-6-20250414')).toBe(1_000_000);
  });

  it('returns 1M for Claude Sonnet 4.6', () => {
    expect(getContextWindowSize('claude-sonnet-4-6')).toBe(1_000_000);
    expect(getContextWindowSize('claude-sonnet-4-6-20250414')).toBe(1_000_000);
  });

  it('returns 1M for Claude Opus/Sonnet 4.7 (native 1M)', () => {
    expect(getContextWindowSize('claude-opus-4-7')).toBe(1_000_000);
    expect(getContextWindowSize('claude-opus-4-7-20260101')).toBe(1_000_000);
    expect(getContextWindowSize('claude-sonnet-4-7')).toBe(1_000_000);
  });

  it('honors the [1m] suffix as an explicit 1M marker', () => {
    expect(getContextWindowSize('claude-opus-4-7[1m]')).toBe(1_000_000);
    expect(getContextWindowSize('claude-opus-4-7[1M]')).toBe(1_000_000);
    expect(getContextWindowSize('claude-haiku-4-5[1m]')).toBe(1_000_000);
  });

  it('returns correct sizes for GPT-5 variants', () => {
    expect(getContextWindowSize('gpt-5.4')).toBe(1_050_000);
    expect(getContextWindowSize('gpt-5.4-pro')).toBe(1_050_000);
    expect(getContextWindowSize('gpt-5.3-codex')).toBe(400_000);
    expect(getContextWindowSize('gpt-5.3-codex-spark')).toBe(128_000);
    expect(getContextWindowSize('gpt-5-turbo')).toBe(400_000);
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
