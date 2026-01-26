/**
 * RsvpViewProvider - Webview Panel Manager for RSVP Speed Reader
 *
 * Manages the lifecycle of the RSVP webview panel as an editor tab:
 * - Creates/reveals panel in the central editor area
 * - Loads and configures webview with proper CSP
 * - Generates HTML with nonce-based script loading
 * - Sends selected text to webview for speed reading
 * - Handles AI classification and explanation requests
 */

import * as vscode from 'vscode';
import { AuthService } from '../services/AuthService';
import { ClassificationService } from '../services/ClassificationService';
import { ExplanationService } from '../services/ExplanationService';
import type { ExtensionMessage, WebviewMessage, ContentType, ComplexityLevel } from '../types/rsvp';
import { COMPLEXITY_LABELS } from '../types/rsvp';

export class RsvpViewProvider implements vscode.Disposable {
  public static readonly viewType = 'sidekick.rsvpReader';

  private _panel?: vscode.WebviewPanel;
  private authService: AuthService;
  private classificationService: ClassificationService;
  private explanationService: ExplanationService;
  private pendingRequests = new Map<string, { type: 'classification' | 'explanation'; timestamp: number }>();
  private _pendingText: string | undefined;
  private _pendingOriginal: string | undefined;
  private _pendingMode: 'direct' | 'explain-first' = 'direct';
  private _pendingComplexity: ComplexityLevel | undefined;
  private _disposables: vscode.Disposable[] = [];

  // Context for regeneration
  private _regenerateContext?: {
    originalText: string;
    contentType: ContentType;
    complexity: ComplexityLevel;
    fileContext?: { fileName: string; languageId: string };
  };

  constructor(
    private readonly _extensionUri: vscode.Uri,
    authService: AuthService
  ) {
    this.authService = authService;
    this.classificationService = new ClassificationService(authService);
    this.explanationService = new ExplanationService(authService);
  }

  /**
   * Load text into the RSVP reader.
   * Creates or reveals the panel and sends text to webview.
   *
   * @param text - The text to speed read
   */
  public async loadText(text: string): Promise<void> {
    // Store text - will be sent when webview signals ready
    this._pendingText = text;
    this._pendingOriginal = undefined;
    this._pendingMode = 'direct';
    this._pendingComplexity = undefined;

    if (this._panel) {
      // Panel exists - reveal it, update title, and send text
      this._panel.title = 'RSVP Reader';
      this._panel.reveal(vscode.ViewColumn.One);
      this.loadPendingText();
    } else {
      // Create new panel
      this.createPanel();
    }
  }

