/**
 * @fileoverview Service for generating commit messages using Claude.
 *
 * CommitMessageService orchestrates the full commit message generation flow:
 * retrieving diffs, filtering noise, truncating to fit token limits, calling
 * Claude API, and cleaning the response. It handles errors gracefully and
 * provides user-friendly feedback.
 *
 * @module CommitMessageService
 */

import * as vscode from 'vscode';
import { GitService } from './GitService';
import { AuthService } from './AuthService';
import { resolveModel } from './ModelResolver';
import { TimeoutManager, getTimeoutManager } from './TimeoutManager';
import { log, logError } from './Logger';
import { filterDiff } from '../utils/diffFilter';
import { estimateTokens, truncateDiffIntelligently } from '../utils/tokenEstimator';
import {
  getCommitMessageSystemPrompt,
  getCommitMessageUserPrompt,
  cleanCommitMessage,
} from '../utils/prompts';

/**
 * Result from commit message generation.
 */
export interface CommitMessageResult {
  /** Generated commit message, or null if generation failed */
  message: string | null;
  /** Error message if generation failed */
  error?: string;
  /** Whether the diff was from staged or unstaged changes */
  diffType?: 'staged' | 'unstaged';
  /** Path to the repository where changes were found */
  repoPath?: string;
}

/**
 * Service for generating commit messages using Claude AI.
 *
 * This service:
 * - Retrieves diffs from GitService
 * - Filters out binary files, lockfiles, and generated code
 * - Truncates diffs intelligently to stay within token limits
 * - Calls Claude Haiku via AuthService
 * - Cleans and validates the response
 * - Provides detailed error handling for different API error types
 *
 * @example
 * ```typescript
 * const service = new CommitMessageService(gitService, authService);
 * const result = await service.generateCommitMessage();
 * if (result.message) {
 *   console.log(`Generated: ${result.message}`);
 * } else if (result.error) {
 *   console.error(`Error: ${result.error}`);
 * }
 * ```
 */
export class CommitMessageService implements vscode.Disposable {
  private readonly timeoutManager: TimeoutManager;

  /**
   * Creates a new CommitMessageService.
   *
   * @param gitService - Git service for retrieving diffs
   * @param authService - Auth service for Claude API access
   */
  constructor(
    private readonly gitService: GitService,
    private readonly authService: AuthService
  ) {
    this.timeoutManager = getTimeoutManager();
  }

