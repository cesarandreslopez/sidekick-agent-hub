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
    // Check for early abort
    if (options?.signal?.aborted) {
      const error = new Error('Request was cancelled');
      error.name = 'AbortError';
      throw error;
    }

    // Create abort controller for timeout
    const abortController = new AbortController();
    const timeoutMs = options?.timeout ?? 30000;
    const timeoutId = setTimeout(() => abortController.abort(), timeoutMs);

    // Link external signal to our internal abort controller
    let externalAbortHandler: (() => void) | undefined;
    if (options?.signal) {
      externalAbortHandler = () => abortController.abort();
      options.signal.addEventListener('abort', externalAbortHandler);
    }

    try {
      const message = await this.client.messages.create(
        {
          model: this.mapModel(options?.model),
          max_tokens: options?.maxTokens ?? 1024,
          messages: [{ role: 'user', content: prompt }],
        },
        { signal: abortController.signal }
      );

      const textBlock = message.content.find(b => b.type === 'text');
      return textBlock?.text ?? '';
    } catch (error) {
      // Check if it was a user cancellation vs timeout
      if (error instanceof Error && error.name === 'AbortError') {
        if (options?.signal?.aborted) {
          const abortError = new Error('Request was cancelled');
          abortError.name = 'AbortError';
          throw abortError;
        }
        // Import TimeoutError for timeout case
        const { TimeoutError } = await import('../types');
        throw new TimeoutError(`Request timed out after ${timeoutMs}ms`, timeoutMs);
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
      if (externalAbortHandler && options?.signal) {
        options.signal.removeEventListener('abort', externalAbortHandler);
      }
    }
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
