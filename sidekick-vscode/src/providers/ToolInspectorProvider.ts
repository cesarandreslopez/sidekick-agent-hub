/**
 * @fileoverview Rich tool call inspector panel.
 *
 * Opens a full editor tab webview showing detailed tool call information
 * from the current session. Provides specialized rendering per tool type:
 * - Read/Glob/Grep: file paths with content previews
 * - Edit/Write: inline diff-style display
 * - Bash: formatted command + output
 *
 * @module providers/ToolInspectorProvider
 */

import * as vscode from 'vscode';
import type { SessionMonitor } from '../services/SessionMonitor';
import type { ToolCall } from '../types/claudeSession';
import { getNonce } from '../utils/nonce';
import { log } from '../services/Logger';
import { formatToolSummary } from 'sidekick-shared/dist/formatters/toolSummary';

/**
 * Opens a tool inspector panel for the current session.
 */
export class ToolInspectorProvider implements vscode.Disposable {
  private panel: vscode.WebviewPanel | null = null;
  private disposables: vscode.Disposable[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly sessionMonitor: SessionMonitor
  ) {}

  /**
   * Opens the tool inspector panel.
   * Optionally filters to a specific tool name.
   */
  open(filterTool?: string): void {
    const stats = this.sessionMonitor.getStats();
    const toolCalls = stats.toolCalls;

    if (toolCalls.length === 0) {
      vscode.window.showInformationMessage('No tool calls in current session.');
      return;
    }

    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.One);
    } else {
      this.panel = vscode.window.createWebviewPanel(
        'sidekick.toolInspector',
        'Tool Inspector',
        vscode.ViewColumn.One,
        {
          enableScripts: true,
          retainContextWhenHidden: true,
          localResourceRoots: [this.extensionUri]
        }
      );

      this.panel.onDidDispose(() => {
        this.panel = null;
      }, null, this.disposables);
    }

    const filtered = filterTool
      ? toolCalls.filter(c => c.name === filterTool)
      : toolCalls;

    this.panel.title = filterTool ? `Tools: ${filterTool}` : 'Tool Inspector';
    this.panel.webview.html = this.getHtml(this.panel.webview, filtered, toolCalls);
  }

  /**
   * Generates HTML for the tool inspector.
   */
  private getHtml(webview: vscode.Webview, calls: ToolCall[], allCalls: ToolCall[]): string {
    const nonce = getNonce();
    const cspSource = webview.cspSource;

    // Build tool filter buttons
    const toolCounts = new Map<string, number>();
    for (const c of allCalls) {
      toolCounts.set(c.name, (toolCounts.get(c.name) || 0) + 1);
    }
    const filterButtons = Array.from(toolCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([name, count]) =>
        `<button class="filter-btn" data-tool="${this.escapeHtml(name)}">${this.escapeHtml(name)} (${count})</button>`
      ).join('');

    // Render tool calls
    const callsHtml = calls.map((call, i) => this.renderToolCall(call, i)).join('\n');

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <style nonce="${nonce}">
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      padding: 16px;
    }

    .header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 12px;
    }

    .header h2 { font-size: 14px; font-weight: 600; }

    .filter-bar {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
      margin-bottom: 16px;
    }

    .filter-btn {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      border: none;
      padding: 3px 10px;
      font-size: 11px;
      border-radius: 3px;
      cursor: pointer;
    }

    .filter-btn:hover {
      background: var(--vscode-button-secondaryHoverBackground);
    }

    .filter-btn.active {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }

    .tool-call {
      margin-bottom: 10px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
      overflow: hidden;
    }

    .tool-call-header {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 12px;
      background: var(--vscode-sideBar-background, rgba(255,255,255,0.03));
      cursor: pointer;
      font-size: 12px;
    }

    .tool-call-header:hover {
      background: var(--vscode-list-hoverBackground);
    }

    .tool-name {
      font-weight: 600;
      color: var(--vscode-charts-purple, #c678dd);
    }

    .tool-raw-name {
      font-size: 10px;
      padding: 1px 5px;
      border-radius: 3px;
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
      opacity: 0.85;
    }

    .tool-time {
      color: var(--vscode-descriptionForeground);
      margin-left: auto;
      font-size: 11px;
    }

    .tool-duration {
      font-size: 10px;
      padding: 1px 5px;
      border-radius: 3px;
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
    }

    .tool-error-badge {
      color: var(--vscode-errorForeground);
      font-weight: 600;
    }

    .tool-body {
      padding: 8px 12px;
      display: none;
    }

    .tool-body.expanded { display: block; }

    .tool-section {
      margin-bottom: 8px;
    }

    .tool-section-label {
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 4px;
    }

    .tool-content {
      background: var(--vscode-editor-background);
      border: 1px solid var(--vscode-panel-border);
      padding: 8px;
      border-radius: 3px;
      font-family: var(--vscode-editor-font-family);
      font-size: 12px;
      line-height: 1.4;
      overflow-x: auto;
      white-space: pre-wrap;
      word-break: break-word;
      max-height: 400px;
      overflow-y: auto;
    }

    .file-path {
      color: var(--vscode-textLink-foreground);
      font-family: var(--vscode-editor-font-family);
      font-size: 12px;
    }

    .diff-add { color: var(--vscode-gitDecoration-addedResourceForeground, #98c379); }
    .diff-del { color: var(--vscode-gitDecoration-deletedResourceForeground, #e06c75); }

    .cmd-line {
      color: var(--vscode-terminal-ansiBrightYellow, #e5c07b);
      font-weight: 500;
    }

    .toggle-arrow {
      font-family: monospace;
      color: var(--vscode-descriptionForeground);
      width: 12px;
    }

    .tool-summary {
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
      font-weight: normal;
      max-width: 300px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
  </style>
</head>
<body>
  <div class="header">
    <h2>Tool Inspector</h2>
    <span style="color:var(--vscode-descriptionForeground);font-size:12px">${calls.length} calls</span>
  </div>
  <div class="filter-bar">
    <button class="filter-btn active" data-tool="all">All (${allCalls.length})</button>
    ${filterButtons}
  </div>
  <div id="calls">
    ${callsHtml}
  </div>
  <script nonce="${nonce}">
    (function() {
      // Toggle tool call body
      document.addEventListener('click', function(e) {
        var header = e.target.closest('.tool-call-header');
        if (!header) return;
        var body = header.nextElementSibling;
        if (!body) return;
        var arrow = header.querySelector('.toggle-arrow');
        body.classList.toggle('expanded');
        if (arrow) arrow.textContent = body.classList.contains('expanded') ? '-' : '+';
      });

      // Filter buttons (visual only - server-side filtering)
      var filterBtns = document.querySelectorAll('.filter-btn');
      filterBtns.forEach(function(btn) {
        btn.addEventListener('click', function() {
          var toolName = btn.getAttribute('data-tool');
          var calls = document.querySelectorAll('.tool-call');
          filterBtns.forEach(function(b) { b.classList.remove('active'); });
          btn.classList.add('active');

          calls.forEach(function(call) {
            if (toolName === 'all') {
              call.style.display = '';
            } else {
              call.style.display = call.getAttribute('data-tool') === toolName ? '' : 'none';
            }
          });
        });
      });
    })();
  </script>
</body>
</html>`;
  }

  /**
   * Renders a single tool call with specialized formatting.
   */
  private renderToolCall(call: ToolCall, index: number): string {
    const time = call.timestamp
      ? new Date(call.timestamp).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })
      : '';
    const durationStr = call.duration ? `${Math.round(call.duration)}ms` : '';
    const errorBadge = call.isError ? '<span class="tool-error-badge">ERROR</span>' : '';
    const rawNameBadge = call.rawName && call.rawName !== call.name
      ? `<span class="tool-raw-name">raw: ${this.escapeHtml(call.rawName)}</span>`
      : '';
    const toolSummary = formatToolSummary(call.name, call.input);

    let bodyContent = '';

    switch (call.name) {
      case 'Read':
        bodyContent = this.renderReadCall(call);
        break;
      case 'Write':
        bodyContent = this.renderWriteCall(call);
        break;
      case 'Edit':
      case 'MultiEdit':
        bodyContent = this.renderEditCall(call);
        break;
      case 'Bash':
        bodyContent = this.renderBashCall(call);
        break;
      case 'Grep':
      case 'Glob':
        bodyContent = this.renderSearchCall(call);
        break;
      default:
        bodyContent = this.renderGenericCall(call);
    }

    return `<div class="tool-call" data-tool="${this.escapeHtml(call.name)}" id="call-${index}">
      <div class="tool-call-header">
        <span class="toggle-arrow">+</span>
        <span class="tool-name">${this.escapeHtml(call.name)}</span>
        <span class="tool-summary">${this.escapeHtml(toolSummary)}</span>
        ${rawNameBadge}
        ${errorBadge}
        ${durationStr ? `<span class="tool-duration">${durationStr}</span>` : ''}
        <span class="tool-time">${time}</span>
      </div>
      <div class="tool-body">
        ${bodyContent}
      </div>
    </div>`;
  }

  private renderReadCall(call: ToolCall): string {
    const filePath = call.input.file_path as string || '';
    const offset = call.input.offset as number | undefined;
    const limit = call.input.limit as number | undefined;
    const range = offset || limit ? ` (${offset ? 'from line ' + offset : ''}${limit ? ', limit ' + limit : ''})` : '';

    return `<div class="tool-section">
      <div class="tool-section-label">File</div>
      <div class="file-path">${this.escapeHtml(filePath)}${range}</div>
    </div>`;
  }

  private renderWriteCall(call: ToolCall): string {
    const filePath = call.input.file_path as string || '';
    const content = call.input.content as string || '';
    const preview = content.substring(0, 1000);

    return `<div class="tool-section">
      <div class="tool-section-label">File</div>
      <div class="file-path">${this.escapeHtml(filePath)}</div>
    </div>
    <div class="tool-section">
      <div class="tool-section-label">Content (${content.length} chars)</div>
      <pre class="tool-content">${this.escapeHtml(preview)}${content.length > 1000 ? '\n... (truncated)' : ''}</pre>
    </div>`;
  }

  private renderEditCall(call: ToolCall): string {
    const filePath = call.input.file_path as string || '';
    const oldStr = call.input.old_string as string || '';
    const newStr = call.input.new_string as string || '';

    const diffLines: string[] = [];
    if (oldStr) {
      for (const line of oldStr.split('\n').slice(0, 20)) {
        diffLines.push(`<span class="diff-del">- ${this.escapeHtml(line)}</span>`);
      }
    }
    if (newStr) {
      for (const line of newStr.split('\n').slice(0, 20)) {
        diffLines.push(`<span class="diff-add">+ ${this.escapeHtml(line)}</span>`);
      }
    }

    return `<div class="tool-section">
      <div class="tool-section-label">File</div>
      <div class="file-path">${this.escapeHtml(filePath)}</div>
    </div>
    <div class="tool-section">
      <div class="tool-section-label">Changes</div>
      <pre class="tool-content">${diffLines.join('\n')}</pre>
    </div>`;
  }

  private renderBashCall(call: ToolCall): string {
    const command = call.input.command as string || '';
    const description = call.input.description as string || '';

    let html = '';
    if (description) {
      html += `<div class="tool-section">
        <div class="tool-section-label">Description</div>
        <div>${this.escapeHtml(description)}</div>
      </div>`;
    }
    html += `<div class="tool-section">
      <div class="tool-section-label">Command</div>
      <pre class="tool-content"><span class="cmd-line">$ ${this.escapeHtml(command)}</span></pre>
    </div>`;

    return html;
  }

  private renderSearchCall(call: ToolCall): string {
    const pattern = (call.input.pattern || call.input.query || '') as string;
    const searchPath = (call.input.path || call.input.file_path || '') as string;
    const glob = call.input.glob as string || '';

    const parts: string[] = [];
    if (pattern) parts.push(`Pattern: ${this.escapeHtml(pattern)}`);
    if (searchPath) parts.push(`Path: ${this.escapeHtml(searchPath)}`);
    if (glob) parts.push(`Glob: ${this.escapeHtml(glob)}`);

    return `<div class="tool-section">
      <div class="tool-section-label">${this.escapeHtml(call.name)} Parameters</div>
      <pre class="tool-content">${parts.join('\n')}</pre>
    </div>`;
  }

  private renderGenericCall(call: ToolCall): string {
    const inputStr = JSON.stringify(call.input, null, 2);
    const preview = inputStr.substring(0, 2000);

    return `<div class="tool-section">
      <div class="tool-section-label">Input</div>
      <pre class="tool-content">${this.escapeHtml(preview)}${inputStr.length > 2000 ? '\n... (truncated)' : ''}</pre>
    </div>`;
  }

  private escapeHtml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  dispose(): void {
    this.panel?.dispose();
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables = [];
    log('ToolInspectorProvider disposed');
  }
}
