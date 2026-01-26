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
  constructor(private authService: AuthService) {}

  /**
   * Process an inline chat request.
   *
   * @param request - The inline chat request with query and context
   * @param abortSignal - Optional AbortSignal for cancellation
   * @returns Promise resolving to InlineChatResult
   */
  async process(
    request: InlineChatRequest,
    abortSignal?: AbortSignal
  ): Promise<InlineChatResult> {
    try {
      // Check for early abort
      if (abortSignal?.aborted) {
        return { success: false, error: 'Request cancelled' };
      }

      // Get configured model
      const config = vscode.workspace.getConfiguration('sidekick');
      const model = config.get<string>('inlineChatModel') ?? 'sonnet';

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

      // Make AI request
      const rawResponse = await this.authService.complete(fullPrompt, {
        model,
        maxTokens: 2000,
        timeout: 60000, // Longer timeout for code generation
      });

      // Check for abort after async operation
      if (abortSignal?.aborted) {
        return { success: false, error: 'Request cancelled' };
      }

      // Parse response to detect mode
      const parsed = parseInlineChatResponse(rawResponse);

      const response: InlineChatResponse = {
        mode: parsed.mode,
        text: parsed.mode === 'question' ? parsed.content : '',
        code: parsed.mode === 'edit' ? parsed.content : undefined,
      };

      return { success: true, response };
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        return { success: false, error: 'Request cancelled' };
      }
      const message = error instanceof Error ? error.message : 'Unknown error';
      return { success: false, error: message };
    }
  }

  /**
   * Dispose of service resources.
   */
  dispose(): void {
    // No resources to dispose currently
  }
}
