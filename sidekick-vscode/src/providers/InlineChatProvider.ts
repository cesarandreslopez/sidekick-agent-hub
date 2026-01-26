/**
 * @fileoverview InlineChatProvider - Inline chat UI orchestration.
 *
 * Manages QuickInput for user queries, progress UI for AI generation,
 * and WorkspaceEdit with diff preview for code changes.
 *
 * @module InlineChatProvider
 */

import * as vscode from 'vscode';
import { InlineChatService } from '../services/InlineChatService';
import type { InlineChatRequest } from '../types/inlineChat';
import { log, logError } from '../services/Logger';

/**
 * InlineChatProvider - Orchestrates inline chat interactions.
 *
 * Shows QuickInput for user queries, sends to InlineChatService,
 * and handles responses (questions -> info message, edits -> diff preview).
 */
export class InlineChatProvider implements vscode.Disposable {
  private abortController: AbortController | null = null;

  constructor(private inlineChatService: InlineChatService) {}

  /**
   * Show inline chat input and handle response.
   *
   * Entry point called from command handler. Shows QuickInput,
   * sends query to AI, and displays result appropriately.
   */
  async showInlineChat(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showWarningMessage('No active editor');
      return;
    }

    // Show input box for user query
    const query = await vscode.window.showInputBox({
      prompt: 'Ask a question or request a code change',
      placeHolder: 'e.g., Add error handling, What does this do?, Convert to async',
      ignoreFocusOut: true,
      validateInput: (value) => {
        if (!value || value.trim().length === 0) {
          return 'Please enter a question or instruction';
        }
        if (value.length > 1000) {
          return 'Input too long (max 1000 characters)';
        }
        return null;
      },
    });

    if (!query) {
      return; // User cancelled
    }

    // Build request context
    const request = this.buildRequest(editor, query);

    log(`Inline chat: "${query.substring(0, 50)}..." (${editor.document.languageId})`);

    // Process with progress UI
    await this.processWithProgress(editor, request);
  }

  /**
   * Build InlineChatRequest from editor state.
   */
  private buildRequest(editor: vscode.TextEditor, query: string): InlineChatRequest {
    const document = editor.document;
    const selection = editor.selection;
    const selectedText = document.getText(selection);

    // Get context lines (configurable, default 30 lines)
    const config = vscode.workspace.getConfiguration('sidekick');
    const contextLines = config.get<number>('inlineContextLines') ?? 30;

    // Context before selection/cursor
    const startLine = Math.max(0, selection.start.line - contextLines);
    const contextBeforeRange = new vscode.Range(
      new vscode.Position(startLine, 0),
      selection.start
    );
    const contextBefore = document.getText(contextBeforeRange);

    // Context after selection/cursor
    const endLine = Math.min(document.lineCount - 1, selection.end.line + contextLines);
    const contextAfterRange = new vscode.Range(
      selection.end,
      new vscode.Position(endLine, document.lineAt(endLine).text.length)
    );
    const contextAfter = document.getText(contextAfterRange);

    return {
      query,
      selectedText,
      cursorPosition: {
        line: selection.active.line,
        character: selection.active.character,
      },
      documentUri: document.uri.toString(),
      languageId: document.languageId,
      contextBefore,
      contextAfter,
    };
  }

  /**
   * Process request with progress UI and cancellation support.
   */
  private async processWithProgress(
    editor: vscode.TextEditor,
    request: InlineChatRequest
  ): Promise<void> {
    // Cancel any previous request
    this.abortController?.abort();
    this.abortController = new AbortController();

    const result = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Generating response...',
        cancellable: true,
      },
      async (progress, token) => {
        // Wire VS Code cancellation to AbortController
        token.onCancellationRequested(() => {
          this.abortController?.abort();
          progress.report({ message: 'Cancelling...' });
        });

        return await this.inlineChatService.process(request, this.abortController!.signal);
      }
    );

    // Handle result
    if (!result.success) {
      if (result.error !== 'Request cancelled') {
        vscode.window.showErrorMessage(`Inline chat failed: ${result.error}`);
        logError('Inline chat failed', new Error(result.error));
      }
      return;
    }

    if (!result.response) {
      vscode.window.showWarningMessage('No response received');
      return;
    }

    // Handle based on response mode
    if (result.response.mode === 'question') {
      await this.handleQuestionResponse(result.response.text);
    } else if (result.response.mode === 'edit' && result.response.code) {
      await this.handleEditResponse(editor, request, result.response.code);
    }
  }

  /**
   * Handle question response - show in information message with option to copy.
   */
  private async handleQuestionResponse(answer: string): Promise<void> {
    // For long answers, show in output channel
    if (answer.length > 500) {
      const outputChannel = vscode.window.createOutputChannel('Sidekick: Quick Ask', { log: true });
      outputChannel.appendLine(answer);
      outputChannel.show(true);
      vscode.window.showInformationMessage(
        'Answer displayed in output panel',
        'Copy to Clipboard'
      ).then((action) => {
        if (action === 'Copy to Clipboard') {
          vscode.env.clipboard.writeText(answer);
        }
      });
    } else {
      // Short answers can be shown in information message
      vscode.window.showInformationMessage(answer, 'Copy').then((action) => {
        if (action === 'Copy') {
          vscode.env.clipboard.writeText(answer);
        }
      });
    }
  }

  /**
   * Handle edit response - apply WorkspaceEdit with diff preview.
   */
  private async handleEditResponse(
    editor: vscode.TextEditor,
    request: InlineChatRequest,
    newCode: string
  ): Promise<void> {
    const document = editor.document;
    const selection = editor.selection;

    // Determine range to replace
    let range: vscode.Range;
    if (selection.isEmpty) {
      // No selection - insert at cursor
      range = new vscode.Range(selection.active, selection.active);
    } else {
      // Replace selection
      range = selection;
    }

    // Create WorkspaceEdit
    const edit = new vscode.WorkspaceEdit();
    edit.replace(document.uri, range, newCode);

    // Apply edit - VS Code will show diff preview for large changes
    // For small changes, apply directly
    const isLargeChange = newCode.split('\n').length > 5 || request.selectedText.split('\n').length > 5;

    if (isLargeChange) {
      // Show diff preview via refactor preview
      // Note: WorkspaceEditMetadata is not fully documented but works
      const success = await vscode.workspace.applyEdit(edit, {
        isRefactoring: true,
      });

      if (success) {
        log('Edit applied via refactor preview');
      } else {
        vscode.window.showErrorMessage('Failed to apply edit');
      }
    } else {
      // Small change - apply directly with confirmation
      const confirm = await vscode.window.showInformationMessage(
        'Apply AI-suggested change?',
        { modal: false },
        'Apply',
        'Preview',
        'Cancel'
      );

      if (confirm === 'Apply') {
        const success = await vscode.workspace.applyEdit(edit);
        if (!success) {
          vscode.window.showErrorMessage('Failed to apply edit');
        }
      } else if (confirm === 'Preview') {
        // Show the code in output channel
        const outputChannel = vscode.window.createOutputChannel('Sidekick: Suggested Code', { log: true });
        outputChannel.appendLine('Suggested replacement:');
        outputChannel.appendLine('---');
        outputChannel.appendLine(newCode);
        outputChannel.appendLine('---');
        outputChannel.show(true);
      }
    }
  }

  /**
   * Dispose of provider resources.
   */
  dispose(): void {
    this.abortController?.abort();
    this.abortController = null;
  }
}
