/**
 * @fileoverview InlineChatProvider - Inline chat UI orchestration.
 *
 * Manages QuickInput for user queries, progress UI for AI generation,
 * and WorkspaceEdit with refactor preview for code changes.
 *
 * @module InlineChatProvider
 */

import * as vscode from 'vscode';
import { InlineChatService } from '../services/InlineChatService';
import type { InlineChatRequest } from '../types/inlineChat';
import { log, logError } from '../services/Logger';
import { showProviderFailure } from '../utils/providerRetryPrompt';

/**
 * Where an edit request was made. Captured before the AI call, because the
 * user can move the cursor or keep typing while the response is generated.
 */
export interface EditTarget {
  document: vscode.TextDocument;
  range: vscode.Range;
  version: number;
}

/**
 * Finds where a suggested edit should land now.
 *
 * Returns the captured range when the document is unchanged, or when the
 * originally selected text is still at that range. Otherwise it re-locates
 * the selected text when it occurs exactly once. Returns `undefined` when the
 * edit can no longer be placed safely (including an insertion point in a
 * document that has since changed).
 */
export function locateEditRange(
  target: EditTarget,
  selectedText: string,
): vscode.Range | undefined {
  const { document } = target;
  if (document.version === target.version) return target.range;
  if (!selectedText) return undefined;
  if (document.getText(target.range) === selectedText) return target.range;
  const text = document.getText();
  const first = text.indexOf(selectedText);
  if (first === -1 || text.indexOf(selectedText, first + 1) !== -1) return undefined;
  return new vscode.Range(
    document.positionAt(first),
    document.positionAt(first + selectedText.length),
  );
}

/**
 * InlineChatProvider - Orchestrates inline chat interactions.
 *
 * Shows QuickInput for user queries, sends to InlineChatService,
 * and handles responses (questions -> info message, edits -> diff preview).
 */
export class InlineChatProvider implements vscode.Disposable {
  private abortController: AbortController | null = null;
  private quickAskChannel: vscode.OutputChannel | undefined;

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
    const target: EditTarget = {
      document: editor.document,
      range: new vscode.Range(editor.selection.start, editor.selection.end),
      version: editor.document.version,
    };

    log(`Inline chat: "${query.substring(0, 50)}..." (${editor.document.languageId})`);

    // Process with progress UI
    await this.processWithProgress(editor, request, target);
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
    const contextBeforeRange = new vscode.Range(new vscode.Position(startLine, 0), selection.start);
    const contextBefore = document.getText(contextBeforeRange);

    // Context after selection/cursor
    const endLine = Math.min(document.lineCount - 1, selection.end.line + contextLines);
    const contextAfterRange = new vscode.Range(
      selection.end,
      new vscode.Position(endLine, document.lineAt(endLine).text.length),
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
    request: InlineChatRequest,
    target?: EditTarget,
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
      },
    );

    // Handle result
    if (!result.success) {
      if (result.error !== 'Request cancelled') {
        logError('Inline chat failed', new Error(result.error));
        // Retry sends the same query with the context captured for this request.
        await showProviderFailure(`Inline chat failed: ${result.error}`, result.cause, () =>
          this.processWithProgress(editor, request, target),
        );
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
      await this.handleEditResponse(editor, request, result.response.code, target);
    }
  }

  /**
   * Output channel for long answers.
   *
   * Created lazily and reused. Creating one per invocation left a duplicate
   * entry in the Output dropdown for every Quick Ask, and they were never
   * disposed. A plain (non-log) channel, so answers carry no timestamp or
   * level prefix and are never filtered by the log level.
   */
  private getQuickAskChannel(): vscode.OutputChannel {
    return (this.quickAskChannel ??= vscode.window.createOutputChannel('Sidekick: Quick Ask'));
  }

  /**
   * Handle question response - show in information message with option to copy.
   */
  private async handleQuestionResponse(answer: string): Promise<void> {
    // For long answers, show in output channel
    if (answer.length > 500) {
      const outputChannel = this.getQuickAskChannel();
      // Reused channel, so clear first — otherwise every prior answer stacks up.
      outputChannel.clear();
      outputChannel.appendLine(answer);
      outputChannel.show(true);
      vscode.window
        .showInformationMessage('Answer displayed in output panel', 'Copy to Clipboard')
        .then((action) => {
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
   * Handle edit response.
   *
   * Small changes ask Apply / Preview / Cancel; large changes always open the
   * refactor preview. Either way the edit lands where the request was made,
   * not wherever the selection is when the response arrives.
   */
  private async handleEditResponse(
    editor: vscode.TextEditor,
    request: InlineChatRequest,
    newCode: string,
    target?: EditTarget,
  ): Promise<void> {
    const editTarget: EditTarget = target ?? {
      document: editor.document,
      range: new vscode.Range(editor.selection.start, editor.selection.end),
      version: editor.document.version,
    };

    const isLargeChange =
      newCode.split('\n').length > 5 || request.selectedText.split('\n').length > 5;

    if (isLargeChange) {
      await this.applySuggestion(editTarget, request.selectedText, newCode, true);
      return;
    }

    const choice = await vscode.window.showInformationMessage(
      'Apply AI-suggested change?',
      { modal: false },
      'Apply',
      'Preview',
      'Cancel',
    );
    if (choice === 'Apply' || choice === 'Preview') {
      await this.applySuggestion(editTarget, request.selectedText, newCode, choice === 'Preview');
    }
  }

  /**
   * Applies a suggestion at the request's range, re-checked at apply time.
   *
   * With `preview`, the edit is marked as needing confirmation, so VS Code
   * opens the refactor preview and the user applies or discards it there.
   */
  private async applySuggestion(
    target: EditTarget,
    selectedText: string,
    newCode: string,
    preview: boolean,
  ): Promise<void> {
    const range = locateEditRange(target, selectedText);
    if (!range) {
      const action = await vscode.window.showWarningMessage(
        'The file changed while Sidekick was generating, so the suggestion was not applied.',
        'Copy Suggestion',
      );
      if (action === 'Copy Suggestion') {
        await vscode.env.clipboard.writeText(newCode);
      }
      return;
    }

    const edit = new vscode.WorkspaceEdit();
    if (preview) {
      edit.replace(target.document.uri, range, newCode, {
        needsConfirmation: true,
        label: 'Sidekick Quick Ask',
      });
    } else {
      edit.replace(target.document.uri, range, newCode);
    }

    const applied = await vscode.workspace.applyEdit(edit);
    if (applied) {
      log(preview ? 'Quick Ask edit applied from the refactor preview' : 'Quick Ask edit applied');
    } else if (preview) {
      // Discarding the refactor preview resolves false; that is a choice, not a failure.
      log('Quick Ask suggestion not applied');
    } else {
      vscode.window.showErrorMessage('Failed to apply edit');
    }
  }

  /**
   * Dispose of provider resources.
   */
  dispose(): void {
    this.abortController?.abort();
    this.abortController = null;
    this.quickAskChannel?.dispose();
    this.quickAskChannel = undefined;
  }
}
