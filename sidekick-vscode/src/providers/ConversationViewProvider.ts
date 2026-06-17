/**
 * @fileoverview Full-tab conversation viewer for Sidekick sessions.
 *
 * Opens a webview panel in an editor tab that renders the complete
 * conversation from a provider session file in a chat-style layout.
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
import {
  assistantTurnEventsFromSessionEvents,
  segmentAssistantTurn,
} from 'sidekick-shared';
import type { AssistantTurnToolRef } from 'sidekick-shared';

/** Parsed message chunk for display */
export interface ConversationChunk {
  role: 'user' | 'assistant' | 'system' | 'tool' | 'reasoning';
  timestamp: string;
  content: string;
  model?: string;
  toolName?: string;
  toolUseId?: string;
  toolSummary?: string;
  toolOutput?: string;
  isError?: boolean;
  isSidechain?: boolean;
  isCompaction?: boolean;
}

type PendingTool = { name: string };

export function conversationChunksFromSessionEvents(events: readonly ClaudeSessionEvent[]): ConversationChunk[] {
  const chunks: ConversationChunk[] = [];
  const pendingTools = new Map<string, PendingTool>();
  let assistantEvents: ClaudeSessionEvent[] = [];

  function flushAssistantEvents(): void {
    if (assistantEvents.length === 0) return;

    const timestamp = assistantEvents[assistantEvents.length - 1]?.timestamp ?? '';
    const assistantEvent = [...assistantEvents].reverse().find((event) => event.type === 'assistant');
    const model = assistantEvent?.message?.model;
    const isSidechain = assistantEvents.some((event) => event.isSidechain);
    const projection = segmentAssistantTurn(assistantTurnEventsFromSessionEvents(assistantEvents));

    for (const item of projection.timeline) {
      if (item.kind === 'reasoning') {
        chunks.push({
          role: 'reasoning',
          timestamp,
          content: item.text,
          model,
          isSidechain,
        });
        continue;
      }

      if (item.kind === 'narration') {
        chunks.push({
          role: 'assistant',
          timestamp,
          content: item.text,
          model,
          isSidechain,
        });
        continue;
      }

      for (const tool of item.tools) {
        chunks.push(toolRefToChunk(tool, timestamp, isSidechain, pendingTools));
      }
    }

    if (projection.answer.trim() !== '') {
      chunks.push({
        role: 'assistant',
        timestamp,
        content: projection.answer,
        model,
        isSidechain,
      });
    }

    assistantEvents = [];
  }

  for (const event of events) {
    if (event.type === 'assistant' || event.type === 'tool_use') {
      assistantEvents.push(event);
      continue;
    }

    flushAssistantEvents();

    switch (event.type) {
      case 'user':
        chunks.push(...userEventToChunks(event, pendingTools));
        break;
      case 'tool_result':
        chunks.push(topLevelToolResultToChunk(event, pendingTools));
        break;
      case 'summary':
        chunks.push({
          role: 'system',
          timestamp: event.timestamp,
          content: 'Context compacted',
          isCompaction: true,
        });
        break;
      case 'system': {
        const text = extractText(event.message?.content);
        if (text) {
          chunks.push({
            role: 'system',
            timestamp: event.timestamp,
            content: text,
            isSidechain: event.isSidechain,
          });
        }
        break;
      }
      default:
        break;
    }
  }

  flushAssistantEvents();
  return chunks;
}

function toolRefToChunk(
  tool: AssistantTurnToolRef,
  timestamp: string,
  isSidechain: boolean,
  pendingTools: Map<string, PendingTool>,
): ConversationChunk {
  if (tool.toolUseId != null) {
    pendingTools.set(tool.toolUseId, { name: tool.toolName });
  }

  return {
    role: 'tool',
    timestamp,
    content: '',
    toolName: tool.toolName,
    toolUseId: tool.toolUseId,
    toolSummary: tool.toolInput,
    isSidechain,
  };
}

function userEventToChunks(
  event: ClaudeSessionEvent,
  pendingTools: Map<string, PendingTool>,
): ConversationChunk[] {
  const content = event.message?.content;
  if (typeof content === 'string') {
    return content.trim()
      ? [{ role: 'user', timestamp: event.timestamp, content, isSidechain: event.isSidechain }]
      : [];
  }

  if (!Array.isArray(content)) return [];

  const chunks: ConversationChunk[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    const type = stringValue(block.type);
    if (type === 'text' || type === 'input_text') {
      const text = stringValue(block.text) ?? stringValue(block.content);
      if (text?.trim()) {
        chunks.push({
          role: 'user',
          timestamp: event.timestamp,
          content: text,
          isSidechain: event.isSidechain,
        });
      }
      continue;
    }

    if (type === 'tool_result') {
      chunks.push(toolResultBlockToChunk(block, event.timestamp, event.isSidechain === true, pendingTools));
    }
  }

  return chunks;
}

function topLevelToolResultToChunk(
  event: ClaudeSessionEvent,
  pendingTools: Map<string, PendingTool>,
): ConversationChunk {
  const output = stringifyOutput(event.result?.output);
  return toolResultToChunk(
    event.result?.tool_use_id,
    output,
    event.result?.is_error === true,
    event.timestamp,
    event.isSidechain === true,
    pendingTools,
  );
}

