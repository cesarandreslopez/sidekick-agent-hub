/**
 * ErrorViewProvider - Webview Panel Manager for Error Explanations
 *
 * Manages the lifecycle of the Error Explanation webview panel:
 * - Creates/reveals panel beside current editor (ViewColumn.Two)
 * - Loads and configures webview with proper CSP
 * - Generates HTML with nonce-based script loading
 * - Handles both "explain" and "fix" modes
 * - Applies fixes via WorkspaceEdit
 */

import * as vscode from 'vscode';
import { ErrorExplanationService } from '../services/ErrorExplanationService';
import type {
  ErrorExplainExtensionMessage,
  ErrorExplainWebviewMessage,
  ErrorContext,
  FixSuggestion,
} from '../types/errorExplanation';
import type { ComplexityLevel } from '../types/explain';
import { getNonce } from '../utils/nonce';

/** What the current request was made against; Retry and Apply Fix use it. */
interface ErrorRequestTarget {
  document: vscode.TextDocument;
  /** Document URI and version captured when the request was made. */
  uri: vscode.Uri;
  version: number;
  code: string;
  errorContext: ErrorContext;
  mode: 'explain' | 'fix';
  complexity?: ComplexityLevel;
}

export class ErrorViewProvider implements vscode.Disposable {
  public static readonly viewType = 'sidekick.errorExplanation';

  private _panel?: vscode.WebviewPanel;
  private _disposables: vscode.Disposable[] = [];

