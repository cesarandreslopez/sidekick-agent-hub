/**
 * @fileoverview InlineChatService - Inline chat AI request handling.
 *
 * Handles AI requests for inline chat with cancellation support via AbortController.
 * Uses configurable model (default: Sonnet).
 *
 * @module InlineChatService
 */

import * as vscode from 'vscode';
import { AuthService } from './AuthService';
import { resolveModel } from './ModelResolver';
import { TimeoutManager, getTimeoutManager } from './TimeoutManager';
import type { InlineChatRequest, InlineChatResponse, InlineChatResult } from '../types/inlineChat';
import {
  getInlineChatSystemPrompt,
  getInlineChatUserPrompt,
  parseInlineChatResponse,
} from '../utils/prompts';

/**
 * InlineChatService - Handles inline chat AI requests.
 *
 * Sends queries to Claude and parses responses to detect question vs edit mode.
 * Supports request cancellation via AbortController.
 */
export class InlineChatService {
  private readonly timeoutManager: TimeoutManager;

  constructor(private authService: AuthService) {
    this.timeoutManager = getTimeoutManager();
  }

  /**
   * Process an inline chat request.
   *
   * @param request - The inline chat request with query and context
   * @param abortSignal - Optional AbortSignal for cancellation (deprecated, use timeout manager instead)
   * @returns Promise resolving to InlineChatResult
   */
  async process(
    request: InlineChatRequest,
    abortSignal?: AbortSignal
  ): Promise<InlineChatResult> {
    // Check for early abort (legacy support)
    if (abortSignal?.aborted) {
      return { success: false, error: 'Request cancelled' };
    }

    // Get configured model
    const config = vscode.workspace.getConfiguration('sidekick');
    const model = resolveModel(config.get<string>('inlineChatModel') ?? 'auto', this.authService.getProviderId(), 'inlineChatModel');

    // Build prompt
    const systemPrompt = getInlineChatSystemPrompt();
    const userPrompt = getInlineChatUserPrompt(
      request.query,
      request.selectedText,
      request.languageId,
      request.contextBefore,
      request.contextAfter
    );

    const fullPrompt = `${systemPrompt}\n\n${userPrompt}`;
    const contextSize = new TextEncoder().encode(fullPrompt).length;
    const timeoutConfig = this.timeoutManager.getTimeoutConfig('inlineChat');

    // Execute with timeout management and retry support
    const opLabel = `Processing query via ${this.authService.getProviderDisplayName()} · ${model}`;
    const result = await this.timeoutManager.executeWithTimeout({
      operation: opLabel,
      task: (signal: AbortSignal) => this.authService.complete(fullPrompt, {
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
        return { success: false, error: `Request timed out after ${result.timeoutMs}ms` };
      }
      if (result.error?.name === 'AbortError') {
        return { success: false, error: 'Request cancelled' };
      }
      return { success: false, error: result.error?.message ?? 'Unknown error' };
    }

    // Parse response to detect mode
    const parsed = parseInlineChatResponse(result.result!);

    const response: InlineChatResponse = {
      mode: parsed.mode,
      text: parsed.mode === 'question' ? parsed.content : '',
      code: parsed.mode === 'edit' ? parsed.content : undefined,
    };

    return { success: true, response };
  }

  /**
   * Dispose of service resources.
   */
  dispose(): void {
    // No resources to dispose currently
  }
}
