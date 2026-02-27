/**
 * Generate a self-contained HTML session report from AggregatedMetrics + TranscriptEntry[].
 *
 * All CSS and JS are inlined — the output HTML file has zero external dependencies.
 */

import type { AggregatedMetrics } from '../aggregation/types';
import type { TranscriptEntry, TranscriptContentBlock, HtmlReportOptions } from './types';
import { escapeHtml, simpleMarkdownToHtml, highlightCodeBlock, fmtTokens, fmtCost, formatTimestamp, formatDuration } from './htmlHelpers';
import { SIDEKICK_LOGO_BASE64 } from './logo';

/**
 * Generate a complete, self-contained HTML report.
 */
export function generateHtmlReport(
  metrics: AggregatedMetrics,
  transcript: TranscriptEntry[],
  options: HtmlReportOptions = {},
): string {
  const {
    sessionFileName,
    includeThinking = true,
    includeToolDetail = true,
    theme = 'dark',
  } = options;

  const duration = formatDuration(metrics.sessionStartTime, metrics.lastEventTime);
  const totalTokens = metrics.tokens.inputTokens + metrics.tokens.outputTokens;

  return `<!DOCTYPE html>
<html lang="en" data-theme="${theme}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Sidekick Session Report${sessionFileName ? ` — ${escapeHtml(sessionFileName)}` : ''}</title>
${generateStyles()}
</head>
<body>
${generateHeader(metrics, sessionFileName, duration)}
${generateStatsCards(metrics, totalTokens, duration)}
${generateModelBreakdown(metrics)}
${generateToolBreakdown(metrics)}
${generateTranscriptControls()}
${generateTranscript(transcript, includeThinking, includeToolDetail)}
${generateBackToTop()}
${generateScript()}
</body>
</html>`;
}

