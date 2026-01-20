/**
 * @fileoverview Shared type definitions for the Sidekick extension.
 *
 * This module defines the core interfaces and types used throughout
 * the authentication and completion system.
 *
 * @module types
 */

/**
 * Authentication mode for connecting to Claude API.
 *
 * - 'api-key': Direct API key authentication via @anthropic-ai/sdk
 * - 'max-subscription': Use Claude Max subscription via @anthropic-ai/claude-agent-sdk
 */
export type AuthMode = 'api-key' | 'max-subscription';

/**
 * Options for completion requests.
 */
export interface CompletionOptions {
  /**
   * Model to use for completion.
   * Accepts shorthand names: 'haiku', 'sonnet', 'opus'
   */
  model?: string;

  /**
   * Maximum tokens to generate in the response.
   * @default 1024
   */
  maxTokens?: number;

  /**
   * Request timeout in milliseconds.
   * @default 30000
   */
  timeout?: number;
}

/**
 * Interface for Claude API clients.
 *
 * Both ApiKeyClient and MaxSubscriptionClient implement this interface,
 * allowing AuthService to use them interchangeably.
 */
export interface ClaudeClient {
  /**
   * Sends a prompt to Claude and returns the completion.
   *
   * @param prompt - The text prompt to send
   * @param options - Optional completion configuration
   * @returns Promise resolving to the completion text
   */
  complete(prompt: string, options?: CompletionOptions): Promise<string>;

  /**
   * Tests if the client can successfully connect to Claude.
   *
   * @returns Promise resolving to true if connection is available
   */
  isAvailable(): Promise<boolean>;

  /**
   * Disposes of any resources held by the client.
   */
  dispose(): void;
}
