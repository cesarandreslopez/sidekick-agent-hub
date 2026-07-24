import { describe, it, expect, afterEach } from 'vitest';
import {
  getModelContextWindowSize,
  DEFAULT_CONTEXT_WINDOW,
  _setObservedContextWindows,
  _getObservedContextWindows,
  _clearObservedContextWindows,
  _setCatalogContextWindows,
  _getCatalogContextWindows,
  _clearCatalogContextWindows,
} from './modelContext';

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

  it('returns 1M for Opus 4.8 and Fable 5', () => {
    expect(getModelContextWindowSize('claude-opus-4-8')).toBe(1_000_000);
    expect(getModelContextWindowSize('claude-opus-4-8-20260528')).toBe(1_000_000);
    expect(getModelContextWindowSize('claude-fable-5')).toBe(1_000_000);
    expect(getModelContextWindowSize('claude-fable-5-20260609')).toBe(1_000_000);
    expect(getModelContextWindowSize('claude-fable-5[1m]')).toBe(1_000_000);
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

  describe('input normalization', () => {
    it('trims and lowercases before exact match', () => {
      expect(getModelContextWindowSize('Claude-Opus-4-8 ')).toBe(1_000_000);
      expect(getModelContextWindowSize('GPT-4O')).toBe(128_000);
    });

    it('trims and lowercases before prefix match', () => {
      expect(getModelContextWindowSize(' CLAUDE-SONNET-4-6-20250414')).toBe(1_000_000);
    });

    it('honors an uppercase [1M] suffix', () => {
      expect(getModelContextWindowSize('claude-sonnet-4-5[1M]')).toBe(1_000_000);
    });

    it('returns default for whitespace-only input', () => {
      expect(getModelContextWindowSize('  ')).toBe(200_000);
    });
  });

  describe('current models resolve from the static baseline', () => {
    it('returns 1M for Opus 5 and Sonnet 5', () => {
      // Both previously fell through to the 200K default, making context
      // gauges read ~5x too full.
      expect(getModelContextWindowSize('claude-opus-5')).toBe(1_000_000);
      expect(getModelContextWindowSize('claude-sonnet-5')).toBe(1_000_000);
    });

    it('returns published maxima for the GPT-5.5/5.6 line', () => {
      expect(getModelContextWindowSize('gpt-5.5')).toBe(1_050_000);
      expect(getModelContextWindowSize('gpt-5.6-sol')).toBe(1_050_000);
      expect(getModelContextWindowSize('gpt-5.6-terra')).toBe(1_050_000);
    });
  });

  describe('override precedence', () => {
    afterEach(() => {
      _clearObservedContextWindows();
      _clearCatalogContextWindows();
    });

    it('prefers catalog overrides over the static table', () => {
      expect(getModelContextWindowSize('claude-opus-5')).toBe(1_000_000);
      _setCatalogContextWindows({ 'claude-opus-5': 777_000 });
      expect(getModelContextWindowSize('claude-opus-5')).toBe(777_000);
    });

    it('prefers observed values over the catalog', () => {
      // The real case: Codex reports a tier-specific 258,400 while the catalog
      // only knows the 1,050,000 published maximum.
      _setCatalogContextWindows({ 'gpt-5.6-sol': 1_050_000 });
      _setObservedContextWindows({ 'gpt-5.6-sol': 258_400 });
      expect(getModelContextWindowSize('gpt-5.6-sol')).toBe(258_400);
    });

    it('resolves brand-new models from the catalog alone', () => {
      expect(getModelContextWindowSize('gpt-9-hypothetical')).toBe(DEFAULT_CONTEXT_WINDOW);
      _setCatalogContextWindows({ 'gpt-9-hypothetical': 2_000_000 });
      expect(getModelContextWindowSize('gpt-9-hypothetical')).toBe(2_000_000);
    });

    it('applies longest-prefix matching within override maps', () => {
      _setCatalogContextWindows({ 'gpt-5.6': 1_050_000, 'gpt-5.6-tiny': 32_000 });
      expect(getModelContextWindowSize('gpt-5.6-tiny-20260301')).toBe(32_000);
      expect(getModelContextWindowSize('gpt-5.6-20260301')).toBe(1_050_000);
    });

    it('lowercases override keys so catalog casing cannot break lookups', () => {
      _setCatalogContextWindows({ 'Anthropic-Custom-Model': 500_000 });
      expect(getModelContextWindowSize('anthropic-custom-model')).toBe(500_000);
      expect(_getCatalogContextWindows()['anthropic-custom-model']).toBe(500_000);
    });

    it('ignores non-positive or non-finite override values', () => {
      _setObservedContextWindows({ a: 0, b: -1, c: Number.NaN, d: 123_456 });
      expect(_getObservedContextWindows()).toEqual({ d: 123_456 });
    });

    it('still honors the [1m] marker ahead of every override', () => {
      _setObservedContextWindows({ 'claude-opus-5': 258_400 });
      expect(getModelContextWindowSize('claude-opus-5[1m]')).toBe(1_000_000);
    });

    it('falls back to static once overrides are cleared', () => {
      _setObservedContextWindows({ 'claude-opus-5': 258_400 });
      expect(getModelContextWindowSize('claude-opus-5')).toBe(258_400);
      _clearObservedContextWindows();
      expect(getModelContextWindowSize('claude-opus-5')).toBe(1_000_000);
    });
  });
});