function generateStyles(): string {
  return `<style>
:root {
  --bg-primary: #0f0a1a;
  --bg-secondary: #1a1230;
  --bg-card: #221a3a;
  --bg-code: #151020;
  --text-primary: #e8e0f0;
  --text-secondary: #a89bc0;
  --text-muted: #6b5f80;
  --accent-purple: #9b6dff;
  --accent-purple-dim: #6b4db0;
  --accent-blue: #5b9cf5;
  --accent-orange: #f5a623;
  --accent-green: #4ade80;
  --accent-red: #f87171;
  --border-color: #2a2045;
  --border-subtle: #1e1535;
  --user-border: #9b6dff;
  --assistant-border: #5b9cf5;
  --system-border: #6b5f80;
  --tool-border: #f5a623;
  --thinking-border: #4b3d65;
  --radius: 8px;
  --shadow: 0 2px 8px rgba(0,0,0,0.3);
}

* { margin: 0; padding: 0; box-sizing: border-box; }

body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  background: var(--bg-primary);
  color: var(--text-primary);
  line-height: 1.6;
  min-height: 100vh;
}

.container { max-width: 1000px; margin: 0 auto; padding: 20px; }

/* Header */
.header {
  background: linear-gradient(135deg, var(--bg-secondary), var(--bg-card));
  border-bottom: 2px solid var(--accent-purple-dim);
  padding: 24px 0;
  margin-bottom: 24px;
}
.header-inner {
  max-width: 1000px;
  margin: 0 auto;
  padding: 0 20px;
  display: flex;
  align-items: center;
  gap: 16px;
  flex-wrap: wrap;
}
.logo { display: flex; align-items: center; gap: 10px; }
.logo svg { width: 32px; height: 32px; }
.logo-text {
  font-size: 22px;
  font-weight: 700;
  background: linear-gradient(135deg, var(--accent-purple), var(--accent-blue));
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
}
.header-meta {
  margin-left: auto;
  text-align: right;
  color: var(--text-secondary);
  font-size: 13px;
}
.header-meta .session-file { font-family: monospace; color: var(--text-muted); }

/* Stats Cards */
.stats-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 12px;
  margin-bottom: 24px;
}
.stat-card {
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: var(--radius);
  padding: 16px;
  box-shadow: var(--shadow);
}
.stat-card .label { color: var(--text-muted); font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px; }
.stat-card .value { font-size: 24px; font-weight: 700; color: var(--accent-purple); margin-top: 4px; }
.stat-card .sub { color: var(--text-secondary); font-size: 12px; margin-top: 2px; }

/* Tables */
.section { margin-bottom: 24px; }
.section-title {
  font-size: 16px;
  font-weight: 600;
  color: var(--text-primary);
  margin-bottom: 12px;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--border-color);
}
table {
  width: 100%;
  border-collapse: collapse;
  background: var(--bg-card);
  border-radius: var(--radius);
  overflow: hidden;
  box-shadow: var(--shadow);
}
th {
  background: var(--bg-secondary);
  color: var(--text-secondary);
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  padding: 10px 14px;
  text-align: left;
  font-weight: 600;
}
td { padding: 10px 14px; border-top: 1px solid var(--border-subtle); color: var(--text-primary); font-size: 14px; }
tr:hover td { background: rgba(155,109,255,0.05); }

/* Transcript */
.transcript-controls {
  display: flex;
  gap: 12px;
  align-items: center;
  flex-wrap: wrap;
  margin-bottom: 16px;
  padding: 12px;
  background: var(--bg-card);
  border-radius: var(--radius);
  border: 1px solid var(--border-color);
}
.transcript-controls label { color: var(--text-secondary); font-size: 13px; cursor: pointer; display: flex; align-items: center; gap: 4px; }
.transcript-controls input[type="checkbox"] { accent-color: var(--accent-purple); }
.transcript-controls button {
  background: var(--accent-purple-dim);
  color: white;
  border: none;
  padding: 6px 12px;
  border-radius: 4px;
  cursor: pointer;
  font-size: 12px;
}
.transcript-controls button:hover { background: var(--accent-purple); }

.message {
  margin-bottom: 12px;
  border-left: 3px solid var(--border-color);
  border-radius: 0 var(--radius) var(--radius) 0;
  background: var(--bg-card);
  box-shadow: var(--shadow);
  overflow: hidden;
}
.message.user { border-left-color: var(--user-border); }
.message.assistant { border-left-color: var(--assistant-border); }
.message.system { border-left-color: var(--system-border); }
.message.summary { border-left-color: var(--system-border); }

.message-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 14px;
  background: rgba(0,0,0,0.15);
  font-size: 12px;
}
.role-badge {
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 3px;
}
.role-badge.user { background: rgba(155,109,255,0.2); color: var(--accent-purple); }
.role-badge.assistant { background: rgba(91,156,245,0.2); color: var(--accent-blue); }
.role-badge.system { background: rgba(107,95,128,0.2); color: var(--text-muted); }
.role-badge.summary { background: rgba(107,95,128,0.2); color: var(--text-muted); }
.message-ts { color: var(--text-muted); margin-left: auto; }
.message-model { color: var(--text-secondary); font-family: monospace; font-size: 11px; }
.message-tokens { color: var(--text-muted); font-size: 11px; }

.message-body { padding: 12px 14px; }
.message-body p { margin-bottom: 8px; }
.message-body p:last-child { margin-bottom: 0; }
.message-body h1, .message-body h2, .message-body h3, .message-body h4 {
  margin: 12px 0 6px 0;
  color: var(--text-primary);
}
.message-body ul { margin: 6px 0; padding-left: 20px; }
.message-body li { margin: 2px 0; }
.message-body blockquote {
  border-left: 3px solid var(--accent-purple-dim);
  padding-left: 12px;
  color: var(--text-secondary);
  margin: 8px 0;
}
.message-body a { color: var(--accent-blue); text-decoration: none; }
.message-body a:hover { text-decoration: underline; }
.message-body hr { border: none; border-top: 1px solid var(--border-color); margin: 12px 0; }

/* Tool blocks */
.tool-block {
  margin: 8px 0;
  border: 1px solid var(--tool-border);
  border-radius: var(--radius);
  overflow: hidden;
}
.tool-block summary {
  padding: 8px 12px;
  background: rgba(245,166,35,0.08);
  color: var(--accent-orange);
  cursor: pointer;
  font-size: 13px;
  font-weight: 600;
  font-family: monospace;
  display: flex;
  align-items: center;
  gap: 6px;
}
.tool-block summary::marker { color: var(--accent-orange); }
.tool-block .tool-content {
  padding: 10px 12px;
  background: var(--bg-code);
  font-size: 13px;
  max-height: 500px;
  overflow: auto;
}
.tool-label { font-size: 10px; text-transform: uppercase; color: var(--text-muted); margin-bottom: 4px; letter-spacing: 0.5px; }
.tool-io { margin-bottom: 8px; }
.tool-io:last-child { margin-bottom: 0; }
.tool-io pre {
  background: var(--bg-primary);
  padding: 8px;
  border-radius: 4px;
  overflow-x: auto;
  font-size: 12px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
}
.tool-error { color: var(--accent-red); }
.tool-result-block {
  margin: 8px 0;
  border: 1px solid var(--border-color);
  border-radius: var(--radius);
  overflow: hidden;
}
.tool-result-block summary {
  padding: 8px 12px;
  background: rgba(91,156,245,0.05);
  color: var(--text-secondary);
  cursor: pointer;
  font-size: 13px;
  font-family: monospace;
}
.tool-result-block .tool-content {
  padding: 10px 12px;
  background: var(--bg-code);
  font-size: 13px;
  max-height: 500px;
  overflow: auto;
}

/* Thinking blocks */
.thinking-block {
  margin: 8px 0;
  border: 1px solid var(--thinking-border);
  border-radius: var(--radius);
  opacity: 0.75;
}
.thinking-block summary {
  padding: 8px 12px;
  color: var(--text-muted);
  cursor: pointer;
  font-size: 12px;
  font-style: italic;
}
.thinking-block .thinking-content {
  padding: 10px 12px;
  background: rgba(0,0,0,0.1);
  color: var(--text-secondary);
  font-size: 13px;
  max-height: 400px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
}

/* Code */
.code-block-wrapper { position: relative; margin: 8px 0; }
.code-block {
  background: var(--bg-primary);
  border: 1px solid var(--border-color);
  border-radius: 4px;
  padding: 12px;
  overflow-x: auto;
  font-size: 13px;
  line-height: 1.5;
}
.code-block code { font-family: 'SF Mono', 'Fira Code', 'JetBrains Mono', monospace; }
.copy-btn {
  position: absolute;
  top: 6px;
  right: 6px;
  background: var(--bg-card);
  color: var(--text-muted);
  border: 1px solid var(--border-color);
  padding: 3px 8px;
  border-radius: 3px;
  cursor: pointer;
  font-size: 11px;
  opacity: 0;
  transition: opacity 0.15s;
}
.code-block-wrapper:hover .copy-btn { opacity: 1; }
.copy-btn:hover { color: var(--text-primary); background: var(--bg-secondary); }
.inline-code {
  background: var(--bg-code);
  padding: 1px 5px;
  border-radius: 3px;
  font-family: monospace;
  font-size: 0.9em;
  color: var(--accent-purple);
}

/* Syntax highlighting */
.hl-keyword { color: #c678dd; }
.hl-string { color: #98c379; }
.hl-number { color: #d19a66; }
.hl-comment { color: #5c6370; font-style: italic; }
.hl-key { color: #61afef; }

/* Back to top */
.back-to-top {
  position: fixed;
  bottom: 24px;
  right: 24px;
  background: var(--accent-purple);
  color: white;
  border: none;
  width: 40px;
  height: 40px;
  border-radius: 50%;
  cursor: pointer;
  font-size: 18px;
  display: none;
  align-items: center;
  justify-content: center;
  box-shadow: 0 2px 12px rgba(155,109,255,0.4);
  z-index: 100;
}
.back-to-top:hover { transform: scale(1.1); }

/* Responsive */
@media (max-width: 640px) {
  .container { padding: 12px; }
  .header-inner { flex-direction: column; align-items: flex-start; }
  .header-meta { margin-left: 0; text-align: left; }
  .stats-grid { grid-template-columns: repeat(2, 1fr); }
  .stat-card .value { font-size: 18px; }
}
</style>`;
}