  /**
   * Generates a commit message based on current git changes.
   *
   * This method:
   * 1. Retrieves diff from GitService (staged preferred, falls back to unstaged)
   * 2. Filters out binary files, lockfiles, and generated code
   * 3. Estimates tokens and truncates if needed
   * 4. Builds prompt using template functions
   * 5. Calls Claude via AuthService
   * 6. Cleans and validates the response
   *
   * @param guidance - Optional user guidance for regeneration (e.g., "focus on the bug fix")
   * @returns Promise resolving to commit message result
   */
  async generateCommitMessage(guidance?: string): Promise<CommitMessageResult> {
    try {
      log('CommitMessageService: Starting commit message generation');

      // Get diff from GitService
      const changes = await this.gitService.getChangesForCommit();
      if (!changes) {
        log('CommitMessageService: No changes found');
        return {
          message: null,
          error: 'No changes to commit. Stage or modify some files first.',
        };
      }

      log(`CommitMessageService: Got ${changes.type} diff, ${changes.diff.length} characters`);

      // Filter out noise (binary, lockfiles, generated)
      const filtered = filterDiff(changes.diff);
      log(`CommitMessageService: After filtering: ${filtered.length} characters`);

      if (filtered.trim().length === 0) {
        log('CommitMessageService: Diff is empty after filtering');
        return {
          message: null,
          error: 'No meaningful changes to analyze (only binary/lockfiles/generated code).',
        };
      }

      // Estimate tokens and truncate if needed
      const tokens = estimateTokens(filtered);
      log(`CommitMessageService: Estimated ${tokens} tokens`);

      const truncated = truncateDiffIntelligently(filtered);
      if (truncated.length < filtered.length) {
        log(`CommitMessageService: Truncated diff from ${filtered.length} to ${truncated.length} characters`);
      }

      // Read user's preferences
      const config = vscode.workspace.getConfiguration('sidekick');
      const style = config.get<'conventional' | 'simple'>('commitMessageStyle') ?? 'conventional';
      const model = resolveModel(config.get<string>('commitMessageModel') ?? 'auto', this.authService.getProviderId(), 'commitMessageModel');
      const defaultGuidance = config.get<string>('commitMessageGuidance') ?? '';

      // Combine default guidance with user-provided guidance
      const combinedGuidance = [defaultGuidance, guidance]
        .filter((g): g is string => typeof g === 'string' && g.trim().length > 0)
        .join('. ');
      log(`CommitMessageService: Using style=${style}, model=${model}, guidance=${combinedGuidance || 'none'}`);

      // Build prompt
      const systemPrompt = getCommitMessageSystemPrompt(style);
      const userPrompt = getCommitMessageUserPrompt(truncated, combinedGuidance);
      const fullPrompt = `${systemPrompt}\n\n${userPrompt}`;

      log(`CommitMessageService: Calling Claude API (model: ${model}, maxTokens: 100)`);

      // Calculate context size for timeout scaling
      const contextSize = new TextEncoder().encode(fullPrompt).length;
      const timeoutConfig = this.timeoutManager.getTimeoutConfig('commitMessage');

      // Call API via AuthService with timeout management
      const opLabel = `Generating commit message via ${this.authService.getProviderDisplayName()} · ${model}`;
      const result = await this.timeoutManager.executeWithTimeout({
        operation: opLabel,
        task: (signal: AbortSignal) => this.authService.complete(fullPrompt, {
          model,
          maxTokens: 100,
          signal,
        }),
        config: timeoutConfig,
        contextSize,
        showProgress: true,
        cancellable: true,
        onTimeout: (timeoutMs: number, contextKb: number) =>
          this.timeoutManager.promptRetry(opLabel, timeoutMs, contextKb),
      });

      if (!result.success) {
        if (result.timedOut) {
          return {
            message: null,
            error: `Request timed out after ${result.timeoutMs}ms. Try again or increase timeout in settings.`,
          };
        }
        if (result.error?.name === 'AbortError') {
          return { message: null }; // User cancelled
        }
        return {
          message: null,
          error: result.error?.message ?? 'Unknown error',
        };
      }

      const response = result.result!;
      log(`CommitMessageService: Received response: ${response.substring(0, 100)}`);

      // Clean and validate response
      const cleaned = cleanCommitMessage(response);
      if (!cleaned) {
        log('CommitMessageService: Response failed validation');
        return {
          message: null,
          error: 'Could not generate a valid commit message. Try with different changes.',
        };
      }

      log(`CommitMessageService: Successfully generated: ${cleaned}`);

      return {
        message: cleaned,
        diffType: changes.type,
        repoPath: changes.repoPath,
      };
    } catch (error) {
      logError('CommitMessageService: Generation failed', error);

      // Distinguish error types for better user feedback
      if (error instanceof Error && error.name === 'AbortError') {
        return { message: null };
      }

      let errorMessage: string;
      const msg = error instanceof Error ? error.message : '';
      if (/rate.?limit/i.test(msg) || (error instanceof Error && error.name === 'RateLimitError')) {
        errorMessage = 'API rate limit exceeded. Please try again in a moment.';
      } else if (/auth/i.test(msg) || (error instanceof Error && error.name === 'AuthenticationError')) {
        errorMessage = 'Authentication failed. Check your API key or provider setup.';
      } else if (/internal.?server/i.test(msg) || (error instanceof Error && error.name === 'InternalServerError')) {
        errorMessage = 'The AI provider is experiencing issues. Please try again.';
      } else if (error instanceof Error) {
        errorMessage = error.message;
      } else {
        errorMessage = 'An unexpected error occurred.';
      }

      return { message: null, error: errorMessage };
    }
  }

  /**
   * Disposes of all resources.
   *
   * Implements vscode.Disposable for proper cleanup.
   */
  dispose(): void {
    // No resources to clean up currently
  }
}
