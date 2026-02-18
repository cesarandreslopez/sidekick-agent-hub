/**
 * @fileoverview Authentication / inference provider service.
 *
 * AuthService is the main entry point for AI inference. It manages
 * switching between providers (Claude Max, Claude API, OpenCode, Codex),
 * handles configuration changes, and manages client lifecycle.
 *
 * @module AuthService
 */

import * as vscode from 'vscode';
import { AuthMode, ClaudeClient, CompletionOptions } from '../types';
import type { InferenceProviderId } from '../types/inferenceProvider';
import { PROVIDER_DISPLAY_NAMES } from '../types/inferenceProvider';
import { SecretsManager } from './SecretsManager';
import { ApiKeyClient } from './ApiKeyClient';
import { MaxSubscriptionClient } from './MaxSubscriptionClient';
import { detectInferenceProvider } from './providers/ProviderDetector';
import { log } from './Logger';

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
 * Central authentication / inference provider service.
 *
 * This service:
 * - Manages switching between inference providers
 * - Lazily initializes the appropriate client
 * - Listens for configuration changes and updates accordingly
 * - Implements Disposable for proper cleanup
 */
export class AuthService implements vscode.Disposable {
  /** Current inference client instance (lazily initialized) */
  private client: ClaudeClient | undefined;

  /** Current authentication mode (legacy, kept for backward compat) */
  private mode: AuthMode;

  /** Resolved inference provider ID */
  private providerId: InferenceProviderId;

  /** Disposables to clean up on dispose */
  private disposables: vscode.Disposable[] = [];

  /** Secrets manager for API key storage */
  private secretsManager: SecretsManager;

  constructor(context: vscode.ExtensionContext) {
    this.secretsManager = new SecretsManager(context.secrets);
    this.mode = this.getConfiguredMode();
    this.providerId = this.resolveProviderId();

    log(`AuthService: provider=${this.providerId}, legacyMode=${this.mode}`);

    // Listen for configuration changes
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration(e => {
        if (
          e.affectsConfiguration('sidekick.inferenceProvider') ||
          e.affectsConfiguration('sidekick.authMode')
        ) {
          this.handleProviderChange();
        }
      })
    );
  }

  /**
   * Resolves the effective InferenceProviderId.
   *
   * Priority:
   * 1. sidekick.inferenceProvider (if not "auto")
   * 2. Auto-detect via ProviderDetector filesystem heuristics
   * 3. Legacy: sidekick.authMode mapping
   * 4. Default: claude-max
   */
  private resolveProviderId(): InferenceProviderId {
    const config = vscode.workspace.getConfiguration('sidekick');
    const explicit = config.get<string>('inferenceProvider');

    if (explicit && explicit !== 'auto') {
      return explicit as InferenceProviderId;
    }

    // If legacy authMode is explicitly set to api-key, honour it
    const inspected = config.inspect<string>('authMode');
    const authModeExplicit =
      inspected?.workspaceValue ?? inspected?.globalValue ?? inspected?.workspaceFolderValue;
    if (authModeExplicit === 'api-key') {
      return 'claude-api';
    }

    // Auto-detect from filesystem
    return detectInferenceProvider();
  }

  /** Gets the legacy auth mode (kept for backward compat). */
  private getConfiguredMode(): AuthMode {
    const config = vscode.workspace.getConfiguration('sidekick');
    return config.get<AuthMode>('authMode') ?? 'max-subscription';
  }

  /** Handles provider / auth mode configuration changes. */
  private async handleProviderChange(): Promise<void> {
    const newMode = this.getConfiguredMode();
    const newProvider = this.resolveProviderId();

    if (newProvider !== this.providerId || newMode !== this.mode) {
      log(`AuthService: provider changing from ${this.providerId} to ${newProvider}`);
      this.mode = newMode;
      this.providerId = newProvider;
      this.client?.dispose();
      this.client = undefined;
    }
  }

  /**
   * Gets or creates the appropriate client for the current provider.
   */
  async getClient(): Promise<ClaudeClient> {
    if (this.client) return this.client;

    switch (this.providerId) {
      case 'claude-api': {
        const apiKey = await this.secretsManager.getApiKey();
        if (!apiKey) {
          throw new Error(
            'API key not configured. Run "Sidekick: Set API Key" command.'
          );
        }
        this.client = new ApiKeyClient(apiKey);
        break;
      }
      case 'opencode': {
        const { OpenCodeClient } = await import('./OpenCodeClient');
        this.client = new OpenCodeClient();
        break;
      }
      case 'codex': {
        const { CodexClient } = await import('./CodexClient');
        this.client = new CodexClient();
        break;
      }
      case 'claude-max':
      default:
        this.client = new MaxSubscriptionClient();
        break;
    }

    return this.client;
  }

  /**
   * Sends a prompt and returns the completion.
   */
  async complete(prompt: string, options?: CompletionOptions): Promise<string> {
    const client = await this.getClient();
    return client.complete(prompt, options);
  }

  /**
   * Tests the connection using the current provider.
   */
  async testConnection(): Promise<ConnectionTestResult> {
    try {
      const client = await this.getClient();
      const available = await client.isAvailable();

      if (available) {
        const name = PROVIDER_DISPLAY_NAMES[this.providerId];
        return {
          success: true,
          message: `Connected successfully via ${name}.`,
        };
      }

      switch (this.providerId) {
        case 'claude-max':
          return {
            success: false,
            message:
              'Claude Code CLI not found. Install it with: npm install -g @anthropic-ai/claude-code\n\n' +
              'If already installed (e.g., via pnpm), set the path in Settings > Sidekick > Claude Path.\n' +
              'Find your claude path with: which claude (Linux/Mac) or where claude (Windows)',
          };
        case 'claude-api':
          return {
            success: false,
            message: 'API key authentication failed. Please check your API key.',
          };
        case 'opencode':
          return {
            success: false,
            message: 'OpenCode not found. Install it from https://opencode.ai',
          };
        case 'codex':
          return {
            success: false,
            message: 'Codex CLI not found. Install it from https://github.com/openai/codex',
          };
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Unknown error';
      return { success: false, message };
    }
  }

  /** Returns the current inference provider ID. */
  getProviderId(): InferenceProviderId {
    return this.providerId;
  }

  /** Returns a human-readable display name for the active provider. */
  getProviderDisplayName(): string {
    return PROVIDER_DISPLAY_NAMES[this.providerId];
  }

  /** @deprecated Use getProviderId(). Returns the legacy AuthMode. */
  getMode(): AuthMode {
    return this.mode;
  }

  /** Gets the SecretsManager instance for API key management. */
  getSecretsManager(): SecretsManager {
    return this.secretsManager;
  }

  dispose(): void {
    this.client?.dispose();
    this.disposables.forEach(d => d.dispose());
  }
}