function generateHeader(metrics: AggregatedMetrics, sessionFileName: string | undefined, duration: string): string {
  const startDate = metrics.sessionStartTime
    ? new Date(metrics.sessionStartTime).toLocaleString()
    : 'N/A';

  return `<div class="header">
  <div class="header-inner">
    <div class="logo">
      <img src="${SIDEKICK_LOGO_BASE64}" alt="Sidekick" width="32" height="32" style="border-radius:6px">
      <span class="logo-text">Sidekick</span>
    </div>
    <div class="header-meta">
      <div>Session Report &middot; ${escapeHtml(startDate)} &middot; ${escapeHtml(duration)}</div>
      <div>${metrics.currentModel ? `<span class="message-model">${escapeHtml(metrics.currentModel)}</span> &middot; ` : ''}${metrics.providerId ? escapeHtml(metrics.providerId) : ''}</div>
      ${sessionFileName ? `<div class="session-file">${escapeHtml(sessionFileName)}</div>` : ''}
    </div>
  </div>
</div>`;
}

function generateStatsCards(metrics: AggregatedMetrics, totalTokens: number, duration: string): string {
  const toolCount = metrics.toolStats.reduce((sum, t) => sum + t.successCount + t.failureCount, 0);

  const cards = [
    { label: 'Messages', value: String(metrics.messageCount), sub: `${metrics.eventCount} events` },
    { label: 'Duration', value: duration, sub: metrics.sessionStartTime ? formatTimestamp(metrics.sessionStartTime) + ' start' : '' },
    { label: 'Total Tokens', value: fmtTokens(totalTokens), sub: `${fmtTokens(metrics.tokens.inputTokens)} in / ${fmtTokens(metrics.tokens.outputTokens)} out` },
    { label: 'Cache', value: fmtTokens(metrics.tokens.cacheReadTokens), sub: `${fmtTokens(metrics.tokens.cacheWriteTokens)} written` },
    { label: 'Tool Calls', value: String(toolCount), sub: `${metrics.toolStats.length} unique tools` },
  ];

  if (metrics.tokens.reportedCost > 0) {
    cards.push({ label: 'Cost', value: fmtCost(metrics.tokens.reportedCost), sub: 'reported' });
  }

  return `<div class="container">
<div class="stats-grid">
${cards.map(c => `  <div class="stat-card">
    <div class="label">${c.label}</div>
    <div class="value">${c.value}</div>
    ${c.sub ? `<div class="sub">${c.sub}</div>` : ''}
  </div>`).join('\n')}
</div>`;
}

