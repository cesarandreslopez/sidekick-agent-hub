/**
 * @fileoverview Completion service orchestrating caching, debouncing, and API calls.
 *
 * CompletionService wraps AuthService with completion-specific logic, providing
 * a clean interface for the InlineCompletionProvider. It handles:
 * - Debouncing rapid requests to reduce API calls
 * - Caching results for repeated identical contexts
 * - Cancellation of in-flight requests when new requests arrive
 * - Prompt construction and response cleaning
 *
 * @module CompletionService
 */

import * as vscode from 'vscode';
import { AuthService } from './AuthService';
import { CompletionCache } from './CompletionCache';
import { CompletionContext } from '../types';
import { getSystemPrompt, getUserPrompt, cleanCompletion } from '../utils/prompts';

/**
 * Service for managing code completion requests.
 *
 * Coordinates between the VS Code InlineCompletionProvider and AuthService,
 * adding caching, debouncing, and request cancellation.
 *
 * @example
 * ```typescript
 * const completionService = new CompletionService(authService);
 * context.subscriptions.push(completionService);
 *
 * const completion = await completionService.getCompletion(document, position, token);
 * ```
 */
export class CompletionService implements vscode.Disposable {
  /** Cache for completion results */
  private cache: CompletionCache;

  /** Auth service for making API calls */
  private authService: AuthService;

  /** AbortController for the current pending request */
  private pendingController: AbortController | undefined;

  /** Timer for debouncing requests */
  private debounceTimer: NodeJS.Timeout | undefined;

  /** Counter for tracking request freshness */
  private lastRequestId = 0;

  /**
   * Creates a new CompletionService.
   *
   * @param authService - The AuthService instance for API calls
   */
  constructor(authService: AuthService) {
    this.authService = authService;
    this.cache = new CompletionCache();
  }

  /**
   * Gets a completion for the given document position.
   *
   * Handles debouncing, caching, cancellation, and API calls.
   *
   * @param document - The document being edited
   * @param position - The cursor position
   * @param token - VS Code cancellation token
   * @returns Promise resolving to completion text or undefined
   */
  async getCompletion(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken
  ): Promise<string | undefined> {
    // Read configuration
    const config = vscode.workspace.getConfiguration('sidekick');
    const debounceMs = config.get<number>('debounceMs') ?? 300;
    const contextLines = config.get<number>('inlineContextLines') ?? 30;
    const multiline = config.get<boolean>('multiline') ?? false;
    const model = config.get<string>('inlineModel') ?? 'haiku';

    // Increment request ID for tracking
    const requestId = ++this.lastRequestId;

    // Cancel any pending request
    this.pendingController?.abort();

    // Debounce: wait before making API call
    await new Promise<void>(resolve => {
      if (this.debounceTimer) {
        clearTimeout(this.debounceTimer);
      }
      this.debounceTimer = setTimeout(resolve, debounceMs);
    });

    // Check if this request is still valid after debounce
    if (requestId !== this.lastRequestId || token.isCancellationRequested) {
      return undefined;
    }

    // Build completion context
    const context = this.buildContext(document, position, {
      contextLines,
      multiline,
      model,
    });

    // Check cache
    const cached = this.cache.get(context);
    if (cached) {
      return cached;
    }

    // Create new AbortController for this request
    this.pendingController = new AbortController();

    // Link VS Code CancellationToken to AbortController
    const abortHandler = () => this.pendingController?.abort();
    token.onCancellationRequested(abortHandler);

    try {
      // Build prompt
      const prompt = this.buildPrompt(context);

      // Make API call
      const completion = await this.authService.complete(prompt, {
        model,
        maxTokens: 200,
        timeout: 10000,
      });

      // Check validity after API call
      if (requestId !== this.lastRequestId || token.isCancellationRequested) {
        return undefined;
      }

      // Clean and validate completion
      const cleaned = cleanCompletion(completion, context.multiline);
      if (!cleaned) {
        return undefined;
      }

      // Cache successful completion
      this.cache.set(context, cleaned);
      return cleaned;
    } catch (error) {
      // AbortError is not an error - request was cancelled
      if (error instanceof Error && error.name === 'AbortError') {
        return undefined;
      }
      throw error;
    }
  }

  /**
   * Builds a CompletionContext from the document and position.
   *
   * @param document - The document being edited
   * @param position - The cursor position
   * @param config - Configuration options
   * @returns CompletionContext for caching and prompt building
   */
  private buildContext(
    document: vscode.TextDocument,
    position: vscode.Position,
    config: { contextLines: number; multiline: boolean; model: string }
  ): CompletionContext {
    const language = document.languageId;
    const filename = document.fileName.split('/').pop() ?? 'unknown';

    // Calculate prefix (lines before cursor up to contextLines)
    const startLine = Math.max(0, position.line - config.contextLines);
    const prefixRange = new vscode.Range(
      new vscode.Position(startLine, 0),
      position
    );
    const prefix = document.getText(prefixRange);

    // Calculate suffix (lines after cursor up to contextLines)
    const endLine = Math.min(
      document.lineCount - 1,
      position.line + config.contextLines
    );
    const suffixRange = new vscode.Range(
      position,
      new vscode.Position(endLine, document.lineAt(endLine).text.length)
    );
    const suffix = document.getText(suffixRange);

    return {
      language,
      model: config.model,
      prefix,
      suffix,
      multiline: config.multiline,
      filename,
    };
  }

  /**
   * Builds the full prompt from a CompletionContext.
   *
   * @param context - The completion context
   * @returns Full prompt string (system + user prompt)
   */
  private buildPrompt(context: CompletionContext): string {
    const systemPrompt = getSystemPrompt(context.multiline);
    const userPrompt = getUserPrompt(
      context.language,
      context.filename,
      context.prefix,
      context.suffix
    );
    return systemPrompt + '\n\n' + userPrompt;
  }

  /**
   * Disposes of all resources.
   *
   * Aborts pending requests, clears timers, and clears cache.
   */
  dispose(): void {
    this.pendingController?.abort();
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.cache.clear();
  }
}
