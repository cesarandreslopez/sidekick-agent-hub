/**
 * @fileoverview Claude API client using direct API key authentication.
 *
 * This client uses the official @anthropic-ai/sdk to make requests
 * directly to the Anthropic API with an API key.
 *
 * @module ApiKeyClient
 */

import Anthropic from '@anthropic-ai/sdk';
import { ClaudeClient, CompletionOptions } from '../types';
import { requestWithTimeout } from '../utils/requestWithTimeout';

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
      const message = await this.client.messages.create(
        {
          model: this.mapModel(options?.model),
          max_tokens: options?.maxTokens ?? 1024,
          messages: [{ role: 'user', content: prompt }],
        },
        { signal }
      );

      const textBlock = message.content.find(b => b.type === 'text');
      return textBlock?.text ?? '';
    });
  }

  /**
   * Tests if the API key is valid by making a minimal request.
   *
   * @returns Promise resolving to true if the API key works
   */
  async isAvailable(): Promise<boolean> {
    try {
      // Simple test call with minimal tokens
      await this.client.messages.create({
        model: 'claude-3-5-haiku-20241022',
        max_tokens: 10,
        messages: [{ role: 'user', content: 'test' }],
      });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Maps shorthand model names to full Anthropic model IDs.
   *
   * @param model - Shorthand model name or undefined
   * @returns Full Anthropic model ID
   */
  private mapModel(model?: string): string {
    switch (model) {
      case 'haiku':
        return 'claude-3-5-haiku-20241022';
      case 'sonnet':
        return 'claude-sonnet-4-20250514';
      case 'opus':
        return 'claude-opus-4-20250514';
      default:
        return 'claude-3-5-haiku-20241022';
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
