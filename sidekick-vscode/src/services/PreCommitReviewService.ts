/**
 * @fileoverview Service for AI-powered pre-commit code review.
 *
 * PreCommitReviewService orchestrates the review flow: retrieving diffs,
 * calling Claude for analysis, and creating VS Code diagnostics for issues.
 *
 * @module PreCommitReviewService
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { GitService } from './GitService';
import { AuthService } from './AuthService';
import { resolveModel } from './ModelResolver';
import { TimeoutManager, getTimeoutManager } from './TimeoutManager';
import { log, logError } from './Logger';
import { filterDiff } from '../utils/diffFilter';
import { truncateDiffIntelligently } from '../utils/tokenEstimator';
import { getPreCommitReviewPrompt, parseReviewResponse, ReviewIssue } from '../utils/prompts';

/**
 * Result from pre-commit review operation.
 */
export interface ReviewResult {
  /** Number of issues found */
  issueCount: number;
  /** Error message if review failed */
  error?: string;
}

/**
 * Service for AI-powered pre-commit code review.
 *
 * This service:
 * - Retrieves diffs from GitService (staged preferred, falls back to unstaged)
 * - Filters and truncates diffs to stay within token limits
 * - Calls Claude Sonnet for code review analysis
 * - Parses response into structured issues
 * - Creates VS Code diagnostics with 'Sidekick AI Review' source
 *
 * @example
 * ```typescript
 * const service = new PreCommitReviewService(gitService, authService);
 * const result = await service.reviewChanges();
 * if (result.issueCount > 0) {
 *   console.log(`Found ${result.issueCount} suggestions`);
 * }
 * // Later: service.clearReview() to dismiss diagnostics
 * ```
 */
export class PreCommitReviewService implements vscode.Disposable {
  /** Diagnostic collection for AI review findings */
  private diagnosticCollection: vscode.DiagnosticCollection;
  private readonly timeoutManager: TimeoutManager;

  /**
   * Creates a new PreCommitReviewService.
   *
   * @param gitService - Git service for retrieving diffs
   * @param authService - Auth service for Claude API access
   */
  constructor(
    private readonly gitService: GitService,
    private readonly authService: AuthService
  ) {
    this.diagnosticCollection = vscode.languages.createDiagnosticCollection('sidekick-review');
    this.timeoutManager = getTimeoutManager();
  }

  /**
   * Reviews current git changes and creates diagnostics for issues found.
   *
   * @returns Promise resolving to review result
   */
  async reviewChanges(): Promise<ReviewResult> {
    try {
      log('PreCommitReviewService: Starting review');

      // Get repository
      const repository = this.gitService.getActiveRepository();
      if (!repository) {
        return { issueCount: 0, error: 'No Git repository found' };
      }

      // Get diff (staged preferred) - uses existing getChangesForCommit from GitService
      const changes = await this.gitService.getChangesForCommit();
      if (!changes) {
        return { issueCount: 0, error: 'No changes to review. Stage or modify some files first.' };
      }

      log(`PreCommitReviewService: Got ${changes.type} diff, ${changes.diff.length} characters`);

      // Filter noise (binary, lockfiles, generated)
      const filtered = filterDiff(changes.diff);
      if (filtered.trim().length === 0) {
        return { issueCount: 0, error: 'No reviewable changes (only binary/lockfiles/generated code).' };
      }

      // Truncate if too large (warn user but continue)
      const maxLines = 3000;
      const truncated = truncateDiffIntelligently(filtered, maxLines);
      if (truncated.length < filtered.length) {
        log(`PreCommitReviewService: Diff truncated from ${filtered.length} to ${truncated.length} characters`);
      }

      // Get model preference
      const config = vscode.workspace.getConfiguration('sidekick');
      const model = resolveModel(config.get<string>('reviewModel') ?? 'auto', this.authService.getProviderId(), 'reviewModel');

      log(`PreCommitReviewService: Calling Claude (model: ${model})`);

      // Build prompt and call Claude with timeout management
      const prompt = getPreCommitReviewPrompt(truncated);
      const contextSize = new TextEncoder().encode(prompt).length;
      const timeoutConfig = this.timeoutManager.getTimeoutConfig('review');

      const opLabel = `Reviewing changes via ${this.authService.getProviderDisplayName()} · ${model}`;
      const result = await this.timeoutManager.executeWithTimeout({
        operation: opLabel,
        task: (signal: AbortSignal) => this.authService.complete(prompt, {
          model,
          maxTokens: 2000,
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
          return { issueCount: 0, error: `Review timed out after ${result.timeoutMs}ms. Try again or increase timeout in settings.` };
        }
        if (result.error?.name === 'AbortError') {
          return { issueCount: 0, error: 'Review cancelled' };
        }
        return { issueCount: 0, error: result.error?.message ?? 'Unknown error' };
      }

      const response = result.result!;
      log(`PreCommitReviewService: Got response, ${response.length} characters`);

      // Parse response into issues
      const issues = parseReviewResponse(response);
      log(`PreCommitReviewService: Parsed ${issues.length} issues`);

      // Create diagnostics
      await this.createDiagnostics(issues, repository.rootUri.fsPath);

      return { issueCount: issues.length };
    } catch (error) {
      logError('PreCommitReviewService: Review failed', error);
      const message = error instanceof Error ? error.message : 'Unknown error';
      return { issueCount: 0, error: message };
    }
  }

  /**
   * Creates VS Code diagnostics from review issues.
   *
   * @param issues - Array of review issues from AI
   * @param repoRoot - Repository root path for resolving file paths
   */
  private async createDiagnostics(issues: ReviewIssue[], repoRoot: string): Promise<void> {
    // Clear previous diagnostics
    this.diagnosticCollection.clear();

    // Group issues by file
    const issuesByFile = new Map<string, ReviewIssue[]>();
    for (const issue of issues) {
      const filePath = path.join(repoRoot, issue.file);
      if (!issuesByFile.has(filePath)) {
        issuesByFile.set(filePath, []);
      }
      issuesByFile.get(filePath)!.push(issue);
    }

    // Create diagnostics for each file
    for (const [filePath, fileIssues] of issuesByFile) {
      try {
        const uri = vscode.Uri.file(filePath);
        const document = await vscode.workspace.openTextDocument(uri);

        const diagnostics = fileIssues.map(issue => {
          // Convert 1-indexed line to 0-indexed, clamp to valid range
          const line = Math.max(0, Math.min((issue.line ?? 1) - 1, document.lineCount - 1));
          const lineText = document.lineAt(line).text;
          const range = new vscode.Range(line, 0, line, lineText.length);

          const diagnostic = new vscode.Diagnostic(
            range,
            issue.message,
            vscode.DiagnosticSeverity.Warning  // Yellow squiggles, not errors
          );

          diagnostic.source = 'Sidekick AI Review';
          diagnostic.code = issue.category;  // 'logic', 'security', 'edge-case', etc.

          return diagnostic;
        });

        this.diagnosticCollection.set(uri, diagnostics);
      } catch (error) {
        // File might not exist or be accessible - skip it
        log(`PreCommitReviewService: Could not create diagnostics for ${filePath}: ${error}`);
      }
    }
  }

  /**
   * Clears all AI review diagnostics.
   */
  clearReview(): void {
    this.diagnosticCollection.clear();
    log('PreCommitReviewService: Cleared review diagnostics');
  }

  /**
   * Disposes of all resources.
   */
  dispose(): void {
    this.diagnosticCollection.dispose();
  }
}
