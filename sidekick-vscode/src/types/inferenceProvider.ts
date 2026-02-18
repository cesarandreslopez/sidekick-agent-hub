/**
 * @fileoverview Inference provider types and model tier mappings.
 *
 * Defines the abstraction layer for multi-provider inference support.
 * Providers implement the ClaudeClient interface and are selected via
 * the `sidekick.inferenceProvider` setting.
 *
 * @module types/inferenceProvider
 */

export type InferenceProviderId = 'claude-max' | 'claude-api' | 'opencode' | 'codex';

export type ModelTier = 'fast' | 'balanced' | 'powerful';

/** Maps legacy Anthropic model names to tiers */
export const LEGACY_TIER_MAP: Record<string, ModelTier> = {
  haiku: 'fast',
  sonnet: 'balanced',
  opus: 'powerful',
};

export interface ModelMapping {
  fast: string;
  balanced: string;
  powerful: string;
}

/** Default model per tier per provider */
export const DEFAULT_MODEL_MAPPINGS: Record<InferenceProviderId, ModelMapping> = {
  'claude-max': { fast: 'haiku', balanced: 'sonnet', powerful: 'opus' },
  'claude-api': {
    fast: 'claude-3-5-haiku-20241022',
    balanced: 'claude-sonnet-4-20250514',
    powerful: 'claude-opus-4-20250514',
  },
  opencode: { fast: 'fast', balanced: 'balanced', powerful: 'powerful' },
  codex: {
    fast: 'gpt-5-codex-mini',
    balanced: 'gpt-5.3-codex',
    powerful: 'gpt-5.3-codex',
  },
};

/** What "auto" resolves to per feature */
export const FEATURE_AUTO_TIERS: Record<string, ModelTier> = {
  inlineModel: 'fast',
  transformModel: 'powerful',
  commitMessageModel: 'balanced',
  docModel: 'fast',
  explanationModel: 'balanced',
  errorModel: 'balanced',
  inlineChatModel: 'balanced',
  reviewModel: 'balanced',
  prDescriptionModel: 'balanced',
};

/** Display names for status bar / UI */
export const PROVIDER_DISPLAY_NAMES: Record<InferenceProviderId, string> = {
  'claude-max': 'Claude',
  'claude-api': 'Claude API',
  opencode: 'OpenCode',
  codex: 'Codex',
};
