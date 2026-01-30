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

  /**
   * External AbortSignal for request cancellation.
   * When provided, the request will be cancelled if this signal is aborted.
   * This is in addition to internal timeout handling.
   */
  signal?: AbortSignal;
}

/**
 * Context for a completion request (used for caching).
 */
export interface CompletionContext {
  /** Programming language identifier */
  language: string;
  /** Model shorthand (haiku, sonnet, opus) */
  model: string;
  /** Code before cursor (last ~500 chars used for cache key) */
  prefix: string;
  /** Code after cursor (first ~200 chars used for cache key) */
  suffix: string;
  /** Whether this is a multi-line completion request */
  multiline: boolean;
  /** Filename for context */
  filename: string;
}

/**
 * Custom error class for request timeouts.
 * This survives the error chain so it can be properly identified
 * at any level of the call stack.
 */
export class TimeoutError extends Error {
  constructor(message: string, public readonly timeoutMs: number) {
    super(message);
    this.name = 'TimeoutError';
  }
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
