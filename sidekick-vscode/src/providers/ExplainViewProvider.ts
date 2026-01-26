/**
 * ExplainViewProvider - Webview Panel Manager for Code Explanations
 *
 * Manages the lifecycle of the Explain Code webview panel:
 * - Creates/reveals panel beside current editor (ViewColumn.Two)
 * - Loads and configures webview with proper CSP
 * - Generates HTML with nonce-based script loading
 * - Sends selected code to webview for AI explanation
 * - Handles complexity level changes and explanation requests
 */

import * as vscode from 'vscode';
import { ExplanationService } from '../services/ExplanationService';
import type { ExplainExtensionMessage, ExplainWebviewMessage, FileContext } from '../types/explain';
import type { ComplexityLevel } from '../types/rsvp';

export class ExplainViewProvider implements vscode.Disposable {
  public static readonly viewType = 'sidekick.explainCode';

  private _panel?: vscode.WebviewPanel;
  private _disposables: vscode.Disposable[] = [];
  private pendingRequests = new Map<string, { timestamp: number }>();

  // Pending data to send when webview is ready
  private _pendingCode?: string;
  private _pendingComplexity?: ComplexityLevel;
  private _pendingFileContext?: FileContext;

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly explanationService: ExplanationService
  ) {}

  /**
   * Show explanation for selected code.
   * Creates or reveals the panel and sends code to webview.
   *
   * @param code - The code to explain
   * @param complexity - The explanation complexity level
   * @param fileContext - File name and language ID for context
   */
  public showExplanation(
    code: string,
    complexity: ComplexityLevel,
    fileContext: FileContext
  ): void {
    // Store data - will be sent when webview signals ready
    this._pendingCode = code;
    this._pendingComplexity = complexity;
    this._pendingFileContext = fileContext;

    if (this._panel) {
      // Panel exists - reveal it beside editor
      this._panel.reveal(vscode.ViewColumn.Two);
      this.sendPendingData();
    } else {
      // Create new panel
      this.createPanel();
    }
  }

  /**
   * Show a pre-generated explanation (from RSVP or other source).
   * Skips AI generation and displays directly.
   *
   * @param explanation - The pre-generated explanation text
   * @param code - Optional source code for context
   */
  public showPreGeneratedExplanation(
    explanation: string,
    code?: string
  ): void {
    // Store data for display
    this._pendingCode = code || '';
    this._pendingComplexity = 'imposter-syndrome'; // Default
    this._pendingFileContext = { fileName: '', languageId: '' };

    if (this._panel) {
      this._panel.reveal(vscode.ViewColumn.Two);
    } else {
      this.createPanel();
    }

    // Wait for webview ready, then send the explanation directly
    // We'll use a small delay to ensure webview is initialized
    setTimeout(() => {
      if (this._panel) {
        // Send code context
        this._panel.webview.postMessage({
          type: 'loadCode',
          code: code || '(Speed read content)',
          fileContext: this._pendingFileContext
        } as ExplainExtensionMessage);

        // Send explanation result directly (bypass AI)
        this._panel.webview.postMessage({
          type: 'explanationResult',
          requestId: 'pregenerated',
          explanation
        } as ExplainExtensionMessage);
      }
    }, 100);
  }

  /**
   * Create the webview panel beside the current editor.
   */
  private createPanel(): void {
    this._panel = vscode.window.createWebviewPanel(
      ExplainViewProvider.viewType,
      'Code Explanation',
      vscode.ViewColumn.Two, // Beside editor, not replacing
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(this._extensionUri, 'out', 'webview')]
      }
    );

    // Set HTML content
    this._panel.webview.html = this._getHtmlForWebview(this._panel.webview);

    // Handle messages from webview
    this._panel.webview.onDidReceiveMessage(
      async (message: ExplainWebviewMessage) => {
        switch (message.type) {
          case 'webviewReady':
            // Webview is ready to receive messages - send any pending data
            this.sendPendingData();
            break;
          case 'requestExplanation':
            await this.handleExplanationRequest(
              message.requestId,
              message.code,
              message.complexity,
              message.fileContext
            );
            break;
          case 'changeComplexity':
            // Re-request explanation with new complexity
            if (this._pendingCode && this._pendingFileContext) {
              this._pendingComplexity = message.complexity;
              const requestId = this.generateRequestId();
              await this.handleExplanationRequest(
                requestId,
                this._pendingCode,
                message.complexity,
                this._pendingFileContext
              );
            }
            break;
          case 'openInRsvp':
            // Open explanation in RSVP speed reader
            vscode.commands.executeCommand('sidekick.speedReadExplanation', message.explanation);
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
        this._pendingCode = undefined;
        this._pendingComplexity = undefined;
        this._pendingFileContext = undefined;
      },
      undefined,
      this._disposables
    );
  }

  /**
   * Send pending code data to webview when ready.
   */
  private sendPendingData(): void {
    if (this._pendingCode && this._pendingComplexity && this._pendingFileContext && this._panel) {
      this._panel.webview.postMessage({
        type: 'loadCode',
        code: this._pendingCode,
        fileContext: this._pendingFileContext
      } as ExplainExtensionMessage);

      // Keep pending data for potential complexity changes
      // Only clear when panel is disposed
    }
  }

  /**
   * Handle explanation request from webview.
   * Calls ExplanationService and sends result back with matching requestId.
   *
   * @param requestId - Correlation ID to match async response
   * @param code - Code to explain
   * @param complexity - Desired explanation complexity level
   * @param fileContext - Optional file context (fileName, languageId)
   */
  private async handleExplanationRequest(
    requestId: string,
    code: string,
    complexity: ComplexityLevel,
    fileContext?: FileContext
  ): Promise<void> {
    this.pendingRequests.set(requestId, { timestamp: Date.now() });

    try {
      // Call ExplanationService with 'code' as content type
      const explanation = await this.explanationService.explain(
        code,
        'code',
        complexity,
        fileContext
      );

      // Only send if request still pending (not cancelled by newer request)
      if (this.pendingRequests.has(requestId)) {
        this._panel?.webview.postMessage({
          type: 'explanationResult',
          requestId,
          explanation
        } as ExplainExtensionMessage);
        this.pendingRequests.delete(requestId);
      }
    } catch (error) {
      // Send error to webview if request still pending
      if (this.pendingRequests.has(requestId)) {
        this._panel?.webview.postMessage({
          type: 'explanationError',
          requestId,
          error: error instanceof Error ? error.message : 'Explanation failed'
        } as ExplainExtensionMessage);
        this.pendingRequests.delete(requestId);
      }
      console.error('Explanation error:', error);
    }
  }

  /**
   * Generate a unique request ID.
   * @returns Unique request ID string
   */
  private generateRequestId(): string {
    return `req_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
  }

  /**
   * Generate HTML content for the webview.
   * Includes strict CSP with nonce-based script loading.
   *
   * @param webview - The webview to generate HTML for
   * @returns HTML string for the webview
   */
  private _getHtmlForWebview(webview: vscode.Webview): string {
    // Generate nonce for CSP
    const nonce = getNonce();

    // Build URI for webview script
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'out', 'webview', 'explain.js')
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
  <title>Code Explanation</title>
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
    this._disposables.forEach(d => d.dispose());
    this._disposables = [];
    this.pendingRequests.clear();
  }
}

/**
 * Generate a random nonce for CSP.
 * @returns 32-character random string
 */
function getNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