function toolResultBlockToChunk(
  block: Record<string, unknown>,
  timestamp: string,
  isSidechain: boolean,
  pendingTools: Map<string, PendingTool>,
): ConversationChunk {
  return toolResultToChunk(
    stringValue(block.tool_use_id),
    stringifyOutput(block.content),
    block.is_error === true,
    timestamp,
    isSidechain,
    pendingTools,
  );
}

function toolResultToChunk(
  toolUseId: string | undefined,
  output: string,
  isError: boolean,
  timestamp: string,
  isSidechain: boolean,
  pendingTools: Map<string, PendingTool>,
): ConversationChunk {
  const pending = toolUseId ? pendingTools.get(toolUseId) : undefined;
  if (toolUseId != null) pendingTools.delete(toolUseId);

  return {
    role: 'tool',
    timestamp,
    content: '',
    toolName: `${pending?.name ?? 'Tool'} result`,
    toolUseId,
    toolOutput: truncateForDisplay(output, 3000),
    isError,
    isSidechain,
  };
}

function extractText(content: unknown): string {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';

  const texts: string[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    const type = stringValue(block.type);
    if (type === 'text' || type === 'input_text') {
      const text = stringValue(block.text) ?? stringValue(block.content);
      if (text?.trim()) texts.push(text);
    }
  }
  return texts.join('\n\n');
}

function truncateForDisplay(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.substring(0, maxLen) + '\n... (truncated)';
}

function stringifyOutput(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    const parts = value
      .filter(isRecord)
      .map((part) => stringValue(part.text) ?? stringValue(part.content) ?? '')
      .filter((part) => part.trim() !== '');
    if (parts.length > 0) return parts.join('\n');
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
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
    const provider = this.sessionMonitor.getProvider();
    const reader = provider.createReader(filePath);
    const events = reader.readAll();
    reader.flush();

    return conversationChunksFromSessionEvents(events);
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
        const summary = chunk.toolSummary
          ? `<span class="tool-summary">${this.escapeHtml(chunk.toolSummary)}</span>`
          : '';

        // Tool-call rows carry their gist in the header summary, so they render
        // as concise, non-expandable rows. Only tool-result rows (which have
        // output) get a collapsible body.
        if (!chunk.toolOutput) {
          return `<div class="chunk tool-chunk${sidechain}" id="chunk-${i}">
          <div class="tool-header tool-header-static">
            <span class="tool-icon">${chunk.isError ? '!' : '>'}</span>
            <span class="tool-name">${this.escapeHtml(chunk.toolName || 'Tool')}</span>
            ${summary}
            <span class="chunk-time">${time}</span>
          </div>
        </div>`;
        }

        const outputSection = `<div class="tool-section"><div class="tool-section-label">${chunk.isError ? 'Error' : 'Output'}</div><pre class="tool-content${errorClass}">${this.escapeHtml(chunk.toolOutput)}</pre></div>`;

        return `<div class="chunk tool-chunk${sidechain}" id="chunk-${i}">
          <div class="tool-header" data-toggle="tool-body-${i}">
            <span class="tool-icon">${chunk.isError ? '!' : '>'}</span>
            <span class="tool-name">${this.escapeHtml(chunk.toolName || 'Tool')}</span>
            ${summary}
            <span class="chunk-time">${time}</span>
            <span class="toggle-arrow">+</span>
          </div>
          <div class="tool-body" id="tool-body-${i}" style="display:none;">
            ${outputSection}
          </div>
        </div>`;
      }

      if (chunk.role === 'reasoning') {
        return `<details class="chunk reasoning-chunk${sidechain}" id="chunk-${i}">
          <summary>
            <span class="role-label reasoning">Reasoning</span>
            ${chunk.model ? `<span class="model-tag">${this.getShortModelName(chunk.model)}</span>` : ''}
            <span class="chunk-time">${time}</span>
          </summary>
          <div class="reasoning-body">${this.escapeHtml(chunk.content)}</div>
        </details>`;
      }

      const ROLE_LABELS: Record<string, string> = { user: 'You', assistant: 'Assistant' };
      const roleLabel = ROLE_LABELS[chunk.role] ?? 'System';
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

    .reasoning-chunk {
      background: var(--vscode-editor-inactiveSelectionBackground, rgba(255,255,255,0.03));
      border-left: 3px solid var(--vscode-descriptionForeground);
      opacity: 0.82;
    }

    .reasoning-chunk summary {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 12px;
      cursor: pointer;
      color: var(--vscode-descriptionForeground);
    }

    .reasoning-body {
      padding: 4px 12px 12px;
      white-space: pre-wrap;
      word-break: break-word;
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
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
    .role-label.reasoning { color: var(--vscode-descriptionForeground); }

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

    .tool-header-static {
      cursor: default;
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

    .tool-summary {
      font-weight: normal;
      color: var(--vscode-descriptionForeground);
      margin-left: 6px;
      font-size: 11px;
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
    if (model.includes('fable')) return 'Fable';
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
