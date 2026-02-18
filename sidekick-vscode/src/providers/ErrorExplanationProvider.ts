/**
 * @fileoverview ErrorExplanationProvider - CodeActionProvider for lightbulb quick actions.
 *
 * Provides "Explain Error with AI" and "Fix Error with AI" actions in the VS Code
 * lightbulb menu (Cmd+. / Ctrl+.) when errors or warnings are present.
 *
 * This provider returns immediately - the actual AI work happens in command handlers
 * registered in extension.ts (to be implemented in Plan 03).
 *
 * @module ErrorExplanationProvider
 */

import * as vscode from 'vscode';

/**
 * ErrorExplanationProvider - CodeActionProvider for error/warning diagnostics.
 *
 * Integrates with VS Code's lightbulb menu (Cmd+. / Ctrl+.) to provide AI-powered
 * actions for errors and warnings:
 * - "Explain Error with AI" - Get detailed explanation of what went wrong
 * - "Fix Error with AI" - Get AI-generated fix suggestion
 *
 * Only creates actions for Error (severity 0) and Warning (severity 1) diagnostics.
 * Info (severity 2) and Hint (severity 3) diagnostics are ignored.
 *
 * The provider returns synchronously. Async AI work is handled by command handlers
 * that execute when the user selects an action from the menu.
 *
 * @example
 * ```typescript
 * const provider = new ErrorExplanationProvider();
 * vscode.languages.registerCodeActionsProvider(
 *   { pattern: '**' },
 *   provider,
 *   { providedCodeActionKinds: ErrorExplanationProvider.providedCodeActionKinds }
 * );
 * ```
 */
export class ErrorExplanationProvider implements vscode.CodeActionProvider {
  /**
   * Metadata for VS Code to optimize when to call this provider.
   * Indicates we provide QuickFix actions.
   */
  public static readonly providedCodeActionKinds = [
    vscode.CodeActionKind.QuickFix,
  ];

  /**
   * Provides code actions for error and warning diagnostics.
   *
   * This method is called by VS Code when the user opens the lightbulb menu.
   * It returns immediately with CodeActions that trigger commands - the actual
   * AI work happens in the command handlers.
   *
   * @param document - The text document containing the diagnostics
   * @param range - The range for which actions are requested (cursor position or selection)
   * @param context - Context including diagnostics at the range
   * @param token - Cancellation token (unused, we return immediately)
   * @returns Array of CodeActions or undefined if no relevant diagnostics
   */
  public provideCodeActions(
    document: vscode.TextDocument,
    _range: vscode.Range | vscode.Selection,
    context: vscode.CodeActionContext,
    _token: vscode.CancellationToken
  ): vscode.CodeAction[] | undefined {
    // Filter for Error (0) and Warning (1) severity only
    // Skip Info (2) and Hint (3) diagnostics
    const relevantDiagnostics = context.diagnostics.filter(
      diagnostic =>
        diagnostic.severity === vscode.DiagnosticSeverity.Error ||
        diagnostic.severity === vscode.DiagnosticSeverity.Warning
    );

    // No relevant diagnostics - don't show our actions
    if (relevantDiagnostics.length === 0) {
      return undefined;
    }

    // Create Explain and Fix actions for each relevant diagnostic
    const actions: vscode.CodeAction[] = [];
    for (const diagnostic of relevantDiagnostics) {
      actions.push(this.createExplainAction(document, diagnostic));
      actions.push(this.createFixAction(document, diagnostic));
    }

    return actions;
  }

  /**
   * Creates a CodeAction for a diagnostic with the given verb and command.
   *
   * The action title reflects the diagnostic severity (Error vs Warning).
   * Pass document.uri (not document) for serialization.
   *
   * @param document - The text document containing the diagnostic
   * @param diagnostic - The diagnostic to act on
   * @param verb - Action verb ("Explain" or "Fix")
   * @param commandId - VS Code command to trigger
   * @returns CodeAction for the diagnostic
   */
  private createAction(
    document: vscode.TextDocument,
    diagnostic: vscode.Diagnostic,
    verb: string,
    commandId: string
  ): vscode.CodeAction {
    const severity = diagnostic.severity === vscode.DiagnosticSeverity.Error ? 'Error' : 'Warning';
    const action = new vscode.CodeAction(
      `${verb} ${severity} with AI`,
      vscode.CodeActionKind.QuickFix
    );

    action.command = {
      command: commandId,
      title: `${verb} Error`,
      arguments: [document.uri, diagnostic],
    };
    action.diagnostics = [diagnostic];

    return action;
  }

  private createExplainAction(document: vscode.TextDocument, diagnostic: vscode.Diagnostic): vscode.CodeAction {
    return this.createAction(document, diagnostic, 'Explain', 'sidekick.explainError');
  }

  private createFixAction(document: vscode.TextDocument, diagnostic: vscode.Diagnostic): vscode.CodeAction {
    return this.createAction(document, diagnostic, 'Fix', 'sidekick.fixError');
  }
}
