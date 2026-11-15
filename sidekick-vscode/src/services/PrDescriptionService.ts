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
import { formatTimeoutSeconds } from '../utils/formatTimeout';
import { log, logError } from './Logger';
import { filterDiff } from '../utils/diffFilter';
import { truncateDiffIntelligently } from '../utils/tokenEstimator';
import { getPrDescriptionPrompt, cleanPrDescription } from '../utils/prompts';
import { featureEffort } from '../types/inferenceProvider';

/**
 * Result from PR description generation.
 */
export interface PrDescriptionResult {
  /** Generated PR description (Markdown), or null if failed */
  description: string | null;
  /** Error message if generation failed */
  error?: string;
  /**
   * The original error behind `error` when the request itself failed, so the
   * caller can offer a retry. Absent for no commits, timeouts, and cancellation.
   */
  cause?: unknown;
  /** Number of commits analyzed */
  commitCount?: number;
  /** Base branch the failed request compared against; pass it back to retry against the same base */
  baseBranch?: string;
  /** Set when the user cancelled, including declining a timeout retry; report nothing. */
  cancelled?: boolean;
  /** GitHub "open a pull request" page for this branch, when the remote is on GitHub */
  compareUrl?: string;
}

/**
 * Builds the GitHub compare page for opening a pull request, or `undefined`
 * when the remote is not a github.com repository.
 *
 * @param remoteUrl - `git remote get-url` output (HTTPS or SSH form)
 * @param base - Base branch; a remote prefix such as `origin/` is dropped
 * @param head - Current branch name
 */