  /** Only the newest request may update the panel. */
  private _currentRequestId?: string;
  private _currentAbort?: AbortController;
  private _target?: ErrorRequestTarget;
  /** The fix the panel is showing, held on the host so Apply never trusts the webview. */
  private _pendingFix?: { suggestion: FixSuggestion; uri: vscode.Uri; version: number };

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly errorExplanationService: ErrorExplanationService,
  ) {}

  /**
   * Show error explanation or fix in panel.
   *
   * @param document - Document containing the error
   * @param diagnostic - VS Code diagnostic with error info
   * @param mode - 'explain' for explanation, 'fix' for fix suggestion
   * @param complexity - Optional complexity level for explanation depth
   * @param signal - Optional AbortSignal for external cancellation
   */
  async showErrorExplanation(
    document: vscode.TextDocument,
    diagnostic: vscode.Diagnostic,
    mode: 'explain' | 'fix',
    complexity?: ComplexityLevel,
    signal?: AbortSignal,
  ): Promise<void> {
    const code = document.getText(diagnostic.range);

    // Build error context
    const errorContext: ErrorContext = {
      fileName: document.fileName,
      languageId: document.languageId,
      errorMessage: diagnostic.message,
      errorCode: diagnostic.code?.toString(),
      severity: diagnostic.severity === vscode.DiagnosticSeverity.Error ? 'error' : 'warning',
      range: {
        startLine: diagnostic.range.start.line,
        startCharacter: diagnostic.range.start.character,
        endLine: diagnostic.range.end.line,
        endCharacter: diagnostic.range.end.character,
      },
    };

    await this.runRequest(
      {
        document,
        uri: document.uri,
        version: document.version,
        code,
        errorContext,
        mode,
        complexity,
      },
      signal,
    );
  }

  /** Starts a request, superseding (and aborting) any request still running. */
  private async runRequest(target: ErrorRequestTarget, signal?: AbortSignal): Promise<void> {
    this._currentAbort?.abort();
    const abort = new AbortController();
    if (signal) {
      if (signal.aborted) abort.abort();
      else signal.addEventListener('abort', () => abort.abort(), { once: true });
    }
    const requestId = this.generateRequestId();
    this._currentAbort = abort;
    this._currentRequestId = requestId;
    this._target = target;
    this._pendingFix = undefined;

    // Create or reveal panel
    if (this._panel) {
      this._panel.reveal(vscode.ViewColumn.Two);
    } else {
      this.createPanel(target.mode);
    }

    // Update panel title based on mode
    if (this._panel) {
      this._panel.title = target.mode === 'explain' ? 'Error Explanation' : 'Fix Error';
    }

    // Send error context to webview
    this._panel?.webview.postMessage({
      type: 'loadError',
      requestId,
      mode: target.mode,
      errorContext: target.errorContext,
      code: target.code,
    } as ErrorExplainExtensionMessage);

    // Request AI explanation or fix
    if (target.mode === 'explain') {
      await this.handleExplanationRequest(requestId, target, abort.signal);
    } else {
      await this.handleFixRequest(requestId, target, abort.signal);
    }
  }

  /** True while `requestId` is the newest request. */
  private isCurrent(requestId: string): boolean {
    return this._currentRequestId === requestId;
  }

  /** Reports a failure, or a neutral "cancelled" when the user stopped it. */
  private postFailure(requestId: string, signal: AbortSignal, error: string): void {
    if (!this.isCurrent(requestId)) return;
    this._panel?.webview.postMessage(
      signal.aborted
        ? ({ type: 'cancelled', requestId } as ErrorExplainExtensionMessage)
        : ({ type: 'explanationError', requestId, error } as ErrorExplainExtensionMessage),
    );
  }

  /**
   * Create the webview panel beside the current editor.
   */
  private createPanel(mode: 'explain' | 'fix'): void {
    this._panel = vscode.window.createWebviewPanel(
      ErrorViewProvider.viewType,
      mode === 'explain' ? 'Error Explanation' : 'Fix Error',
      vscode.ViewColumn.Two, // Beside editor, not replacing
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(this._extensionUri, 'out', 'webview')],
      },
    );

    // Set HTML content
    this._panel.webview.html = this._getHtmlForWebview(this._panel.webview);

    // Handle messages from webview
    this._panel.webview.onDidReceiveMessage(
      async (message: ErrorExplainWebviewMessage) => {
        switch (message.type) {
          case 'webviewReady':
            // Webview is ready to receive messages
            break;
          case 'applyFix':
            await this.applyFix();
            break;
          case 'retry':
            if (this._target) await this.runRequest(this._target);
            break;
          case 'close':
            this._panel?.dispose();
            break;
        }
      },
      undefined,
      this._disposables,
    );

    // Handle panel disposal
    this._panel.onDidDispose(
      () => {
        this._currentAbort?.abort();
        this._panel = undefined;
        this._target = undefined;
        this._pendingFix = undefined;
        this._currentRequestId = undefined;
      },
      undefined,
      this._disposables,
    );
  }

  /**
   * Handle explanation request.
   * Calls ErrorExplanationService and sends result back.
   */
  private async handleExplanationRequest(
    requestId: string,
    target: ErrorRequestTarget,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      const explanation = await this.errorExplanationService.explainError(
        target.code,
        target.errorContext,
        target.complexity,
        signal,
      );

      if (this.isCurrent(requestId)) {
        this._panel?.webview.postMessage({
          type: 'explanationResult',
          requestId,
          explanation,
        } as ErrorExplainExtensionMessage);
      }
    } catch (error) {
      this.postFailure(
        requestId,
        signal,
        error instanceof Error ? error.message : 'Explanation failed',
      );
      if (!signal.aborted) console.error('Error explanation failed:', error);
    }
  }

  /**
   * Handle fix request.
   * Calls ErrorExplanationService and sends fix suggestion back.
   */
  private async handleFixRequest(
    requestId: string,
    target: ErrorRequestTarget,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      const fixSuggestion = await this.errorExplanationService.generateFix(
        target.code,
        target.errorContext,
        signal,
      );

      if (!this.isCurrent(requestId)) {
        return;
      }

      if (fixSuggestion) {
        // The service only knows the file name; the host knows the real URI.
        const suggestion: FixSuggestion = { ...fixSuggestion, documentUri: target.uri.toString() };
        this._pendingFix = { suggestion, uri: target.uri, version: target.version };
        this._panel?.webview.postMessage({
          type: 'fixReady',
          requestId,
          fixSuggestion: suggestion,
        } as ErrorExplainExtensionMessage);
      } else {
        this._panel?.webview.postMessage({
          type: 'explanationError',
          requestId,
          error: 'Unable to generate automatic fix for this error',
        } as ErrorExplainExtensionMessage);
      }
    } catch (error) {
      this.postFailure(
        requestId,
        signal,
        error instanceof Error ? error.message : 'Fix generation failed',
      );
      if (!signal.aborted) console.error('Fix generation failed:', error);
    }
  }

  /**
   * Apply the fix the host is holding, if the document hasn't changed since.
   */
  private async applyFix(): Promise<void> {
    const pending = this._pendingFix;
    const post = (success: boolean, error?: string) =>
      this._panel?.webview.postMessage({
        type: 'applyFixResult',
        success,
        error,
      } as ErrorExplainExtensionMessage);

    if (!pending) {
      post(false, 'This fix was already applied or is no longer available.');
      return;
    }

    const document = vscode.workspace.textDocuments.find(
      (doc) => doc.uri.toString() === pending.uri.toString(),
    );
    if (document && document.version !== pending.version) {
      post(false, 'The file changed after this fix was generated. Run Fix Error again.');
      return;
    }

    try {
      const { range: r, fixedCode } = pending.suggestion;
      const edit = new vscode.WorkspaceEdit();
      edit.replace(
        pending.uri,
        new vscode.Range(
          new vscode.Position(r.startLine, r.startCharacter),
          new vscode.Position(r.endLine, r.endCharacter),
        ),
        fixedCode,
      );

      const success = await vscode.workspace.applyEdit(edit);

      if (success) {
        // One fix, one edit: a second click must not replace the range again.
        this._pendingFix = undefined;
        post(true);
        vscode.window.showInformationMessage('Fix applied successfully');
      } else {
        post(false, 'VS Code could not apply the edit.');
      }
    } catch (error) {
      post(false, error instanceof Error ? error.message : 'Unknown error');
      console.error('Apply fix error:', error);
    }
  }

  /**
   * Generate a unique request ID.
   */
  private generateRequestId(): string {
    return `req_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
  }

  /**
   * Generate HTML content for the webview.
   * Includes strict CSP with nonce-based script loading.
   */
  private _getHtmlForWebview(webview: vscode.Webview): string {
    // Generate nonce for CSP
    const nonce = getNonce();

    // Build URI for webview script
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'out', 'webview', 'error.js'),
    );

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none';
                 style-src ${webview.cspSource} 'unsafe-inline';
                 script-src 'nonce-${nonce}';">
  <title>Error Explanation</title>
</head>
<body>
  <div id="app"></div>
  <script type="module" nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }

  /**
   * Dispose of all resources.
   */
  dispose(): void {
    this._panel?.dispose();
    this._disposables.forEach((d) => d.dispose());
    this._disposables = [];
    this._currentAbort?.abort();
    this._currentRequestId = undefined;
  }
}
