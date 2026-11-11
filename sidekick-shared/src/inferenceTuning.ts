/**
 * Per-model request settings for short, latency-sensitive inference calls
 * (completions, commit messages, explanations), so moving a feature to a
 * newer model never sends a parameter that model rejects.
 *
 * Current Claude models think by default and differ in how thinking can be
 * turned off: Haiku 5.5, Sonnet 5 and Opus 5 accept `thinking: {type:
 * 'disabled'}` (at effort `high` or below); Sonnet 5.5 rejects it and takes
 * `{type: 'between_tools'}` instead; Opus 5.5, Fable and Mythos cannot turn
 * thinking off at all, so effort is the only control. None of them accepts
 * `budget_tokens` or non-default sampling parameters, so this never produces
 * `temperature`, `top_p`, `top_k` or `budget_tokens`. Thinking tokens count
 * against `max_tokens`, so a model that may think gets headroom.
 *
 * OpenAI reasoning models differ in the lowest `reasoning_effort` they take:
 * `none` (GPT-5.1 onward, except the Pro, Astra and GPT-6.1 Sol models),
 * `minimal` (the original GPT-5 family), else `low`.
 *
 * Pure: no I/O.
 *
 * @module inferenceTuning
 */

import { canonicalModelId, parseModelId } from './modelInfo';

/**
 * How much reasoning a feature wants.
 * - `minimal`: none if the model allows it (inline completions, commit messages).
 * - `low`: a little (explanations, docs, error analysis).
 * - `medium`: some (code review, transforms).
 */
export type InferenceEffort = 'minimal' | 'low' | 'medium';

/** Extra Anthropic Messages API body fields for one request. */
export interface AnthropicRequestBody {
  thinking?: { type: 'disabled' } | { type: 'between_tools' };
  output_config?: { effort: 'low' | 'medium' };
}

export interface AnthropicRequestTuning {
  /** Spread into the request body. Empty for models that predate effort. */
  body: AnthropicRequestBody;
  /** `max_tokens` to send: the requested value, plus headroom when the model may think. */
  maxTokens: number;
}

export type OpenAiReasoningEffort = 'none' | 'minimal' | 'low' | 'medium';

/** Most `max_tokens` grows to make room for thinking. */
const THINKING_MAX_TOKENS_CAP = 16_000;
const HEADROOM: Record<'low' | 'medium', number> = { low: 2_048, medium: 8_192 };

type ThinkingOff = { type: 'disabled' } | { type: 'between_tools' } | null;

interface AnthropicRules {
  /** The model takes `output_config.effort`. */
  effort: boolean;
  /** How thinking is turned off, or null when it cannot be (or need not be). */
  off: ThinkingOff;
}

function versionAtLeast(version: string, major: number, minor: number): boolean {
  const [maj = 0, min = 0] = version.split('.').map((part) => Number.parseInt(part, 10));
  if (!Number.isFinite(maj)) return false;
  return maj > major || (maj === major && (Number.isFinite(min) ? min : 0) >= minor);
}

function anthropicRules(modelId: string): AnthropicRules {
  const parsed = parseModelId(canonicalModelId(modelId));
  if (!parsed || parsed.provider !== 'anthropic') return { effort: false, off: null };
  const { family, version } = parsed;
  if (family === 'fable' || family === 'mythos') return { effort: true, off: null };
  if (!versionAtLeast(version, 5, 0)) return { effort: false, off: null };
  if (family === 'haiku') {
    // Haiku 5.5 thinks by default and accepts `disabled` at effort high or below.
    return { effort: true, off: { type: 'disabled' } };
  }
  if (family === 'sonnet') {
    return versionAtLeast(version, 5, 5)
      ? { effort: true, off: { type: 'between_tools' } }
      : { effort: true, off: { type: 'disabled' } };
  }
  if (family === 'opus') {
    // Opus 5.5 and later reject `disabled` at every effort level.
    return versionAtLeast(version, 5, 5)
      ? { effort: true, off: null }
      : { effort: true, off: { type: 'disabled' } };
  }
  // A newer family or version this table does not know: the safe request.
  return { effort: true, off: null };
}

function withHeadroom(maxTokens: number, level: 'low' | 'medium'): number {
  return Math.max(maxTokens, Math.min(maxTokens + HEADROOM[level], THINKING_MAX_TOKENS_CAP));
}

/**
 * Body fields and `max_tokens` for one Anthropic Messages API request to
 * `modelId` at the given effort. Models that predate effort (Claude 4.x and
 * earlier, unknown ids) get no extra fields and the requested `max_tokens`.
 */
export function anthropicRequestTuning(
  modelId: string,
  options: { effort: InferenceEffort; maxTokens: number },
): AnthropicRequestTuning {
  const maxTokens =
    Number.isFinite(options.maxTokens) && options.maxTokens > 0
      ? Math.floor(options.maxTokens)
      : 1_024;
  const rules = anthropicRules(modelId);
  if (!rules.effort) return { body: {}, maxTokens };
  if (options.effort === 'minimal' && rules.off) {
    return { body: { thinking: rules.off, output_config: { effort: 'low' } }, maxTokens };
  }
  const level = options.effort === 'medium' ? 'medium' : 'low';
  return { body: { output_config: { effort: level } }, maxTokens: withHeadroom(maxTokens, level) };
}

// Models that accept `reasoning_effort: 'none'` / `'minimal'` (LiteLLM
// `supports_none_reasoning_effort` / `supports_minimal_reasoning_effort`).
const OPENAI_NONE_EFFORT_RE =
  /^gpt-(?:6-(?:luna|sol)|6\.1-terra|5\.6(?:-(?:sol|terra|luna))?|5\.5|5\.4(?:-(?:mini|nano))?|5\.3-codex|5\.2|5\.1)$/;
const OPENAI_MINIMAL_EFFORT_RE = /^gpt-5(?:-(?:mini|nano|pro|chat))?$|^gpt-5\.2-pro$/;

/**
 * The `reasoning_effort` to send an OpenAI reasoning model for the given
 * effort. `minimal` becomes the lowest value the model accepts.
 */
export function openAiReasoningEffort(
  modelId: string,
  effort: InferenceEffort,
): OpenAiReasoningEffort {
  if (effort === 'medium') return 'medium';
  if (effort === 'low') return 'low';
  const id = canonicalModelId(modelId);
  if (OPENAI_NONE_EFFORT_RE.test(id)) return 'none';
  if (OPENAI_MINIMAL_EFFORT_RE.test(id)) return 'minimal';
  return 'low';
}
