/**
 * @fileoverview Authentication service managing dual-auth abstraction.
 *
 * AuthService is the main entry point for Claude API access. It manages
 * switching between API key authentication and Max subscription authentication,
 * handling configuration changes and client lifecycle.
 *
 * @module AuthService
 */

import * as vscode from 'vscode';
import { AuthMode, ClaudeClient, CompletionOptions } from '../types';
import { SecretsManager } from './SecretsManager';
import { ApiKeyClient } from './ApiKeyClient';
import { MaxSubscriptionClient } from './MaxSubscriptionClient';

/**
 * Result from testing the connection.
 */
export interface ConnectionTestResult {
  /** Whether the connection test succeeded */
  success: boolean;
  /** Human-readable message about the result */
  message: string;
}

/**
 * Central authentication service managing Claude API access.
 *
 * This service:
 * - Manages switching between API key and Max subscription auth modes
 * - Lazily initializes the appropriate client
 * - Listens for configuration changes and updates accordingly
 * - Implements Disposable for proper cleanup
 *
 * @example
 * ```typescript
 * const authService = new AuthService(context);
 * context.subscriptions.push(authService);
 *
 * const response = await authService.complete('Hello!');
 * const testResult = await authService.testConnection();
 * ```
 */
export class AuthService implements vscode.Disposable {
  /** Current Claude client instance (lazily initialized) */
  private client: ClaudeClient | undefined;

  /** Current authentication mode */
  private mode: AuthMode;

  /** Disposables to clean up on dispose */
  private disposables: vscode.Disposable[] = [];

  /** Secrets manager for API key storage */
  private secretsManager: SecretsManager;

  /**
   * Creates a new AuthService.
   *
   * @param context - VS Code extension context for accessing secrets and configuration
   */
  constructor(context: vscode.ExtensionContext) {
    this.secretsManager = new SecretsManager(context.secrets);
    this.mode = this.getConfiguredMode();

    // Listen for configuration changes
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('sidekick.authMode')) {
          this.handleModeChange();
        }
      })
    );
  }

  /**
   * Gets the configured auth mode from VS Code settings.
   *
   * @returns The currently configured AuthMode
   */
  private getConfiguredMode(): AuthMode {
    const config = vscode.workspace.getConfiguration('sidekick');
    return config.get<AuthMode>('authMode') ?? 'max-subscription';
  }

  /**
   * Handles auth mode configuration changes.
   *
   * Disposes the current client so a new one will be created
   * with the new mode on next use.
   */
  private async handleModeChange(): Promise<void> {
    const newMode = this.getConfiguredMode();
    if (newMode !== this.mode) {
      this.mode = newMode;
      // Dispose old client so new one is created on next use
      this.client?.dispose();
      this.client = undefined;
    }
  }

  /**
   * Gets or creates the appropriate Claude client for the current mode.
   *
   * Lazily initializes the client on first use. For API key mode,
   * throws an error if no API key is configured.
   *
   * @returns Promise resolving to the ClaudeClient
   * @throws Error if API key mode is selected but no key is configured
   */
  async getClient(): Promise<ClaudeClient> {
    if (this.client) {
      return this.client;
    }

    if (this.mode === 'api-key') {
      const apiKey = await this.secretsManager.getApiKey();
      if (!apiKey) {
        throw new Error(
          'API key not configured. Run "Sidekick: Set API Key" command.'
        );
      }
      this.client = new ApiKeyClient(apiKey);
    } else {
      this.client = new MaxSubscriptionClient();
    }

    return this.client;
  }

  /**
   * Sends a prompt to Claude and returns the completion.
   *
   * Convenience method that gets the client and calls complete.
   *
   * @param prompt - The text prompt to send
   * @param options - Optional completion configuration
   * @returns Promise resolving to the completion text
   */
  async complete(prompt: string, options?: CompletionOptions): Promise<string> {
    const client = await this.getClient();
    return client.complete(prompt, options);
  }

  /**
   * Tests the connection to Claude using the current auth mode.
   *
   * @returns Promise resolving to success status and message
   */
  async testConnection(): Promise<ConnectionTestResult> {
    try {
      const client = await this.getClient();
      const available = await client.isAvailable();

      if (available) {
        return {
          success: true,
          message: `Connected successfully using ${this.mode} authentication.`,
        };
      } else {
        if (this.mode === 'max-subscription') {
          return {
            success: false,
            message:
              'Claude Code CLI not found. Please install it: npm install -g @anthropic-ai/claude-code',
          };
        }
        return {
          success: false,
          message: 'API key authentication failed. Please check your API key.',
        };
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Unknown error';
      return { success: false, message };
    }
  }

  /**
   * Gets the current authentication mode.
   *
   * @returns The current AuthMode
   */
  getMode(): AuthMode {
    return this.mode;
  }

  /**
   * Gets the SecretsManager instance for API key management.
   *
   * @returns The SecretsManager instance
   */
  getSecretsManager(): SecretsManager {
    return this.secretsManager;
  }

  /**
   * Disposes of all resources.
   *
   * Cleans up the current client and any event listeners.
   */
  dispose(): void {
    this.client?.dispose();
    this.disposables.forEach(d => d.dispose());
  }
}
