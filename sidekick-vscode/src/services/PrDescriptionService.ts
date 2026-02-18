/**
 * @fileoverview Service for AI-powered PR description generation.
 *
 * PrDescriptionService orchestrates PR description generation: analyzing branch
 * commits and diff, calling Claude for summarization, and copying to clipboard.
 *
 * @module PrDescriptionService
 */

import * as vscode from 'vscode';
import { GitService } from './GitService';
import { AuthService } from './AuthService';
import { resolveModel } from './ModelResolver';
import { TimeoutManager, getTimeoutManager } from './TimeoutManager';
import { log, logError } from './Logger';
import { filterDiff } from '../utils/diffFilter';
import { truncateDiffIntelligently } from '../utils/tokenEstimator';
import { getPrDescriptionPrompt, cleanPrDescription } from '../utils/prompts';

/**
 * Result from PR description generation.
 */
export interface PrDescriptionResult {
  /** Generated PR description (Markdown), or null if failed */
  description: string | null;
  /** Error message if generation failed */
  error?: string;
  /** Number of commits analyzed */
  commitCount?: number;
}

/**
 * Service for AI-powered PR description generation.
 *
 * This service:
 * - Detects base branch (upstream tracking or user prompt)
 * - Gets all commits on current branch vs base
 * - Gets diff between branch and base
 * - Calls Claude Sonnet for description generation
 * - Copies result to clipboard
 *
 * @example
 * ```typescript
 * const service = new PrDescriptionService(gitService, authService);
 * const result = await service.generatePrDescription();
 * if (result.description) {
 *   // Description already copied to clipboard
 *   console.log(`Generated from ${result.commitCount} commits`);
 * }
 * ```
 */
export class PrDescriptionService implements vscode.Disposable {
  private readonly timeoutManager: TimeoutManager;

  /**
   * Creates a new PrDescriptionService.
   *
   * @param gitService - Git service for retrieving commits and diff
   * @param authService - Auth service for Claude API access
   */
  constructor(
    private readonly gitService: GitService,
    private readonly authService: AuthService
  ) {
    this.timeoutManager = getTimeoutManager();
  }

  /**
   * Generates a PR description from current branch commits and diff.
   *
   * @returns Promise resolving to PR description result
   */
  async generatePrDescription(): Promise<PrDescriptionResult> {
    try {
      log('PrDescriptionService: Starting generation');

      // Get repository
      const repository = this.gitService.getActiveRepository();
      if (!repository) {
        return { description: null, error: 'No Git repository found' };
      }

      // Detect base branch
      const baseBranch = await this.detectBaseBranch(repository.rootUri.fsPath);
      log(`PrDescriptionService: Using base branch '${baseBranch}'`);

      // Get commits on this branch
      const commits = await this.gitService.getBranchCommits(repository, baseBranch);
      if (commits.length === 0) {
        return {
          description: null,
          error: `No commits found on current branch vs ${baseBranch}. Are you on a feature branch?`
        };
      }

      log(`PrDescriptionService: Found ${commits.length} commits`);

      // Get diff
      const diff = await this.gitService.getBranchDiff(repository, baseBranch);
      if (diff.trim().length === 0) {
        return {
          description: null,
          error: `No diff found vs ${baseBranch}. Branch may already be merged.`
        };
      }

      // Filter and truncate diff
      const filtered = filterDiff(diff);
      const truncated = truncateDiffIntelligently(filtered, 5000);

      // Get model preference
      const config = vscode.workspace.getConfiguration('sidekick');
      const model = resolveModel(config.get<string>('prDescriptionModel') ?? 'auto', this.authService.getProviderId(), 'prDescriptionModel');

      log(`PrDescriptionService: Calling Claude (model: ${model})`);

      // Build prompt and call Claude with timeout management
      const prompt = getPrDescriptionPrompt(commits, truncated);
      const contextSize = new TextEncoder().encode(prompt).length;
      const timeoutConfig = this.timeoutManager.getTimeoutConfig('prDescription');

      const opLabel = `Generating PR description via ${this.authService.getProviderDisplayName()} · ${model}`;
      const result = await this.timeoutManager.executeWithTimeout({
        operation: opLabel,
        task: (signal: AbortSignal) => this.authService.complete(prompt, {
          model,
          maxTokens: 1000,
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
          return { description: null, error: `Request timed out after ${result.timeoutMs}ms. Try again or increase timeout in settings.` };
        }
        if (result.error?.name === 'AbortError') {
          return { description: null, error: 'Request cancelled' };
        }
        return { description: null, error: result.error?.message ?? 'Unknown error' };
      }

      const response = result.result!;
      log(`PrDescriptionService: Got response, ${response.length} characters`);

      // Clean and format description
      const description = cleanPrDescription(response);
      if (!description) {
        return { description: null, error: 'Could not generate valid PR description' };
      }

      // Copy to clipboard
      await vscode.env.clipboard.writeText(description);
      log('PrDescriptionService: Copied to clipboard');

      return {
        description,
        commitCount: commits.length
      };
    } catch (error) {
      logError('PrDescriptionService: Generation failed', error);
      const message = error instanceof Error ? error.message : 'Unknown error';
      return { description: null, error: message };
    }
  }

  /**
   * Detects the base branch for the current branch.
   * Tries upstream tracking first, falls back to user prompt.
   *
   * @param repoPath - The repository root path
   * @returns Promise resolving to base branch name
   */
  private async detectBaseBranch(repoPath: string): Promise<string> {
    try {
      // Try to get upstream tracking branch
      // execGit accepts repoPath string directly (no type casting needed)
      const result = await this.gitService.execGit(
        repoPath,
        ['rev-parse', '--abbrev-ref', '@{u}']
      );

      // Parse "origin/main" -> "main"
      const upstream = result.trim();
      const branchName = upstream.split('/').pop() || 'main';
      log(`PrDescriptionService: Detected upstream branch '${branchName}'`);
      return branchName;
    } catch {
      // No upstream - prompt user
      log('PrDescriptionService: No upstream, prompting user');
      const branch = await vscode.window.showInputBox({
        prompt: 'Compare with which base branch?',
        value: 'main',
        placeHolder: 'main, master, develop...'
      });
      return branch || 'main';
    }
  }

  /**
   * Disposes of all resources.
   */
  dispose(): void {
    // No resources to clean up currently
  }
}
