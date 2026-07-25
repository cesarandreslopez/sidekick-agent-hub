/**
 * Placeholder for the Agent Hub dashboard when session monitoring is off.
 *
 * The nine monitoring views are gated on `sidekick.monitoringActive`, which is
 * set from the code path that actually registers their providers. Without a
 * placeholder the whole activity-bar container would vanish, leaving no way to
 * turn monitoring back on from the UI — and `viewsWelcome` cannot help, since
 * it only renders for tree views and the primary view here is a webview.
 *
 * @module MonitoringDisabledViewProvider
 */

import * as vscode from 'vscode';
import { getDesignTokenCSS, getSharedStyles } from '../utils/designTokens';
import { log, logError } from '../services/Logger';

/** Message posted by the placeholder when the user opts back in. */
interface EnableMonitoringMessage {
  type: 'enableMonitoring';
}

export class MonitoringDisabledViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'sidekick.dashboard';

  private _disposables: vscode.Disposable[] = [];

  constructor(private readonly _extensionUri: vscode.Uri) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri],
    };
    webviewView.webview.html = this._getHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(
      (message: EnableMonitoringMessage) => {
        if (message?.type !== 'enableMonitoring') return;
        void this._enableMonitoring();
      },
      undefined,
      this._disposables,
    );
  }

  private async _enableMonitoring(): Promise<void> {
    try {
      await vscode.workspace
        .getConfiguration('sidekick')
        .update('enableSessionMonitoring', true, vscode.ConfigurationTarget.Global);
      log('Session monitoring re-enabled from the dashboard placeholder');
      // No reload prompt here: the onDidChangeConfiguration handler in
      // extension.ts owns it, and prompting from both stacked two near-identical
      // notifications. It only fires when the effective value actually changes,
      // so a workspace-level `false` — which this Global write cannot outrank —
      // needs its own explanation instead.
      const effective = vscode.workspace
        .getConfiguration('sidekick')
        .get<boolean>('enableSessionMonitoring', true);
      if (!effective) {
        vscode.window.showWarningMessage(
          'A workspace setting is overriding sidekick.enableSessionMonitoring. Enable it in the workspace settings to start monitoring.',
        );
      }
    } catch (error) {
      logError('Failed to enable session monitoring', error);
      vscode.window.showErrorMessage('Could not update the session monitoring setting.');
    }
  }

  private _getHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <title>Sidekick Agent Hub</title>
  ${getDesignTokenCSS()}
  ${getSharedStyles()}
  <style>
    body { padding: var(--sk-space-4, 16px); }
    .sk-empty-state h3 { margin: 0 0 var(--sk-space-2, 8px); font-size: 13px; }
    .sk-empty-state p {
      margin: 0 0 var(--sk-space-3, 12px);
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
      line-height: 1.5;
    }
    .sk-enable-btn {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      border-radius: var(--sk-radius-sm, 3px);
      padding: 6px 12px;
      cursor: pointer;
      font-size: 12px;
      font-family: inherit;
    }
    .sk-enable-btn:hover { background: var(--vscode-button-hoverBackground); }
  </style>
</head>
<body>
  <div class="sk-empty-state">
    <h3>Session monitoring is off</h3>
    <p>
      Analytics, the mind map, the kanban board, and the other Agent Hub views
      stay hidden while <code>sidekick.enableSessionMonitoring</code> is false.
    </p>
    <button id="enable" class="sk-enable-btn">Enable session monitoring</button>
  </div>
  <script nonce="${nonce}">
    (function () {
      const vscode = acquireVsCodeApi();
      document.getElementById('enable').addEventListener('click', function () {
        vscode.postMessage({ type: 'enableMonitoring' });
      });
    })();
  </script>
</body>
</html>`;
  }

  dispose(): void {
    for (const disposable of this._disposables) {
      disposable.dispose();
    }
    this._disposables = [];
  }
}

function getNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