function generateModelBreakdown(metrics: AggregatedMetrics): string {
  if (metrics.modelStats.length === 0) return '';

  const rows = metrics.modelStats.map(m =>
    `<tr><td>${escapeHtml(m.model)}</td><td>${m.calls}</td><td>${fmtTokens(m.tokens)}</td><td>${fmtTokens(m.inputTokens)} / ${fmtTokens(m.outputTokens)}</td><td>${fmtCost(m.cost)}</td></tr>`
  ).join('\n');

  return `<div class="section">
<div class="section-title">Model Breakdown</div>
<table>
<thead><tr><th>Model</th><th>Calls</th><th>Total Tokens</th><th>In / Out</th><th>Cost</th></tr></thead>
<tbody>${rows}</tbody>
</table>
</div>`;
}

function generateToolBreakdown(metrics: AggregatedMetrics): string {
  if (metrics.toolStats.length === 0) return '';

  const sorted = [...metrics.toolStats].sort((a, b) => (b.successCount + b.failureCount) - (a.successCount + a.failureCount));
  const rows = sorted.map(t => {
    const total = t.successCount + t.failureCount;
    const avgMs = t.completedCount > 0 ? Math.round(t.totalDuration / t.completedCount) : 0;
    const failHtml = t.failureCount > 0 ? `<span style="color:var(--accent-red)">${t.failureCount}</span>` : '0';
    return `<tr><td><code>${escapeHtml(t.name)}</code></td><td>${total}</td><td>${failHtml}</td><td>${avgMs > 0 ? `${avgMs}ms` : '-'}</td></tr>`;
  }).join('\n');

  return `<div class="section">
<div class="section-title">Tool Breakdown</div>
<table>
<thead><tr><th>Tool</th><th>Total</th><th>Failed</th><th>Avg Duration</th></tr></thead>
<tbody>${rows}</tbody>
</table>
</div>`;
}

