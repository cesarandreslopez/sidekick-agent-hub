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
import type { ComplexityLevel } from '../types/rsvp';

export class ErrorViewProvider implements vscode.Disposable {
  public static readonly viewType = 'sidekick.errorExplanation';

  private _panel?: vscode.WebviewPanel;
  private _disposables: vscode.Disposable[] = [];
  private pendingRequests = new Map<string, { timestamp: number }>();

  // Context for current error
  private _code?: string;

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly errorExplanationService: ErrorExplanationService
  ) {}

  /**
   * Show error explanation or fix in panel.
   *
   * @param document - Document containing the error
   * @param diagnostic - VS Code diagnostic with error info
   * @param mode - 'explain' for explanation, 'fix' for fix suggestion
   * @param complexity - Optional complexity level for explanation depth
   */
  async showErrorExplanation(
    document: vscode.TextDocument,
    diagnostic: vscode.Diagnostic,
    mode: 'explain' | 'fix',
    complexity?: ComplexityLevel
  ): Promise<void> {
    // Store code context
    this._code = document.getText(diagnostic.range);

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

    // Create or reveal panel
    if (this._panel) {
      this._panel.reveal(vscode.ViewColumn.Two);
    } else {
      this.createPanel(mode);
    }

    // Update panel title based on mode
    if (this._panel) {
      this._panel.title = mode === 'explain' ? 'Error Explanation' : 'Fix Error';
    }

    // Send error context to webview
    this._panel?.webview.postMessage({
      type: 'loadError',
      errorContext,
      code: this._code,
    } as ErrorExplainExtensionMessage);

    // Request AI explanation or fix
    if (mode === 'explain') {
      await this.handleExplanationRequest(this._code, errorContext, complexity);
    } else {
      await this.handleFixRequest(this._code, errorContext);
    }
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
      }
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
            await this.applyFix(message.fixSuggestion);
            break;
          case 'close':
            this._panel?.dispose();
            break;
        }
      },
      undefined,
      this._disposables
    );

    // Handle panel disposal
    this._panel.onDidDispose(
      () => {
        this._panel = undefined;
        this._code = undefined;
      },
      undefined,
      this._disposables
    );
  }

  /**
   * Handle explanation request.
   * Calls ErrorExplanationService and sends result back.
   */
  private async handleExplanationRequest(
    code: string,
    errorContext: ErrorContext,
    complexity?: ComplexityLevel
  ): Promise<void> {
    const requestId = this.generateRequestId();
    this.pendingRequests.set(requestId, { timestamp: Date.now() });

    try {
      // Call ErrorExplanationService
      const explanation = await this.errorExplanationService.explainError(code, errorContext, complexity);

      // Only send if request still pending
      if (this.pendingRequests.has(requestId)) {
        this._panel?.webview.postMessage({
          type: 'explanationResult',
          requestId,
          explanation,
        } as ErrorExplainExtensionMessage);
        this.pendingRequests.delete(requestId);
      }
    } catch (error) {
      // Send error to webview if request still pending
      if (this.pendingRequests.has(requestId)) {
        this._panel?.webview.postMessage({
          type: 'explanationError',
          requestId,
          error: error instanceof Error ? error.message : 'Explanation failed',
        } as ErrorExplainExtensionMessage);
        this.pendingRequests.delete(requestId);
      }
      console.error('Error explanation failed:', error);
    }
  }

  /**
   * Handle fix request.
   * Calls ErrorExplanationService and sends fix suggestion back.
   */
  private async handleFixRequest(code: string, errorContext: ErrorContext): Promise<void> {
    const requestId = this.generateRequestId();
    this.pendingRequests.set(requestId, { timestamp: Date.now() });

    try {
      // Call ErrorExplanationService to generate fix
      const fixSuggestion = await this.errorExplanationService.generateFix(code, errorContext);

      if (fixSuggestion && this.pendingRequests.has(requestId)) {
        // Send fix suggestion to webview
        this._panel?.webview.postMessage({
          type: 'fixReady',
          fixSuggestion,
        } as ErrorExplainExtensionMessage);
        this.pendingRequests.delete(requestId);
      } else if (this.pendingRequests.has(requestId)) {
        // No fix available
        this._panel?.webview.postMessage({
          type: 'explanationError',
          requestId,
          error: 'Unable to generate automatic fix for this error',
        } as ErrorExplainExtensionMessage);
        this.pendingRequests.delete(requestId);
      }
    } catch (error) {
      // Send error to webview if request still pending
      if (this.pendingRequests.has(requestId)) {
        this._panel?.webview.postMessage({
          type: 'explanationError',
          requestId,
          error: error instanceof Error ? error.message : 'Fix generation failed',
        } as ErrorExplainExtensionMessage);
        this.pendingRequests.delete(requestId);
      }
      console.error('Fix generation failed:', error);
    }
  }

  /**
   * Apply a fix suggestion using WorkspaceEdit.
   */
  private async applyFix(fixSuggestion: FixSuggestion): Promise<void> {
    try {
      // Create WorkspaceEdit
      const edit = new vscode.WorkspaceEdit();

      // Build VS Code range from fix suggestion
      const range = new vscode.Range(
        new vscode.Position(fixSuggestion.range.startLine, fixSuggestion.range.startCharacter),
        new vscode.Position(fixSuggestion.range.endLine, fixSuggestion.range.endCharacter)
      );

      // Parse URI from string
      const uri = vscode.Uri.parse(fixSuggestion.documentUri);

      // Replace text at diagnostic range
      edit.replace(uri, range, fixSuggestion.fixedCode);

      // Apply edit
      const success = await vscode.workspace.applyEdit(edit);

      if (success) {
        // Send success message to webview
        this._panel?.webview.postMessage({
          type: 'applyFixResult',
          success: true,
        } as ErrorExplainExtensionMessage);

        // Show success notification
        vscode.window.showInformationMessage('Fix applied successfully');
      } else {
        // Send failure message to webview
        this._panel?.webview.postMessage({
          type: 'applyFixResult',
          success: false,
          error: 'Failed to apply edit',
        } as ErrorExplainExtensionMessage);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      // Send failure message to webview
      this._panel?.webview.postMessage({
        type: 'applyFixResult',
        success: false,
        error: errorMessage,
      } as ErrorExplainExtensionMessage);

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
      vscode.Uri.joinPath(this._extensionUri, 'out', 'webview', 'error.js')
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
    this.pendingRequests.clear();
  }
}

/**
 * Generate a random nonce for CSP.
 */
function getNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
