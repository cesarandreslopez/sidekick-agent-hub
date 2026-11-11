/**
 * @fileoverview Claude API client using direct API key authentication.
 *
 * This client uses the official @anthropic-ai/sdk to make requests
 * directly to the Anthropic API with an API key.
 *
 * @module ApiKeyClient
 */

import Anthropic from '@anthropic-ai/sdk';
import { anthropicRequestTuning, type InferenceEffort } from 'sidekick-shared';
import { ClaudeClient, CompletionOptions } from '../types';
import { DEFAULT_MODEL_MAPPINGS } from '../types/inferenceProvider';
import { requestWithTimeout } from '../utils/requestWithTimeout';

/** Claude Fable 5.2, for a literal `fable`. Not a tier: it costs twice Opus. */
const FABLE_MODEL = 'claude-fable-5-2';

/**
 * A Messages API request with the per-model `thinking` / `output_config`
 * fields from `anthropicRequestTuning`. The pinned 0.71 SDK's types predate
 * `output_config` and the `between_tools` thinking mode, but the SDK sends
 * the body unchanged (and on `anthropic-version: 2023-06-01`, which accepts
 * both), so the body is cast at the one call site that builds it.
 */
function tunedRequest(
  model: string,
  prompt: string,
  effort: InferenceEffort,
  maxTokens: number,
): Anthropic.MessageCreateParamsNonStreaming {
  const tuning = anthropicRequestTuning(model, { effort, maxTokens });
  return {
    model,
    max_tokens: tuning.maxTokens,
    messages: [{ role: 'user', content: prompt }],
    ...tuning.body,
  } as unknown as Anthropic.MessageCreateParamsNonStreaming;
}

/**
 * Claude client using API key authentication.
 *
 * Uses @anthropic-ai/sdk for direct API access. Requires a valid
 * Anthropic API key which will be billed per usage.
 *
 * @example
 * ```typescript
 * const client = new ApiKeyClient('sk-ant-...');
 * const response = await client.complete('Hello!');
 * ```
 */
export class ApiKeyClient implements ClaudeClient {
  /** The underlying Anthropic SDK client */
  private client: Anthropic;

  /**
   * Creates a new ApiKeyClient.
   *
   * @param apiKey - Anthropic API key (starts with sk-ant-)
   */
  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey });
  }

  /**
   * Sends a prompt to Claude and returns the completion.
   *
   * @param prompt - The text prompt to send
   * @param options - Optional completion configuration
   * @returns Promise resolving to the completion text
   */
  async complete(prompt: string, options?: CompletionOptions): Promise<string> {
    return requestWithTimeout(options, async (signal) => {
      // Without an effort the request still gets `low`: models that think by
      // default need headroom, or a small `max_tokens` can return no text.
      const message = await this.client.messages.create(
        tunedRequest(
          this.mapModel(options?.model),
          prompt,
          options?.effort ?? 'low',
          options?.maxTokens ?? 1024,
        ),
        { signal },
      );

      // Current models may decline a request (HTTP 200, stop_reason
      // `refusal`); say so instead of returning an empty completion.
      if ((message.stop_reason as string | null) === 'refusal') {
        throw new Error('Claude declined this request (refusal). Try rephrasing or another model.');
      }
      const textBlock = message.content.find((b) => b.type === 'text');
      return textBlock?.text ?? '';
    });
  }

  /**
   * Tests if the API key is valid by making a minimal request.
   *
   * @returns Promise resolving to true if the API key works
   */
  async isAvailable(): Promise<boolean> {
    // Preserve the request error so callers can distinguish auth, service and network failures.
    await this.client.messages.create(
      tunedRequest(DEFAULT_MODEL_MAPPINGS['claude-api'].fast, 'test', 'minimal', 10),
    );
    return true;
  }

  /**
   * Maps shorthand model names to full Anthropic model IDs: the Claude API
   * tier defaults for `haiku`, `sonnet` and `opus`, and Fable 5.2 for
   * `fable`. Anything else is a literal model ID.
   *
   * @param model - Shorthand model name or undefined
   * @returns Full Anthropic model ID
   */
  private mapModel(model?: string): string {
    const tiers = DEFAULT_MODEL_MAPPINGS['claude-api'];
    switch (model) {
      case 'haiku':
        return tiers.fast;
      case 'sonnet':
        return tiers.balanced;
      case 'opus':
        return tiers.powerful;
      case 'fable':
        return FABLE_MODEL;
      default:
        return model ?? tiers.fast;
    }
  }

  /**
   * Disposes of the client resources.
   *
   * No cleanup needed for API key client as there are no
   * persistent connections or subscriptions.
   */
  dispose(): void {
    // No cleanup needed for API key client
  }
}
