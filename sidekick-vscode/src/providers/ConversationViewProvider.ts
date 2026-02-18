/**
 * @fileoverview Full-tab conversation viewer for Claude Code sessions.
 *
 * Opens a webview panel in an editor tab that renders the complete
 * conversation from a JSONL session file in a chat-style layout.
 * Supports collapsible tool calls, syntax highlighting markers,
 * and real-time updates for active sessions.
 *
 * @module providers/ConversationViewProvider
 */

import * as vscode from 'vscode';
import type { SessionMonitor } from '../services/SessionMonitor';
import type { ClaudeSessionEvent } from '../types/claudeSession';
import { getNonce } from '../utils/nonce';
import { log, logError } from '../services/Logger';

/** Parsed message chunk for display */
interface ConversationChunk {
  role: 'user' | 'assistant' | 'system' | 'tool';
  timestamp: string;
  content: string;
  model?: string;
  toolName?: string;
  toolInput?: string;
  toolOutput?: string;
  isError?: boolean;
  isSidechain?: boolean;
  isCompaction?: boolean;
}

/**
 * Opens a conversation viewer panel for the given session file.
 *
 * Reads the full JSONL file, parses all events, and renders them
 * in a chat-style webview panel.
 */
export class ConversationViewProvider implements vscode.Disposable {
  private panel: vscode.WebviewPanel | null = null;
  private disposables: vscode.Disposable[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly sessionMonitor: SessionMonitor
  ) {}

