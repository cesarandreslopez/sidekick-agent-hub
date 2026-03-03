/**
 * @fileoverview Abstract base class for sidebar webview view providers.
 *
 * Consolidates common patterns shared across all WebviewViewProvider
 * implementations: disposable lifecycle, webview initialization,
 * message posting, and visibility handling.
 *
 * @module providers/BaseWebviewViewProvider
 */

import * as vscode from 'vscode';
import { getNonce } from '../utils/nonce';

/**
 * Abstract base class for sidebar webview view providers.
 *
 * Subclasses must implement `resolveWebviewView` and call `_initializeWebview`
 * within it to set up the standard webview options, message handling, and
 * visibility tracking.
 */
export abstract class BaseWebviewViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  protected _view?: vscode.WebviewView;
  protected _disposables: vscode.Disposable[] = [];

  constructor(protected readonly _extensionUri: vscode.Uri) {}

  abstract resolveWebviewView(
    webviewView: vscode.WebviewView,
    context: vscode.WebviewViewResolveContext,
    token: vscode.CancellationToken
  ): void;

  /**
   * Standard webview initialization. Call from `resolveWebviewView`.
   *
   * Sets webview options, registers message/visibility handlers, and
   * assigns the HTML content returned by `getHtml`.
   */
  protected _initializeWebview(
    webviewView: vscode.WebviewView,
    options: {
      getHtml: (webview: vscode.Webview) => string;
      onMessage?: (message: unknown) => void | Promise<void>;
      onVisible?: () => void;
      localResourceRoots?: vscode.Uri[];
    }
  ): void {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: options.localResourceRoots ?? [
        vscode.Uri.joinPath(this._extensionUri, 'out', 'webview'),
        vscode.Uri.joinPath(this._extensionUri, 'images')
      ]
    };

    webviewView.webview.html = options.getHtml(webviewView.webview);

    if (options.onMessage) {
      webviewView.webview.onDidReceiveMessage(
        options.onMessage,
        undefined,
        this._disposables
      );
    }

    if (options.onVisible) {
      webviewView.onDidChangeVisibility(
        () => {
          if (webviewView.visible) {
            options.onVisible!();
          }
        },
        undefined,
        this._disposables
      );
    }
  }

  /** Safely post a message to the webview (no-op when view is unavailable). */
  protected _postMessage(message: unknown): void {
    this._view?.webview.postMessage(message);
  }

  /** Generate a cryptographic nonce for CSP script/style tags. */
  protected _getNonce(): string {
    return getNonce();
  }

  dispose(): void {
    this._disposables.forEach(d => d.dispose());
    this._disposables = [];
  }
}