function generateTranscriptControls(): string {
  return `<div class="section">
<div class="section-title">Conversation Transcript</div>
<div class="transcript-controls">
  <label><input type="checkbox" id="filter-user" checked onchange="filterMessages()"> User</label>
  <label><input type="checkbox" id="filter-assistant" checked onchange="filterMessages()"> Assistant</label>
  <label><input type="checkbox" id="filter-tool" checked onchange="filterMessages()"> Tools</label>
  <label><input type="checkbox" id="filter-thinking" checked onchange="filterMessages()"> Thinking</label>
  <label><input type="checkbox" id="filter-system" checked onchange="filterMessages()"> System</label>
  <button onclick="toggleAllDetails(true)">Expand All</button>
  <button onclick="toggleAllDetails(false)">Collapse All</button>
</div>`;
}

function generateTranscript(
  transcript: TranscriptEntry[],
  includeThinking: boolean,
  includeToolDetail: boolean,
): string {
  if (transcript.length === 0) {
    return `<div class="message"><div class="message-body"><em>No transcript data available</em></div></div>\n</div>`;
  }

  const parts: string[] = [];

  for (const entry of transcript) {
    parts.push(renderMessage(entry, includeThinking, includeToolDetail));
  }

  parts.push('</div>'); // close .section container opened in generateStatsCards
  parts.push('</div>'); // close .container
  return parts.join('\n');
}

function renderMessage(entry: TranscriptEntry, includeThinking: boolean, includeToolDetail: boolean): string {
  const ts = entry.timestamp ? formatTimestamp(entry.timestamp) : '';
  const roleBadge = `<span class="role-badge ${entry.type}">${entry.type}</span>`;
  const modelStr = entry.model ? `<span class="message-model">${escapeHtml(entry.model)}</span>` : '';
  const tokenStr = entry.usage
    ? `<span class="message-tokens">${fmtTokens(entry.usage.input_tokens + entry.usage.output_tokens)} tokens</span>`
    : '';

  const bodyParts: string[] = [];

  for (const block of entry.content) {
    bodyParts.push(renderContentBlock(block, includeThinking, includeToolDetail));
  }

  const bodyContent = bodyParts.filter(Boolean).join('\n');
  if (!bodyContent.trim()) return '';

  return `<div class="message ${entry.type}" data-type="${entry.type}">
  <div class="message-header">
    ${roleBadge}
    ${modelStr}
    ${tokenStr}
    <span class="message-ts">${ts}</span>
  </div>
  <div class="message-body">
    ${bodyContent}
  </div>
</div>`;
}

function renderContentBlock(block: TranscriptContentBlock, includeThinking: boolean, includeToolDetail: boolean): string {
  switch (block.type) {
    case 'text':
      return `<div class="text-content">${simpleMarkdownToHtml(block.text || '')}</div>`;

    case 'thinking':
      if (!includeThinking) return '';
      return `<details class="thinking-block" data-block-type="thinking">
  <summary>Thinking...</summary>
  <div class="thinking-content">${escapeHtml(block.text || '')}</div>
</details>`;

    case 'tool_use':
      return renderToolUse(block, includeToolDetail);

    case 'tool_result':
      return renderToolResult(block, includeToolDetail);

    case 'image':
      return '<div class="text-content"><em>[Image content]</em></div>';

    default:
      return '';
  }
}

