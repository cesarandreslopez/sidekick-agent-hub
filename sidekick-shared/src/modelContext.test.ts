import { describe, it, expect } from 'vitest';
import { getModelContextWindowSize, DEFAULT_CONTEXT_WINDOW } from './modelContext';

describe('getModelContextWindowSize', () => {
  it('returns default for undefined model', () => {
    expect(getModelContextWindowSize(undefined)).toBe(200_000);
  });

  it('returns default for unknown model', () => {
    expect(getModelContextWindowSize('llama-3.1-70b')).toBe(200_000);
  });

  it('returns exact match for known models', () => {
    expect(getModelContextWindowSize('claude-opus-4')).toBe(200_000);
    expect(getModelContextWindowSize('gpt-4o')).toBe(128_000);
    expect(getModelContextWindowSize('gpt-4')).toBe(8_192);
  });

  it('returns 1M for Claude 4.6 family', () => {
    expect(getModelContextWindowSize('claude-opus-4-6')).toBe(1_000_000);
    expect(getModelContextWindowSize('claude-sonnet-4-6')).toBe(1_000_000);
  });

  it('returns 1M for Claude 4.7 family (Opus native 1M)', () => {
    expect(getModelContextWindowSize('claude-opus-4-7')).toBe(1_000_000);
    expect(getModelContextWindowSize('claude-opus-4-7-20260101')).toBe(1_000_000);
    expect(getModelContextWindowSize('claude-sonnet-4-7')).toBe(1_000_000);
    expect(getModelContextWindowSize('claude-sonnet-4-7-20260101')).toBe(1_000_000);
  });

  it('honors the [1m] suffix as an explicit 1M marker', () => {
    expect(getModelContextWindowSize('claude-opus-4-7[1m]')).toBe(1_000_000);
    expect(getModelContextWindowSize('claude-opus-4-7[1M]')).toBe(1_000_000);
    // Suffix overrides the base family even when the base is 200K.
    expect(getModelContextWindowSize('claude-sonnet-4-5[1m]')).toBe(1_000_000);
    expect(getModelContextWindowSize('claude-haiku-4-5[1m]')).toBe(1_000_000);
  });

  it('matches versioned model IDs by longest prefix', () => {
    // claude-opus-4-6-20250414 should match claude-opus-4-6 (1M), not claude-opus-4 (200K)
    expect(getModelContextWindowSize('claude-opus-4-6-20250414')).toBe(1_000_000);
    expect(getModelContextWindowSize('claude-sonnet-4-6-20250414')).toBe(1_000_000);
    expect(getModelContextWindowSize('claude-sonnet-4-20250514')).toBe(200_000);
    expect(getModelContextWindowSize('claude-3-5-sonnet-20241022')).toBe(200_000);
    expect(getModelContextWindowSize('gpt-4o-2024-08-06')).toBe(128_000);
  });

  it('returns correct size for claude-haiku-4-5', () => {
    expect(getModelContextWindowSize('claude-haiku-4-5')).toBe(200_000);
    expect(getModelContextWindowSize('claude-haiku-4-5-20251001')).toBe(200_000);
  });

  it('returns correct sizes for OpenAI models', () => {
    expect(getModelContextWindowSize('gpt-4.1')).toBe(1_048_576);
    expect(getModelContextWindowSize('gpt-4.1-mini')).toBe(1_048_576);
    expect(getModelContextWindowSize('gpt-5')).toBe(400_000);
    expect(getModelContextWindowSize('o1')).toBe(200_000);
    expect(getModelContextWindowSize('o3')).toBe(200_000);
    expect(getModelContextWindowSize('o4')).toBe(200_000);
    expect(getModelContextWindowSize('o4-mini')).toBe(200_000);
  });

  it('returns correct sizes for GPT-5 variants', () => {
    expect(getModelContextWindowSize('gpt-5.4')).toBe(1_050_000);
    expect(getModelContextWindowSize('gpt-5.4-pro')).toBe(1_050_000);
    expect(getModelContextWindowSize('gpt-5.3-codex')).toBe(400_000);
    expect(getModelContextWindowSize('gpt-5.3-codex-20260101')).toBe(400_000);
    expect(getModelContextWindowSize('gpt-5.3-codex-spark')).toBe(128_000);
    // gpt-5 fallback is still 400K for unknown 5.x variants.
    expect(getModelContextWindowSize('gpt-5-turbo')).toBe(400_000);
  });

  it('returns correct sizes for Gemini and DeepSeek', () => {
    expect(getModelContextWindowSize('gemini')).toBe(1_000_000);
    expect(getModelContextWindowSize('gemini-2.0-flash')).toBe(1_000_000);
    expect(getModelContextWindowSize('deepseek')).toBe(128_000);
    expect(getModelContextWindowSize('deepseek-v3')).toBe(128_000);
  });

  it('exports DEFAULT_CONTEXT_WINDOW as 200_000', () => {
    expect(DEFAULT_CONTEXT_WINDOW).toBe(200_000);
  });
});
