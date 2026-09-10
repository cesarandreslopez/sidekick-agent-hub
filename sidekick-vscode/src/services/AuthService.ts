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
import { AuthMode, ClaudeClient, CompletionOptions, TimeoutError } from '../types';
import type { InferenceProviderId } from '../types/inferenceProvider';
import { PROVIDER_DISPLAY_NAMES } from '../types/inferenceProvider';
import { SecretsManager } from './SecretsManager';
import { ApiKeyClient } from './ApiKeyClient';
import { MaxSubscriptionClient } from './MaxSubscriptionClient';
import { detectInferenceProvider } from './providers/ProviderDetector';
import { log } from './Logger';
import { ProviderRequestError } from '../utils/providerFailure';
import type { ProviderFailureDiagnosis } from 'sidekick-shared';

/**
 * Result from testing the connection.
 */
export interface ConnectionTestResult {
  diagnosis?: ProviderFailureDiagnosis;
  observation?: 'request' | 'local-readiness';
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
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (
          e.affectsConfiguration('sidekick.inferenceProvider') ||
          e.affectsConfiguration('sidekick.authMode')
        ) {
          this.handleProviderChange();
        }
      }),
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
          throw new Error('API key not configured. Run "Sidekick: Set API Key" command.');
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
    const providerId = this.providerId;
    try {
      const client = await this.getClient();
      return await client.complete(prompt, options);
    } catch (error) {
      if (error instanceof TimeoutError || (error instanceof Error && error.name === 'AbortError'))
        throw error;
      throw this.diagnoseFailure(error, providerId);
    }
  }

  /**
   * Tests the connection using the current provider.
   */
  async testConnection(): Promise<ConnectionTestResult> {
    const providerId = this.providerId;
    try {
      const client = await this.getClient();
      const available = await client.isAvailable();

      if (available) {
        const name = PROVIDER_DISPLAY_NAMES[providerId];
        return {
          success: true,
          observation: providerId === 'claude-api' ? 'request' : 'local-readiness',
          message:
            providerId === 'claude-api'
              ? `Request succeeded via ${name}.`
              : `${name} is available locally. Request authentication has not been verified.`,
        };
      }

      switch (providerId) {
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
            message:
              'The API readiness check did not succeed. No credential rejection was established.',
          };
        case 'opencode':
          return {
            success: false,
            message: 'OpenCode not found. Install it from https://opencode.ai',
          };
        case 'codex':
          return {
            success: false,
            message: 'Codex readiness could not be established. Check the CLI and credentials.',
          };
      }
    } catch (error) {
      const failure = this.diagnoseFailure(error, providerId);
      return {
        success: false,
        message: failure instanceof Error ? failure.message : 'Unknown error',
        ...(failure instanceof ProviderRequestError ? { diagnosis: failure.diagnosis } : {}),
      };
    }
  }

  private diagnoseFailure(error: unknown, providerId: InferenceProviderId): unknown {
    if (providerId === 'opencode' || error instanceof ProviderRequestError) return error;
    return new ProviderRequestError({
      provider: providerId === 'codex' ? 'codex' : 'claude-code',
      credentialKind: providerId === 'claude-api' ? 'api-key' : 'unknown',
      error,
    });
  }

  /** Resets the cached client so the next call creates a fresh one (e.g. after account switch). */
  resetClient(): void {
    log('AuthService: resetting client (account switch)');
    this.client?.dispose();
    this.client = undefined;
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
    this.disposables.forEach((d) => d.dispose());
  }
}
