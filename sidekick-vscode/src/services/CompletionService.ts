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
import { CompletionContext, TimeoutError } from '../types';
import { resolveModel } from './ModelResolver';
import { getSystemPrompt, getUserPrompt, cleanCompletion, PROSE_LANGUAGES } from '../utils/prompts';
import { log } from './Logger';

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
    const multilineSetting = config.get<boolean>('multiline') ?? false;
    const model = resolveModel(config.get<string>('inlineModel') ?? 'auto', this.authService.getProviderId(), 'inlineModel');
    const timeoutMs = config.get<number>('inlineTimeout') ?? 15000;

    // Prose files always use multiline mode
    const isProse = PROSE_LANGUAGES.includes(document.languageId.toLowerCase());
    const multiline = isProse || multilineSetting;

    // Increment request ID for tracking
    const requestId = ++this.lastRequestId;
    log(`Service: request #${requestId}, model=${model}, debounce=${debounceMs}ms, timeout=${timeoutMs}ms`);

    // Cancel any pending request
    if (this.pendingController) {
      log(`Service: aborting previous request`);
      this.pendingController.abort();
    }

    // Debounce: wait before making API call
    await new Promise<void>(resolve => {
      if (this.debounceTimer) {
        clearTimeout(this.debounceTimer);
      }
      this.debounceTimer = setTimeout(resolve, debounceMs);
    });

    // Check if this request is still valid after debounce
    if (requestId !== this.lastRequestId) {
      log(`Service: request #${requestId} superseded by #${this.lastRequestId}`);
      return undefined;
    }
    if (token.isCancellationRequested) {
      log(`Service: request #${requestId} cancelled after debounce`);
      return undefined;
    }

    // Build completion context
    const context = this.buildContext(document, position, {
      contextLines,
      multiline,
      model,
    });

    log(`Service: language=${context.language}, file=${context.filename}, prefix=${context.prefix.length} chars, suffix=${context.suffix.length} chars`);

    // Check cache
    const cached = this.cache.get(context);
    if (cached) {
      log(`Service: cache hit for request #${requestId}`);
      return cached;
    }

    log(`Service: cache miss, calling API for request #${requestId}`);

    // Create new AbortController for this request
    this.pendingController = new AbortController();

    // Link VS Code CancellationToken to AbortController
    const abortHandler = () => this.pendingController?.abort();
    token.onCancellationRequested(abortHandler);

    try {
      // Build prompt
      const prompt = this.buildPrompt(context);
      log(`Service: prompt (${prompt.length} chars):\n--- PROMPT START ---\n${prompt.substring(0, 500)}${prompt.length > 500 ? '\n... [truncated]' : ''}\n--- PROMPT END ---`);

      // Make API call
      const completion = await this.authService.complete(prompt, {
        model,
        maxTokens: 200,
        timeout: timeoutMs,
      });

      // Check validity after API call
      if (requestId !== this.lastRequestId) {
        log(`Service: request #${requestId} superseded after API call`);
        return undefined;
      }
      if (token.isCancellationRequested) {
        log(`Service: request #${requestId} cancelled after API call`);
        return undefined;
      }

      log(`Service: API returned ${completion.length} chars for request #${requestId}: "${completion.substring(0, 100)}${completion.length > 100 ? '...' : ''}"`);

      // Clean and validate completion
      const cleaned = cleanCompletion(completion, context.multiline, context.language);
      if (!cleaned) {
        log(`Service: cleaning filtered out response for request #${requestId} (raw: "${completion.substring(0, 50)}")`);
        return undefined;
      }

      log(`Service: cleaned to ${cleaned.length} chars for request #${requestId}`);

      // Cache successful completion
      this.cache.set(context, cleaned);
      return cleaned;
    } catch (error) {
      // TimeoutError should bubble up for user feedback
      if (error instanceof TimeoutError) {
        log(`Service: request #${requestId} timed out after ${error.timeoutMs}ms`);
        throw error;
      }
      // AbortError is not an error - request was cancelled by user/new request
      if (error instanceof Error && error.name === 'AbortError') {
        log(`Service: request #${requestId} aborted`);
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
    const systemPrompt = getSystemPrompt(context.multiline, context.language);
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
