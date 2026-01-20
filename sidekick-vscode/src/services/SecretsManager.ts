/**
 * @fileoverview Secure API key storage using VS Code's SecretStorage.
 *
 * This module provides a wrapper around VS Code's SecretStorage API
 * for securely storing and retrieving the Anthropic API key.
 * It also checks environment variables as a fallback.
 *
 * @module SecretsManager
 */

import * as vscode from 'vscode';

/**
 * Manages secure storage of API keys using VS Code's SecretStorage.
 *
 * The API key can be provided via:
 * 1. Environment variable (ANTHROPIC_API_KEY) - checked first
 * 2. VS Code SecretStorage - secure, persisted storage
 *
 * @example
 * ```typescript
 * const secrets = new SecretsManager(context.secrets);
 * const apiKey = await secrets.getApiKey();
 * if (apiKey) {
 *   // Use the API key
 * }
 * ```
 */
export class SecretsManager {
  /** Key used in VS Code's SecretStorage */
  private static readonly API_KEY_KEY = 'sidekick.apiKey';

  /**
   * Creates a new SecretsManager instance.
   *
   * @param secrets - VS Code's SecretStorage from extension context
   */
  constructor(private secrets: vscode.SecretStorage) {}

  /**
   * Retrieves the API key from environment or secure storage.
   *
   * Checks in order:
   * 1. ANTHROPIC_API_KEY environment variable
   * 2. VS Code SecretStorage
   *
   * @returns Promise resolving to the API key, or undefined if not set
   */
  async getApiKey(): Promise<string | undefined> {
    // Check environment variable first (allows CI/testing override)
    const envKey = process.env.ANTHROPIC_API_KEY;
    if (envKey) {
      return envKey;
    }

    // Then check secure storage
    return this.secrets.get(SecretsManager.API_KEY_KEY);
  }

  /**
   * Stores an API key in VS Code's secure storage.
   *
   * @param key - The API key to store
   */
  async setApiKey(key: string): Promise<void> {
    await this.secrets.store(SecretsManager.API_KEY_KEY, key);
  }

  /**
   * Removes the stored API key from secure storage.
   */
  async deleteApiKey(): Promise<void> {
    await this.secrets.delete(SecretsManager.API_KEY_KEY);
  }

  /**
   * Checks if an API key is available (from env or storage).
   *
   * @returns Promise resolving to true if an API key is available
   */
  async hasApiKey(): Promise<boolean> {
    const key = await this.getApiKey();
    return !!key;
  }
}
