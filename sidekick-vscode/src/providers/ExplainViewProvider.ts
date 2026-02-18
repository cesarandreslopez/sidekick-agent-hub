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
import type { ComplexityLevel } from '../types/explain';
import { getNonce } from '../utils/nonce';

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
      const explanation = await this.explanationService.explain(
        code,
        'code',
        complexity,
        fileContext
      );

      if (this.pendingRequests.has(requestId)) {
        this._panel?.webview.postMessage({
          type: 'explanationResult',
          requestId,
          explanation
        } as ExplainExtensionMessage);
      }
    } catch (error) {
      if (this.pendingRequests.has(requestId)) {
        this._panel?.webview.postMessage({
          type: 'explanationError',
          requestId,
          error: error instanceof Error ? error.message : 'Explanation failed'
        } as ExplainExtensionMessage);
      }
      console.error('Explanation error:', error);
    } finally {
      this.pendingRequests.delete(requestId);
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