  /**
   * Load text with AI explanation.
   * Shows progress notifications, generates explanation, then opens panel.
   *
   * @param text - The text to speed read
   * @param complexity - The explanation complexity level
   * @param fileContext - Optional file context (fileName, languageId)
   */
  public async loadTextWithExplanation(
    text: string,
    complexity: ComplexityLevel,
    fileContext?: { fileName: string; languageId: string }
  ): Promise<void> {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Speed Reader',
        cancellable: false,
      },
      async (progress) => {
        try {
          // Step 1: Classify content
          progress.report({ message: 'Classifying content...' });
          const contentType = await this.classificationService.classify(text);

          // Step 2: Generate explanation
          progress.report({ message: 'Generating explanation...' });
          const explanation = await this.explanationService.explain(text, contentType, complexity, fileContext);

          // Store context for regeneration
          this._regenerateContext = { originalText: text, contentType, complexity, fileContext };

          // Step 3: Store both original and explanation - default to reading explanation
          this._pendingText = explanation;
          this._pendingOriginal = text;
          this._pendingMode = 'explain-first';
          this._pendingComplexity = complexity;

          const title = `RSVP Reader · ${COMPLEXITY_LABELS[complexity]}`;

          if (this._panel) {
            this._panel.title = title;
            this._panel.reveal(vscode.ViewColumn.One);
            this.loadPendingText();
          } else {
            this.createPanel(title);
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Unknown error';
          vscode.window.showErrorMessage(`Explanation failed: ${message}`);
        }
      }
    );
  }

  /**
   * Create the webview panel.
   * @param title - Optional custom title for the panel
   */
  private createPanel(title: string = 'RSVP Reader'): void {
    this._panel = vscode.window.createWebviewPanel(
      RsvpViewProvider.viewType,
      title,
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(this._extensionUri, 'out', 'webview'),
          vscode.Uri.joinPath(this._extensionUri, 'images')
        ]
      }
    );

    // Set HTML content
    this._panel.webview.html = this._getHtmlForWebview(this._panel.webview);

    // Handle messages from webview
    this._panel.webview.onDidReceiveMessage(
      async (message: WebviewMessage) => {
        switch (message.type) {
          case 'webviewReady':
            // Webview is ready to receive messages - send any pending text
            this.loadPendingText();
            break;
          case 'requestClassification':
            await this.handleClassificationRequest(message.requestId, message.text);
            break;
          case 'requestExplanation':
            await this.handleExplanationRequest(
              message.requestId,
              message.text,
              message.contentType,
              message.complexity
            );
            break;
          case 'cancelPendingRequests':
            this.pendingRequests.clear();
            break;
          case 'requestRegenerate':
            await this.handleRegenerateRequest(message.instructions);
            break;
          case 'openInExplain':
            // Open explanation in Explain panel for full reading
            vscode.commands.executeCommand('sidekick.openExplanationPanel', message.explanation, message.code);
            break;
          case 'stateUpdate':
            // Future: handle state updates if needed
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
      },
      undefined,
      this._disposables
    );
  }

  /**
   * Called when webview signals it's ready - send any pending text.
   */
  private loadPendingText(): void {
    if (this._pendingText && this._panel) {
      this._panel.webview.postMessage({
        type: 'loadText',
        text: this._pendingText,
        original: this._pendingOriginal,
      } as ExtensionMessage);
      this._pendingText = undefined;
      this._pendingOriginal = undefined;
      this._pendingMode = 'direct';
    }
  }

  /**
   * Handle classification request from webview.
   * Calls ClassificationService and sends result back with matching requestId.
   *
   * @param requestId - Correlation ID to match async response
   * @param text - Text to classify
   */
  private async handleClassificationRequest(requestId: string, text: string): Promise<void> {
    this.pendingRequests.set(requestId, { type: 'classification', timestamp: Date.now() });

    try {
      const contentType = await this.classificationService.classify(text);

      // Only send if request still pending (not cancelled by newer request)
      if (this.pendingRequests.has(requestId)) {
        this._panel?.webview.postMessage({
          type: 'classificationResult',
          requestId,
          contentType
        } as ExtensionMessage);
        this.pendingRequests.delete(requestId);
      }
    } catch (error) {
      this.pendingRequests.delete(requestId);
      console.error('Classification error:', error);
    }
  }

  /**
   * Handle explanation request from webview.
   * Calls ExplanationService and sends result back with matching requestId.
   *
   * @param requestId - Correlation ID to match async response
   * @param text - Text to explain
   * @param contentType - Type of content (prose/technical/code)
   * @param complexity - Desired explanation complexity level
   */
  private async handleExplanationRequest(
    requestId: string,
    text: string,
    contentType: ContentType,
    complexity: ComplexityLevel
  ): Promise<void> {
    this.pendingRequests.set(requestId, { type: 'explanation', timestamp: Date.now() });

    try {
      const explanation = await this.explanationService.explain(text, contentType, complexity);

      // Only send if request still pending
      if (this.pendingRequests.has(requestId)) {
        this._panel?.webview.postMessage({
          type: 'explanationResult',
          requestId,
          explanation
        } as ExtensionMessage);
        this.pendingRequests.delete(requestId);
      }
    } catch (error) {
      // Send error to webview if request still pending
      if (this.pendingRequests.has(requestId)) {
        this._panel?.webview.postMessage({
          type: 'explanationError',
          requestId,
          error: error instanceof Error ? error.message : 'Explanation failed'
        } as ExtensionMessage);
        this.pendingRequests.delete(requestId);
      }
      console.error('Explanation error:', error);
    }
  }

  /**
   * Handle regeneration request from webview.
   * Uses stored context to regenerate explanation with extra instructions.
   *
   * @param instructions - Extra instructions from user
   */
  private async handleRegenerateRequest(instructions: string): Promise<void> {
    if (!this._regenerateContext) {
      this._panel?.webview.postMessage({
        type: 'regenerateError',
        error: 'No context available for regeneration'
      } as ExtensionMessage);
      return;
    }

    // Notify webview that regeneration is starting
    this._panel?.webview.postMessage({ type: 'regenerating' } as ExtensionMessage);

    try {
      const { originalText, contentType, complexity, fileContext } = this._regenerateContext;
      const explanation = await this.explanationService.explain(
        originalText,
        contentType,
        complexity,
        fileContext,
        instructions
      );

      // Send new explanation to webview
      this._panel?.webview.postMessage({
        type: 'regenerateResult',
        explanation
      } as ExtensionMessage);
    } catch (error) {
      this._panel?.webview.postMessage({
        type: 'regenerateError',
        error: error instanceof Error ? error.message : 'Regeneration failed'
      } as ExtensionMessage);
      console.error('Regeneration error:', error);
    }
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

    // Build URIs for webview resources
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'out', 'webview', 'rsvp.js')
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'out', 'webview', 'styles.css')
    );
    const iconUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'images', 'icon.png')
    );

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none';
                 style-src ${webview.cspSource} 'unsafe-inline';
                 img-src ${webview.cspSource};
                 script-src 'nonce-${nonce}';">
  <link rel="stylesheet" href="${styleUri}">
  <title>RSVP Speed Reader</title>
</head>
<body>
  <div id="app" data-icon="${iconUri}"></div>
  <img src="${iconUri}" class="watermark" alt="" />
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