function renderToolUse(block: TranscriptContentBlock, includeDetail: boolean): string {
  const name = block.toolName || 'unknown';

  if (!includeDetail) {
    return `<div class="tool-block" data-block-type="tool"><div style="padding:8px 12px;background:rgba(245,166,35,0.08);color:var(--accent-orange);font-family:monospace;font-size:13px;">${escapeHtml(name)}</div></div>`;
  }

  let inputHtml = '';
  if (block.toolInput && Object.keys(block.toolInput).length > 0) {
    const inputJson = JSON.stringify(block.toolInput, null, 2);
    const highlighted = highlightCodeBlock(inputJson, 'json');
    inputHtml = `<div class="tool-io">
    <div class="tool-label">Input</div>
    <pre>${highlighted}</pre>
  </div>`;
  }

  return `<details class="tool-block" data-block-type="tool">
  <summary>${escapeHtml(name)}${block.toolUseId ? ` <span style="color:var(--text-muted);font-size:11px">${escapeHtml(block.toolUseId)}</span>` : ''}</summary>
  <div class="tool-content">
    ${inputHtml}
  </div>
</details>`;
}

function renderToolResult(block: TranscriptContentBlock, includeDetail: boolean): string {
  if (!includeDetail) return '';

  const output = block.output || '';
  const isError = block.isError;
  const errorClass = isError ? ' tool-error' : '';
  const label = isError ? 'Error Output' : 'Output';

  if (!output.trim()) {
    return `<details class="tool-result-block" data-block-type="tool">
  <summary>${label}: <span style="color:var(--text-muted)">(empty)</span></summary>
  <div class="tool-content"></div>
</details>`;
  }

  // Truncate extremely long output in the HTML to prevent huge files
  const maxLen = 50000;
  const displayOutput = output.length > maxLen
    ? output.substring(0, maxLen) + `\n\n... (truncated ${output.length - maxLen} characters)`
    : output;

  return `<details class="tool-result-block${errorClass}" data-block-type="tool">
  <summary class="${errorClass}">${label} (${formatOutputSize(output.length)})</summary>
  <div class="tool-content">
    <pre>${escapeHtml(displayOutput)}</pre>
  </div>
</details>`;
}

function formatOutputSize(len: number): string {
  if (len >= 1000) return `${(len / 1000).toFixed(1)}k chars`;
  return `${len} chars`;
}

function generateBackToTop(): string {
  return `<button class="back-to-top" id="backToTop" onclick="window.scrollTo({top:0,behavior:'smooth'})">&uarr;</button>`;
}

function generateScript(): string {
  return `<script>
// Back to top visibility
window.addEventListener('scroll', function() {
  var btn = document.getElementById('backToTop');
  btn.style.display = window.scrollY > 300 ? 'flex' : 'none';
});

// Filter messages by type
function filterMessages() {
  var showUser = document.getElementById('filter-user').checked;
  var showAssistant = document.getElementById('filter-assistant').checked;
  var showTool = document.getElementById('filter-tool').checked;
  var showThinking = document.getElementById('filter-thinking').checked;
  var showSystem = document.getElementById('filter-system').checked;

  document.querySelectorAll('.message').forEach(function(msg) {
    var type = msg.getAttribute('data-type');
    var visible = true;
    if (type === 'user') visible = showUser;
    else if (type === 'assistant') visible = showAssistant;
    else if (type === 'system' || type === 'summary') visible = showSystem;
    msg.style.display = visible ? '' : 'none';
  });

  // Tool blocks within messages
  document.querySelectorAll('[data-block-type="tool"]').forEach(function(el) {
    el.style.display = showTool ? '' : 'none';
  });

  // Thinking blocks
  document.querySelectorAll('[data-block-type="thinking"]').forEach(function(el) {
    el.style.display = showThinking ? '' : 'none';
  });
}

// Expand/collapse all details
function toggleAllDetails(open) {
  document.querySelectorAll('details').forEach(function(d) { d.open = open; });
}

// Copy code block content
function copyCode(btn) {
  var pre = btn.parentElement.querySelector('pre');
  var text = pre.textContent || pre.innerText;
  navigator.clipboard.writeText(text).then(function() {
    btn.textContent = 'Copied!';
    setTimeout(function() { btn.textContent = 'Copy'; }, 1500);
  });
}
</script>`;
}
