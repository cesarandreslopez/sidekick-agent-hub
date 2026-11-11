/**
 * @fileoverview Inference provider types and model tier mappings.
 *
 * Defines the abstraction layer for multi-provider inference support.
 * Providers implement the ClaudeClient interface and are selected via
 * the `sidekick.inferenceProvider` setting.
 *
 * @module types/inferenceProvider
 */

import type { InferenceEffort } from 'sidekick-shared';

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

/**
 * Default model per tier per provider (reviewed 2026-11-11). Haiku 5.5 and
 * Sonnet 5.5 think by default, and GPT-6.1 Sol rejects `reasoning_effort:
 * 'none'`, so the clients send per-model settings (`FEATURE_EFFORT`,
 * `anthropicRequestTuning`) that keep fast features fast. Opus 5.5 stays the
 * powerful default: Fable 5.2 costs twice as much and its turns can run for
 * minutes; pick it with a literal `claude-fable-5-2` (or `fable`).
 */
export const DEFAULT_MODEL_MAPPINGS: Record<InferenceProviderId, ModelMapping> = {
  'claude-max': { fast: 'haiku', balanced: 'sonnet', powerful: 'opus' },
  'claude-api': {
    fast: 'claude-haiku-5-5',
    balanced: 'claude-sonnet-5-5',
    powerful: 'claude-opus-5-5',
  },
  opencode: {
    fast: 'anthropic/claude-haiku-5-5',
    balanced: 'anthropic/claude-sonnet-5-5',
    powerful: 'anthropic/claude-opus-5-5',
  },
  codex: {
    fast: 'gpt-6-luna',
    balanced: 'gpt-6.1-sol',
    powerful: 'gpt-6-astra',
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

/**
 * How much reasoning each feature asks for, whatever model it resolves to.
 * `minimal` features are latency-sensitive (thinking off where the model
 * allows it); `medium` ones benefit from some reasoning.
 */
export const FEATURE_EFFORT: Record<string, InferenceEffort> = {
  inlineModel: 'minimal',
  commitMessageModel: 'minimal',
  docModel: 'low',
  inlineChatModel: 'low',
  explanationModel: 'low',
  errorModel: 'low',
  prDescriptionModel: 'low',
  reviewModel: 'medium',
  transformModel: 'medium',
};

/** The effort a feature asks for; `low` for one this table does not list. */
export function featureEffort(featureKey: string): InferenceEffort {
  return Object.prototype.hasOwnProperty.call(FEATURE_EFFORT, featureKey)
    ? FEATURE_EFFORT[featureKey]
    : 'low';
}

/** Display names for status bar / UI */
export const PROVIDER_DISPLAY_NAMES: Record<InferenceProviderId, string> = {
  'claude-max': 'Claude',
  'claude-api': 'Claude API',
  opencode: 'OpenCode',
  codex: 'Codex',
};
