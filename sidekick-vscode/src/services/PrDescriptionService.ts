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
import { TimeoutManager, getTimeoutManager, type RetryAttempt } from './TimeoutManager';
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
  /**
   * Set when the comparison itself found nothing to describe (no commits, no
   * diff, or a base that doesn't exist). `error` explains why; it is not a
   * provider failure, so callers offer to choose another base instead.
   */
  noCommits?: boolean;
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
 * - Detects base branch (a different-branch upstream, the default branch, or a prompt)
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
        // getBranchCommits swallows git errors, so a mistyped base looks
        // exactly like "no commits"; tell the two apart.
        const exists = await this.refExists(repository.rootUri.fsPath, baseBranch);
        return {
          description: null,
          noCommits: true,
          baseBranch,
          error: exists
            ? `No commits on this branch that aren't already on ${baseBranch}.`
            : `Base branch '${baseBranch}' not found.`,
        };
      }

      log(`PrDescriptionService: Found ${commits.length} commits`);

      // Get diff
      const diff = await this.gitService.getBranchDiff(repository, baseBranch);
      if (diff.trim().length === 0) {
        return {
          description: null,
          noCommits: true,
          baseBranch,
          error: `No changes found vs ${baseBranch}. The branch may already be merged.`,
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
        onTimeout: (timeoutMs: number, contextKb: number, retry?: RetryAttempt) =>
          this.timeoutManager.promptRetry(opLabel, timeoutMs, contextKb, retry),
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
   *
   * An upstream that tracks a *different* branch (`git switch --track
   * origin/main -c fix`) is the base. An upstream of the same branch (the
   * usual `git push -u origin feat/x`) is not: comparing a branch with its own
   * remote copy finds nothing, or only the unpushed commits. Then the remote's
   * default branch is used, and only when none can be found is the user asked.
   *
   * @param repoPath - The repository root path
   * @returns Promise resolving to the base branch, or undefined if the user
   *   dismissed the prompt
   */
  private async detectBaseBranch(repoPath: string): Promise<string | undefined> {
    const upstream = await this.gitOutput(repoPath, ['rev-parse', '--abbrev-ref', '@{u}']);
    if (upstream) {
      const head = await this.gitOutput(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
      // Drop the remote name only (the first path segment): origin/feature/foo
      // tracks feature/foo. Never match on a suffix, or a local `foo` tracking
      // origin/feature/foo would count as the same branch.
      const upstreamBranch = upstream.slice(upstream.indexOf('/') + 1);
      if (upstreamBranch !== head) {
        log(`PrDescriptionService: Using upstream '${upstream}' as the base`);
        return upstream;
      }
    }

    const defaultBase = await this.findDefaultBranch(repoPath);
    if (defaultBase) {
      log(`PrDescriptionService: Using default branch '${defaultBase}' as the base`);
      return defaultBase;
    }

    log('PrDescriptionService: No base branch found, prompting user');
    return this.chooseBaseBranch();
  }

  /**
   * Asks the user which branch to compare with.
   *
   * @param suggested - Prefilled answer (default `main`)
   * @returns The branch, or undefined when the prompt was dismissed
   */
  async chooseBaseBranch(suggested = 'main'): Promise<string | undefined> {
    const branch = await vscode.window.showInputBox({
      title: 'Generate PR Description',
      prompt: 'Compare with which base branch?',
      value: suggested,
      placeHolder: 'main, master, develop, origin/main...',
      ignoreFocusOut: true,
    });
    // Escape cancels; an empty answer keeps the suggested default.
    if (branch === undefined) return undefined;
    return branch.trim() || suggested;
  }

  /** The remote's default branch (origin/HEAD), else the first common default that exists. */
  private async findDefaultBranch(repoPath: string): Promise<string | undefined> {
    const originHead = await this.gitOutput(repoPath, [
      'symbolic-ref',
      '--short',
      'refs/remotes/origin/HEAD',
    ]);
    if (originHead) return originHead;
    for (const candidate of ['origin/main', 'origin/master', 'main', 'master']) {
      if (await this.refExists(repoPath, candidate)) return candidate;
    }
    return undefined;
  }

  /** Whether `ref` names a commit in this repository. */
  private async refExists(repoPath: string, ref: string): Promise<boolean> {
    return (await this.gitOutput(repoPath, ['rev-parse', '--verify', '--quiet', ref])) !== '';
  }

  /** Trimmed output of a repository command, or '' when it fails. */
  private async gitOutput(repoPath: string, args: string[]): Promise<string> {
    try {
      return (await this.gitService.execGit(repoPath, args)).trim();
    } catch {
      return '';
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
