/**
 * @fileoverview Unit tests for ModelResolver.
 */

import { describe, it, expect } from 'vitest';
import { resolveModel } from './ModelResolver';

describe('ModelResolver', () => {
  describe('auto resolution', () => {
    it('resolves "auto" to feature default tier for inlineModel -> fast -> haiku (claude-max)', () => {
      expect(resolveModel('auto', 'claude-max', 'inlineModel')).toBe('haiku');
    });

    it('resolves "auto" to feature default tier for transformModel -> powerful -> opus (claude-max)', () => {
      expect(resolveModel('auto', 'claude-max', 'transformModel')).toBe('opus');
    });

    it('resolves "auto" to balanced for unknown feature keys', () => {
      expect(resolveModel('auto', 'claude-max', 'unknownFeature')).toBe('sonnet');
    });

    it('resolves "auto" for opencode provider', () => {
      expect(resolveModel('auto', 'opencode', 'inlineModel')).toBe('fast');
    });

    it('resolves "auto" for codex provider', () => {
      expect(resolveModel('auto', 'codex', 'inlineModel')).toBe('gpt-5-codex-mini');
    });
  });

  describe('legacy name mapping', () => {
    it('maps haiku -> fast -> provider model (claude-max)', () => {
      expect(resolveModel('haiku', 'claude-max', 'inlineModel')).toBe('haiku');
    });

    it('maps sonnet -> balanced -> provider model (claude-api)', () => {
      expect(resolveModel('sonnet', 'claude-api', 'inlineModel')).toBe('claude-sonnet-4-20250514');
    });

    it('maps opus -> powerful -> provider model (claude-api)', () => {
      expect(resolveModel('opus', 'claude-api', 'transformModel')).toBe('claude-opus-4-20250514');
    });

    it('maps haiku -> fast -> provider model (opencode)', () => {
      expect(resolveModel('haiku', 'opencode', 'inlineModel')).toBe('fast');
    });

    it('maps opus -> powerful -> provider model (codex)', () => {
      expect(resolveModel('opus', 'codex', 'transformModel')).toBe('gpt-5.3-codex');
    });
  });

  describe('tier name resolution', () => {
    it('resolves fast tier for claude-max', () => {
      expect(resolveModel('fast', 'claude-max', 'inlineModel')).toBe('haiku');
    });

    it('resolves balanced tier for claude-api', () => {
      expect(resolveModel('balanced', 'claude-api', 'inlineModel')).toBe('claude-sonnet-4-20250514');
    });

    it('resolves powerful tier for codex', () => {
      expect(resolveModel('powerful', 'codex', 'inlineModel')).toBe('gpt-5.3-codex');
    });
  });

  describe('full model ID passthrough', () => {
    it('passes through full Claude model ID', () => {
      expect(resolveModel('claude-3-5-haiku-20241022', 'claude-max', 'inlineModel')).toBe('claude-3-5-haiku-20241022');
    });

    it('passes through full OpenAI model ID', () => {
      expect(resolveModel('gpt-4o', 'codex', 'inlineModel')).toBe('gpt-4o');
    });

    it('passes through arbitrary model string', () => {
      expect(resolveModel('my-custom-model', 'opencode', 'inlineModel')).toBe('my-custom-model');
    });
  });

  describe('all feature auto tiers', () => {
    const cases: Array<[string, string]> = [
      ['inlineModel', 'fast'],
      ['transformModel', 'powerful'],
      ['commitMessageModel', 'balanced'],
      ['docModel', 'fast'],
      ['explanationModel', 'balanced'],
      ['errorModel', 'balanced'],
      ['inlineChatModel', 'balanced'],
      ['reviewModel', 'balanced'],
      ['prDescriptionModel', 'balanced'],
    ];

    for (const [feature, expectedTier] of cases) {
      it(`auto for ${feature} resolves to ${expectedTier} tier`, () => {
        // For claude-max, tier names match model names
        const result = resolveModel('auto', 'claude-max', feature);
        const tierToModel: Record<string, string> = { fast: 'haiku', balanced: 'sonnet', powerful: 'opus' };
        expect(result).toBe(tierToModel[expectedTier]);
      });
    }
  });
});
