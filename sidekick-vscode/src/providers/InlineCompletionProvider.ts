/**
 * @fileoverview Inline completion provider for VS Code.
 *
 * This provider implements VS Code's InlineCompletionItemProvider interface
 * to show AI-generated code suggestions as ghost text in the editor.
 * It delegates to CompletionService for caching, debouncing, and API calls.
 *
 * @module InlineCompletionProvider
 */

import * as vscode from 'vscode';
import { CompletionService } from '../services/CompletionService';
import { log, logError } from '../services/Logger';

/**
 * Inline completion provider that delegates to CompletionService.
 *
 * This is a thin wrapper that:
 * - Checks if completions are enabled
 * - Calls CompletionService.getCompletion()
 * - Wraps results in InlineCompletionItem
 *
 * Tab acceptance and Ctrl+Right partial accept are handled
 * automatically by VS Code - no extension code needed.
 *
 * @example
 * ```typescript
 * const provider = new InlineCompletionProvider(completionService);
 * vscode.languages.registerInlineCompletionItemProvider({ pattern: '**' }, provider);
 * ```
 */
export class InlineCompletionProvider implements vscode.InlineCompletionItemProvider {
  /**
   * Creates a new InlineCompletionProvider.
   *
   * @param completionService - The CompletionService for handling completion requests
   */
  constructor(private completionService: CompletionService) {}

  /**
   * Provides inline completion items for the current cursor position.
   *
   * @param document - The text document being edited
   * @param position - The cursor position
   * @param context - The inline completion context
   * @param token - Cancellation token for aborting the request
   * @returns Array of inline completion items or undefined
   */
  async provideInlineCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    context: vscode.InlineCompletionContext,
    token: vscode.CancellationToken
  ): Promise<vscode.InlineCompletionItem[] | undefined> {
    // Only provide completions for regular file documents (not SCM input, output panels, etc.)
    if (document.uri.scheme !== 'file' && document.uri.scheme !== 'untitled') {
      return undefined;
    }

    // Check if completions are enabled in config
    const config = vscode.workspace.getConfiguration('sidekick');
    if (!config.get('enabled')) {
      return undefined;
    }

    // Check if already cancelled
    if (token.isCancellationRequested) {
      log('Inline: cancelled before start');
      return undefined;
    }

    const line = position.line + 1;
    const char = position.character;
    log(`Inline: request at ${document.fileName.split('/').pop()}:${line}:${char}`);

    try {
      // Delegate to CompletionService
      const completion = await this.completionService.getCompletion(
        document,
        position,
        token
      );

      // Check cancellation after async operation
      if (token.isCancellationRequested) {
        log('Inline: cancelled after getCompletion');
        return undefined;
      }

      if (!completion) {
        log('Inline: no completion returned');
        return undefined;
      }

      log(`Inline: got completion (${completion.length} chars): "${completion.substring(0, 50)}..."`);

      // Return completion as InlineCompletionItem
      return [
        new vscode.InlineCompletionItem(
          completion,
          new vscode.Range(position, position)
        ),
      ];
    } catch (error) {
      logError('Inline: completion error', error);
      return undefined;
    }
  }
}