export function githubCompareUrl(
  remoteUrl: string,
  base: string,
  head: string,
): string | undefined {
  const match = remoteUrl
    .trim()
    .match(
      /^(?:https?:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+)\/([^/]+?)(?:\.git)?\/?$/,
    );
  if (!match || !head || head === 'HEAD') return undefined;
  const baseName = base.replace(/^[^/]+\//, (prefix) =>
    prefix === 'origin/' || prefix === 'upstream/' ? '' : prefix,
  );
  const enc = (ref: string) => ref.split('/').map(encodeURIComponent).join('/');
  const repo = `https://github.com/${match[1]}/${match[2]}`;
  // An upstream of the same branch is no base; let GitHub pick the default branch.
  if (!baseName || baseName === head) return `${repo}/compare/${enc(head)}?expand=1`;
  return `${repo}/compare/${enc(baseName)}...${enc(head)}?expand=1`;
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
    private readonly authService: AuthService,
  ) {
    this.timeoutManager = getTimeoutManager();
  }

  /**
   * Generates a PR description from current branch commits and diff.
   *
   * @param base - Base branch to compare against; detected (possibly by
   *   prompting) when omitted
   * @param signal - Optional AbortSignal for external cancellation
   * @returns Promise resolving to PR description result
   */
  async generatePrDescription(base?: string, signal?: AbortSignal): Promise<PrDescriptionResult> {
    let baseBranch: string | undefined;
    try {
      log('PrDescriptionService: Starting generation');

      // Get repository
      const repository = this.gitService.getActiveRepository();
      if (!repository) {
        return { description: null, error: 'No Git repository found' };
      }

      // Detect base branch; undefined means the user dismissed the prompt
      baseBranch = base ?? (await this.detectBaseBranch(repository.rootUri.fsPath));
      if (baseBranch === undefined) {
        return { description: null, cancelled: true };
      }
      log(`PrDescriptionService: Using base branch '${baseBranch}'`);

      // Get commits on this branch
      const commits = await this.gitService.getBranchCommits(repository, baseBranch);
      if (commits.length === 0) {
        return {
          description: null,
          error: `No commits found on current branch vs ${baseBranch}. Are you on a feature branch?`,
        };
      }

      log(`PrDescriptionService: Found ${commits.length} commits`);

      // Get diff
      const diff = await this.gitService.getBranchDiff(repository, baseBranch);
      if (diff.trim().length === 0) {
        return {
          description: null,
          error: `No diff found vs ${baseBranch}. Branch may already be merged.`,
        };
      }

      // Filter and truncate diff
      const filtered = filterDiff(diff);
      const truncated = truncateDiffIntelligently(filtered, 5000);

      // Get model preference
      const config = vscode.workspace.getConfiguration('sidekick');
      const model = resolveModel(
        config.get<string>('prDescriptionModel') ?? 'auto',
        this.authService.getProviderId(),
        'prDescriptionModel',
      );

      log(`PrDescriptionService: Calling Claude (model: ${model})`);

      // Build prompt and call Claude with timeout management
      const prompt = getPrDescriptionPrompt(commits, truncated);
      const contextSize = new TextEncoder().encode(prompt).length;
      const timeoutConfig = this.timeoutManager.getTimeoutConfig('prDescription');

      const opLabel = `Generating PR description via ${this.authService.getProviderDisplayName()} · ${model}`;
      const result = await this.timeoutManager.executeWithTimeout({
        operation: opLabel,
        task: (signal: AbortSignal) =>
          this.authService.complete(prompt, {
            model,
            effort: featureEffort('prDescriptionModel'),
            maxTokens: 1000,
            signal,
          }),
        config: timeoutConfig,
        contextSize,
        showProgress: true,
        cancellable: true,
        externalSignal: signal,
        onTimeout: (timeoutMs: number, contextKb: number) =>
          this.timeoutManager.promptRetry(opLabel, timeoutMs, contextKb),
      });

      if (!result.success) {
        if (result.timedOut && result.retryDeclined) {
          return { description: null, cancelled: true };
        }
        if (result.timedOut) {
          return {
            description: null,
            error: `Request timed out after ${formatTimeoutSeconds(result.timeoutMs)}. Try again or increase the timeout in settings.`,
            baseBranch,
          };
        }
        if (result.error?.name === 'AbortError') {
          return { description: null, cancelled: true };
        }
        return {
          description: null,
          error: result.error?.message ?? 'Unknown error',
          cause: result.error,
          baseBranch,
        };
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
        commitCount: commits.length,
        compareUrl: await this.findCompareUrl(repository.rootUri.fsPath, baseBranch),
      };
    } catch (error) {
      logError('PrDescriptionService: Generation failed', error);
      const message = error instanceof Error ? error.message : 'Unknown error';
      return { description: null, error: message, cause: error, baseBranch };
    }
  }

  /**
   * Detects the base branch for the current branch.
   * Tries upstream tracking first, falls back to user prompt.
   *
   * @param repoPath - The repository root path
   * @returns Promise resolving to base branch name
   */
  private async detectBaseBranch(repoPath: string): Promise<string | undefined> {
    try {
      // Try to get upstream tracking branch
      // execGit accepts repoPath string directly (no type casting needed)
      const result = await this.gitService.execGit(repoPath, ['rev-parse', '--abbrev-ref', '@{u}']);

      // Keep the complete upstream ref. Besides preserving slashed branch names
      // (origin/feature/foo), the remote-tracking ref is the authoritative base
      // when the corresponding local branch is stale or absent.
      const upstream = result.trim();
      const branchName = upstream || 'main';
      log(`PrDescriptionService: Detected upstream branch '${branchName}'`);
      return branchName;
    } catch {
      // No upstream - prompt user
      log('PrDescriptionService: No upstream, prompting user');
      const branch = await vscode.window.showInputBox({
        prompt: 'Compare with which base branch?',
        value: 'main',
        placeHolder: 'main, master, develop...',
      });
      // Escape cancels; an empty answer keeps the 'main' default.
      if (branch === undefined) return undefined;
      return branch.trim() || 'main';
    }
  }

  /** GitHub compare page for this branch, or undefined when it can't be derived. */
  private async findCompareUrl(repoPath: string, baseBranch: string): Promise<string | undefined> {
    try {
      const [remote, head] = await Promise.all([
        this.gitService.execGit(repoPath, ['remote', 'get-url', 'origin']),
        this.gitService.execGit(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']),
      ]);
      return githubCompareUrl(remote, baseBranch, head.trim());
    } catch {
      return undefined;
    }
  }

  /**
   * Disposes of all resources.
   */
  dispose(): void {
    // No resources to clean up currently
  }
}