  /**
   * Opens the conversation viewer for the current or specified session.
   */
  async open(sessionPath?: string): Promise<void> {
    const targetPath = sessionPath || this.sessionMonitor.getSessionPath();
    if (!targetPath) {
      vscode.window.showWarningMessage('No active session to view.');
      return;
    }

    // Reuse existing panel or create new one
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.One);
    } else {
      this.panel = vscode.window.createWebviewPanel(
        'sidekick.conversationViewer',
        'Session Conversation',
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

    // Set title to session filename
    const provider = this.sessionMonitor.getProvider();
    const filename = provider.getSessionId(targetPath) || 'Session';
    this.panel.title = `Conversation: ${filename.substring(0, 8)}...`;

    // Parse and render
    try {
      const chunks = await this.parseSession(targetPath);
      this.panel.webview.html = this.getHtml(this.panel.webview, chunks);
    } catch (err) {
      logError('ConversationViewProvider: Failed to parse session', err);
      vscode.window.showErrorMessage(`Failed to open conversation: ${err}`);
    }
  }

  /**
   * Parses a JSONL session file into conversation chunks.
   */
  private async parseSession(filePath: string): Promise<ConversationChunk[]> {
    const chunks: ConversationChunk[] = [];
    const pendingTools = new Map<string, { name: string; input: string; timestamp: string }>();

    const provider = this.sessionMonitor.getProvider();
    const reader = provider.createReader(filePath);
    const events = reader.readAll();
    reader.flush();

    for (const event of events) {
      const chunk = this.eventToChunk(event, pendingTools);
      if (chunk) {
        chunks.push(chunk);
      }
    }

    return chunks;
  }

  /**
   * Converts a session event to a displayable conversation chunk.
   */
  private eventToChunk(
    event: ClaudeSessionEvent,
    pendingTools: Map<string, { name: string; input: string; timestamp: string }>
  ): ConversationChunk | null {
    switch (event.type) {
      case 'user': {
        const text = this.extractText(event.message?.content);
        if (!text) return null;
        return {
          role: 'user',
          timestamp: event.timestamp,
          content: text,
          isSidechain: event.isSidechain
        };
      }

      case 'assistant': {
        const msgContent = event.message?.content;
        const text = this.extractText(msgContent);
        // Also extract tool_use blocks from assistant content
        if (Array.isArray(msgContent)) {
          for (const block of msgContent) {
            if (block && typeof block === 'object' && (block as Record<string, unknown>).type === 'tool_use') {
              const b = block as Record<string, unknown>;
              const toolId = b.id as string;
              const toolName = b.name as string;
              const toolInput = JSON.stringify(b.input || {}, null, 2);
              pendingTools.set(toolId, {
                name: toolName,
                input: toolInput,
                timestamp: event.timestamp
              });
            }
          }
        }
        if (!text) return null;
        return {
          role: 'assistant',
          timestamp: event.timestamp,
          content: text,
          model: event.message?.model,
          isSidechain: event.isSidechain
        };
      }

      case 'tool_use': {
        const toolName = event.tool?.name || 'unknown';
        const toolInput = JSON.stringify(event.tool?.input || {}, null, 2);
        // Store for matching with result
        if (event.tool?.input) {
          const toolId = (event as unknown as Record<string, unknown>).tool_use_id as string || `tool_${Date.now()}`;
          pendingTools.set(toolId, { name: toolName, input: toolInput, timestamp: event.timestamp });
        }
        return {
          role: 'tool',
          timestamp: event.timestamp,
          content: '',
          toolName,
          toolInput: this.truncateForDisplay(toolInput, 2000)
        };
      }

      case 'tool_result': {
        const toolUseId = event.result?.tool_use_id;
        const pending = toolUseId ? pendingTools.get(toolUseId) : undefined;
        const toolName = pending?.name || 'Tool';
        const output = typeof event.result?.output === 'string'
          ? event.result.output
          : JSON.stringify(event.result?.output || '', null, 2);

        if (pending) {
          pendingTools.delete(toolUseId!);
        }

        return {
          role: 'tool',
          timestamp: event.timestamp,
          content: '',
          toolName: `${toolName} result`,
          toolOutput: this.truncateForDisplay(output, 3000),
          isError: event.result?.is_error,
          isSidechain: event.isSidechain
        };
      }

      case 'summary':
        return {
          role: 'system',
          timestamp: event.timestamp,
          content: 'Context compacted',
          isCompaction: true
        };

      default:
        return null;
    }
  }

  /**
   * Extracts readable text from message content.
   */
  private extractText(content: unknown): string {
    if (!content) return '';
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      const texts: string[] = [];
      for (const block of content) {
        if (block && typeof block === 'object') {
          const b = block as Record<string, unknown>;
          if (b.type === 'text' && typeof b.text === 'string') {
            texts.push(b.text as string);
          } else if (b.type === 'thinking' && typeof b.thinking === 'string') {
            texts.push(`[Thinking] ${(b.thinking as string).substring(0, 500)}...`);
          }
        }
      }
      return texts.join('\n\n');
    }
    return '';
  }

  /**
   * Truncates text for display with ellipsis.
   */
  private truncateForDisplay(text: string, maxLen: number): string {
    if (text.length <= maxLen) return text;
    return text.substring(0, maxLen) + '\n... (truncated)';
  }

  /**
   * Generates the webview HTML.
   */
  private getHtml(webview: vscode.Webview, chunks: ConversationChunk[]): string {
    const nonce = getNonce();
    const cspSource = webview.cspSource;

    const chunksHtml = chunks.map((chunk, i) => {
      const time = new Date(chunk.timestamp).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
      const sidechain = chunk.isSidechain ? ' sidechain' : '';

      if (chunk.isCompaction) {
        return `<div class="chunk compaction-marker">
          <div class="chunk-meta">${time}</div>
          <div class="compaction-badge">Context Compacted</div>
        </div>`;
      }

      if (chunk.role === 'tool') {
        const errorClass = chunk.isError ? ' tool-error' : '';
        const inputSection = chunk.toolInput
          ? `<div class="tool-section"><div class="tool-section-label">Input</div><pre class="tool-content">${this.escapeHtml(chunk.toolInput)}</pre></div>`
          : '';
        const outputSection = chunk.toolOutput
          ? `<div class="tool-section"><div class="tool-section-label">${chunk.isError ? 'Error' : 'Output'}</div><pre class="tool-content${errorClass}">${this.escapeHtml(chunk.toolOutput)}</pre></div>`
          : '';

        return `<div class="chunk tool-chunk${sidechain}" id="chunk-${i}">
          <div class="tool-header" data-toggle="tool-body-${i}">
            <span class="tool-icon">${chunk.isError ? '!' : '>'}</span>
            <span class="tool-name">${this.escapeHtml(chunk.toolName || 'Tool')}</span>
            <span class="chunk-time">${time}</span>
            <span class="toggle-arrow">+</span>
          </div>
          <div class="tool-body" id="tool-body-${i}" style="display:none;">
            ${inputSection}
            ${outputSection}
          </div>
        </div>`;
      }

      const roleLabel = chunk.role === 'user' ? 'You' : chunk.role === 'assistant' ? 'Claude' : 'System';
      const modelTag = chunk.model ? `<span class="model-tag">${this.getShortModelName(chunk.model)}</span>` : '';

      return `<div class="chunk ${chunk.role}-chunk${sidechain}" id="chunk-${i}">
        <div class="chunk-header">
          <span class="role-label ${chunk.role}">${roleLabel}</span>
          ${modelTag}
          <span class="chunk-time">${time}</span>
        </div>
        <div class="chunk-body">${this.escapeHtml(chunk.content)}</div>
      </div>`;
    }).join('\n');

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
      line-height: 1.5;
    }

    .conversation-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 8px 0 16px;
      border-bottom: 1px solid var(--vscode-panel-border);
      margin-bottom: 16px;
    }

    .conversation-header h2 {
      font-size: 14px;
      font-weight: 600;
    }

    .chunk-count {
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
    }

    .search-bar {
      display: flex;
      gap: 8px;
      margin-bottom: 16px;
    }

    .search-bar input {
      flex: 1;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, transparent);
      padding: 6px 10px;
      font-size: 13px;
      border-radius: 4px;
      outline: none;
    }

    .search-bar input:focus {
      border-color: var(--vscode-focusBorder);
    }

    .chunk {
      margin-bottom: 12px;
      border-radius: 6px;
      overflow: hidden;
    }

    .user-chunk {
      background: var(--vscode-input-background);
      border-left: 3px solid var(--vscode-charts-blue, #61afef);
    }

    .assistant-chunk {
      background: var(--vscode-editor-inactiveSelectionBackground, rgba(255,255,255,0.04));
      border-left: 3px solid var(--vscode-charts-green, #98c379);
    }

    .tool-chunk {
      background: transparent;
      border: 1px solid var(--vscode-panel-border);
    }

    .sidechain {
      opacity: 0.6;
    }

    .chunk-header {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 12px;
    }

    .role-label {
      font-weight: 600;
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    .role-label.user { color: var(--vscode-charts-blue, #61afef); }
    .role-label.assistant { color: var(--vscode-charts-green, #98c379); }

    .model-tag {
      font-size: 10px;
      padding: 1px 6px;
      border-radius: 3px;
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
    }

    .chunk-time {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      margin-left: auto;
    }

    .chunk-body {
      padding: 4px 12px 12px;
      white-space: pre-wrap;
      word-break: break-word;
      font-size: 13px;
    }

    .tool-header {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 6px 12px;
      cursor: pointer;
      font-size: 12px;
    }

    .tool-header:hover {
      background: var(--vscode-list-hoverBackground);
    }

    .tool-icon {
      font-family: monospace;
      font-weight: bold;
      color: var(--vscode-charts-purple, #c678dd);
      width: 14px;
      text-align: center;
    }

    .tool-name {
      font-weight: 500;
    }

    .toggle-arrow {
      margin-left: auto;
      color: var(--vscode-descriptionForeground);
      font-family: monospace;
    }

    .tool-body {
      padding: 0 12px 8px;
    }

    .tool-section {
      margin-top: 6px;
    }

    .tool-section-label {
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 2px;
    }

    .tool-content {
      background: var(--vscode-editor-background);
      padding: 8px;
      border-radius: 3px;
      font-family: var(--vscode-editor-font-family);
      font-size: 12px;
      overflow-x: auto;
      white-space: pre-wrap;
      word-break: break-word;
      max-height: 300px;
      overflow-y: auto;
    }

    .tool-error {
      color: var(--vscode-errorForeground);
    }

    .compaction-marker {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 12px;
    }

    .compaction-badge {
      font-size: 11px;
      padding: 2px 8px;
      border-radius: 3px;
      background: var(--vscode-editorWarning-foreground, #e5c07b);
      color: var(--vscode-editor-background);
      font-weight: 500;
    }

    .chunk-meta {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
    }

    .highlight {
      background: var(--vscode-editor-findMatchHighlightBackground, rgba(255, 200, 0, 0.3));
      border-radius: 2px;
    }

    .hidden { display: none !important; }
  </style>
</head>
<body>
  <div class="conversation-header">
    <h2>Session Conversation</h2>
    <span class="chunk-count">${chunks.length} messages</span>
  </div>
  <div class="search-bar">
    <input type="text" id="search-input" placeholder="Search conversation..." />
  </div>
  <div id="conversation">
    ${chunksHtml}
  </div>
  <script nonce="${nonce}">
    (function() {
      // Tool call toggle
      document.addEventListener('click', function(e) {
        var header = e.target.closest('.tool-header');
        if (!header) return;
        var targetId = header.getAttribute('data-toggle');
        var body = document.getElementById(targetId);
        if (!body) return;
        var arrow = header.querySelector('.toggle-arrow');
        if (body.style.display === 'none') {
          body.style.display = 'block';
          if (arrow) arrow.textContent = '-';
        } else {
          body.style.display = 'none';
          if (arrow) arrow.textContent = '+';
        }
      });

      // Search
      var searchInput = document.getElementById('search-input');
      var searchTimer = null;
      searchInput.addEventListener('input', function() {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(function() {
          var query = searchInput.value.trim().toLowerCase();
          var chunks = document.querySelectorAll('.chunk');
          chunks.forEach(function(chunk) {
            if (!query) {
              chunk.classList.remove('hidden');
              return;
            }
            var text = chunk.textContent.toLowerCase();
            if (text.indexOf(query) >= 0) {
              chunk.classList.remove('hidden');
            } else {
              chunk.classList.add('hidden');
            }
          });
        }, 200);
      });
    })();
  </script>
</body>
</html>`;
  }

  /**
   * Escapes HTML entities.
   */
  private escapeHtml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /**
   * Gets a short model name for display.
   */
  private getShortModelName(model: string): string {
    if (model.includes('opus')) return 'Opus';
    if (model.includes('sonnet')) return 'Sonnet';
    if (model.includes('haiku')) return 'Haiku';
    return model.split('-').slice(0, 2).join('-');
  }

  dispose(): void {
    this.panel?.dispose();
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables = [];
    log('ConversationViewProvider disposed');
  }
}
