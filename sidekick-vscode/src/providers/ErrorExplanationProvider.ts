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
   * Creates a CodeAction for explaining a diagnostic.
   *
   * The action title reflects the diagnostic severity (Error vs Warning).
   * When selected, it triggers the sidekick.explainError command with the
   * document URI and diagnostic as arguments.
   *
   * @param document - The text document containing the diagnostic
   * @param diagnostic - The diagnostic to explain
   * @returns CodeAction for explaining the diagnostic
   */
  private createExplainAction(
    document: vscode.TextDocument,
    diagnostic: vscode.Diagnostic
  ): vscode.CodeAction {
    const isError = diagnostic.severity === vscode.DiagnosticSeverity.Error;
    const title = isError
      ? 'Explain Error with AI'
      : 'Explain Warning with AI';

    const action = new vscode.CodeAction(
      title,
      vscode.CodeActionKind.QuickFix
    );

    // Set command to trigger - handler will be registered in extension.ts
    // Pass document.uri (not document) for serialization
    action.command = {
      command: 'sidekick.explainError',
      title: 'Explain Error',
      arguments: [document.uri, diagnostic],
    };

    // Associate with diagnostic so VS Code knows this action addresses it
    action.diagnostics = [diagnostic];

    return action;
  }

  /**
   * Creates a CodeAction for fixing a diagnostic.
   *
   * The action title reflects the diagnostic severity (Error vs Warning).
   * When selected, it triggers the sidekick.fixError command with the
   * document URI and diagnostic as arguments.
   *
   * @param document - The text document containing the diagnostic
   * @param diagnostic - The diagnostic to fix
   * @returns CodeAction for fixing the diagnostic
   */
  private createFixAction(
    document: vscode.TextDocument,
    diagnostic: vscode.Diagnostic
  ): vscode.CodeAction {
    const isError = diagnostic.severity === vscode.DiagnosticSeverity.Error;
    const title = isError
      ? 'Fix Error with AI'
      : 'Fix Warning with AI';

    const action = new vscode.CodeAction(
      title,
      vscode.CodeActionKind.QuickFix
    );

    // Set command to trigger - handler will be registered in extension.ts
    // Pass document.uri (not document) for serialization
    action.command = {
      command: 'sidekick.fixError',
      title: 'Fix Error',
      arguments: [document.uri, diagnostic],
    };

    // Associate with diagnostic so VS Code knows this action addresses it
    action.diagnostics = [diagnostic];

    return action;
  }
}
