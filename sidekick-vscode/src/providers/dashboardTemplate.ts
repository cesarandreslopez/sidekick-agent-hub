/**
 * Dashboard webview document. The markup and CSS live here as strings; the
 * behaviour lives in the esbuild bundle `out/webview/dashboard.js` (from
 * `src/webview/dashboard/index.ts`), which reads its initial data from the
 * JSON block the template embeds under `DASHBOARD_INIT_ELEMENT_ID`.
 *
 * @module providers/dashboardTemplate
 */

import { getRandomPhrase } from 'sidekick-shared/phrases';
import { getDesignTokenCSS, getSharedStyles } from '../utils/designTokens';
import { getAttributionPaletteCSS } from '../utils/themePalette';
import { DASHBOARD_INIT_ELEMENT_ID } from '../webview/dashboard/init';
import { DASHBOARD_STYLES } from './dashboardStyles';

export interface DashboardTemplateOptions {
  /** CSP nonce shared by every script tag. */
  nonce: string;
  /** `webview.cspSource` of the hosting webview. */
  cspSource: string;
  /** Webview URI of `out/webview/chartjs-vendor.js`. */
  chartjsUri: string;
  /** Webview URI of `out/webview/dashboard.js`. */
  scriptUri: string;
  /** Webview URI of the extension icon. */
  iconUri: string;
  extVersion: string;
  extDate: string;
  /** Script-safe JSON of a `DashboardInit` (see `_safeJsonForScript`). */
  initJson: string;
}

export function renderDashboardHtml(options: DashboardTemplateOptions): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none';
                 style-src ${options.cspSource} 'unsafe-inline';
                 img-src ${options.cspSource};
                 script-src 'nonce-${options.nonce}' ${options.cspSource};">
  <title>Session Analytics</title>
  ${getDesignTokenCSS()}
    ${getAttributionPaletteCSS()}
  ${getSharedStyles()}
  <style>${DASHBOARD_STYLES}</style>
</head>
<body>
  <div class="header">
    <img src="${options.iconUri}" alt="Sidekick" />
    <h1>Session Analytics</h1>
    <span class="version-badge" id="version-badge" title="What's New">v${options.extVersion}</span>
    <span id="status" class="status inactive" aria-live="polite">No Session</span>
  </div>
  <p id="header-phrase" class="header-phrase">${getRandomPhrase()}</p>

  <div class="custom-path-indicator" id="custom-path-indicator" title="Using a manually selected session folder">
    <span class="path-text" id="custom-path-text">Custom: /path/to/folder</span>
    <span class="reset-link" id="reset-custom-path" title="Switch back to auto-detect mode">Reset</span>
  </div>

  <div class="session-navigator expanded" id="session-navigator">
    <div class="session-nav-header" data-collapsible="true">
      <div class="session-nav-header-left">
        <span class="toggle-icon">▶</span>
        <span class="session-nav-title">Sessions</span>
      </div>
      <div class="session-nav-actions">
        <div class="session-provider">
          <label for="session-provider-select">Provider</label>
          <select id="session-provider-select">
            <option value="claude-code">Claude Code</option>
            <option value="opencode">OpenCode</option>
            <option value="codex">Codex CLI</option>
          </select>
        </div>
        <button class="pin-btn" id="pin-session" title="Pin session to prevent auto-switching" aria-pressed="false">Pin</button>
        <button class="nav-btn" id="refresh-sessions" title="Refresh session list" aria-label="Refresh session list">↻</button>
        <button class="nav-btn browse" id="browse-folders" title="Browse session folders">Browse...</button>
        <button class="nav-btn" id="open-cli-dashboard" title="Open Sidekick CLI dashboard in terminal">⌨ CLI</button>
      </div>
    </div>
    <div class="session-list" id="session-list">
      <div class="session-list-loading">
        <span class="session-list-spinner"></span>
        Loading sessions\u2026
      </div>
    </div>
  </div>

  <div class="tab-container" role="tablist" aria-label="Dashboard tabs">
    <button class="tab-btn active" data-tab="session" role="tab" aria-selected="true" aria-controls="session-tab">Session</button>
    <button class="tab-btn" data-tab="summary" role="tab" aria-selected="false" aria-controls="summary-tab">Summary</button>
    <button class="tab-btn" data-tab="history" role="tab" aria-selected="false" aria-controls="history-tab">History</button>
    <button class="tab-btn" data-tab="health" role="tab" aria-selected="false" aria-controls="health-tab">Health</button>
  </div>

  <div id="session-tab" class="tab-content active" role="tabpanel" aria-label="Session">
    <div id="content">
      <div class="empty-state">
        <p id="empty-state-title">No active session detected.</p>
        <p id="empty-state-hint">Start a Claude Code, OpenCode, or Codex session to see real-time analytics here.</p>
        <p id="empty-state-phrase" class="empty-state-phrase">${getRandomPhrase()}</p>
      </div>
    </div>

    <div id="dashboard" style="display: none;">
      <div class="metric-toggles" role="toolbar" aria-label="Metric toggles">
        <button class="metric-btn active" data-metric="quota" aria-pressed="true">Quota</button>
        <button class="metric-btn" data-metric="cost" aria-pressed="false">Cost</button>
        <button class="metric-btn" data-metric="tokens" aria-pressed="false">Tokens</button>
        <button class="metric-btn" data-metric="cache" aria-pressed="false">Cache</button>
      </div>

      <div class="provider-status-stack" aria-live="polite">
        <div class="provider-status-section" id="provider-status-section" title="Claude API status from status.claude.com">
          <div class="provider-status-content" id="provider-status-content">
            <div class="provider-status-summary-row">
              <span class="provider-status-dot" id="provider-status-dot" aria-hidden="true"></span>
              <div class="provider-status-main">
                <div class="provider-status-title" id="provider-status-title"></div>
                <div class="provider-status-summary" id="provider-status-summary"></div>
              </div>
              <span class="provider-status-affected" id="provider-status-affected"></span>
              <button class="provider-status-toggle" id="provider-status-toggle" type="button" aria-expanded="false" aria-controls="provider-status-details">Details</button>
              <a class="provider-status-link" id="provider-status-link" href="#" aria-label="Open Claude status incident">&#8599;</a>
            </div>
            <div class="provider-status-details" id="provider-status-details" hidden></div>
          </div>
        </div>

        <div class="provider-status-section" id="openai-status-section" title="OpenAI API status from status.openai.com">
          <div class="provider-status-content" id="openai-status-content">
            <div class="provider-status-summary-row">
              <span class="provider-status-dot" id="openai-status-dot" aria-hidden="true"></span>
              <div class="provider-status-main">
                <div class="provider-status-title" id="openai-status-title"></div>
                <div class="provider-status-summary" id="openai-status-summary"></div>
              </div>
              <span class="provider-status-affected" id="openai-status-affected"></span>
              <button class="provider-status-toggle" id="openai-status-toggle" type="button" aria-expanded="false" aria-controls="openai-status-details">Details</button>
              <a class="provider-status-link" id="openai-status-link" href="#" aria-label="Open OpenAI status incident">&#8599;</a>
            </div>
            <div class="provider-status-details" id="openai-status-details" hidden></div>
          </div>
        </div>
      </div>

      <div class="gauge-row" id="gauge-row">
        <div class="gauge-row-item context-item" title="How much of the model's context window (200K–1M tokens depending on model) is currently in use">
          <div class="section-title">Context Window</div>
          <div class="context-gauge" title="Green: &lt;50% | Orange: 50-79% | Red: ≥80%. When full, older context is summarized.">
            <canvas id="contextChart"></canvas>
            <span class="context-percent" id="context-percent" aria-live="polite">0%</span>
          </div>
          <div id="context-health" style="display: none; align-items: center; gap: 4px; font-size: 0.85em; margin-top: 4px;"></div>
          <div id="truncation-info" style="display: none; align-items: center; gap: 4px; font-size: 0.85em; margin-top: 2px;"></div>
        </div>

        <div class="gauge-row-item quota-item quota-section" id="quota-section" title="Claude Max subscription usage limits">
          <div class="section-title">Subscription Quota</div>
          <div class="section-subtitle" id="quota-meta" style="display: none;"></div>
          <div id="quota-content">
            <div class="quota-grid">
              <div class="quota-card" title="Usage in the last 5 hours">
                <div class="quota-label" id="quota-5h-label">5-Hour</div>
                <div class="quota-gauge">
                  <canvas id="quota5hChart"></canvas>
                  <span class="quota-percent" id="quota-5h-percent">0%</span>
                </div>
                <div class="quota-reset" id="quota-5h-reset">-</div>
                <div class="quota-projection" id="quota-5h-projection"></div>
              </div>
              <div class="quota-card" title="Usage in the last 7 days">
                <div class="quota-label" id="quota-7d-label">7-Day</div>
                <div class="quota-gauge">
                  <canvas id="quota7dChart"></canvas>
                  <span class="quota-percent" id="quota-7d-percent">0%</span>
                </div>
                <div class="quota-reset" id="quota-7d-reset">-</div>
                <div class="quota-projection" id="quota-7d-projection"></div>
              </div>
            </div>
            <div class="quota-reset-credits" id="quota-reset-credits" style="display: none;"></div>
          </div>
          <div class="quota-error" id="quota-error" style="display: none;"></div>
        </div>
      </div>

      <div class="billing-block-section" id="billing-block-section" title="Five-hour billing block computed from session logs (local estimate)">
        <div class="billing-block-content">
          <div class="billing-block-header">
            <span class="billing-block-title">Billing block</span>
            <span class="billing-block-window" id="billing-block-window"></span>
          </div>
          <div class="billing-block-row" id="billing-block-usage"></div>
          <div class="billing-block-row" id="billing-block-projection"></div>
          <div class="billing-block-official" id="billing-block-official"></div>
        </div>
      </div>

      <div class="peak-hours-section" id="peak-hours-section" title="Claude peak-hours tracker — data from promoclock.co (third-party, unaffiliated)">
        <div class="peak-hours-content">
          <div class="peak-hours-indicator" id="peak-hours-indicator"></div>
          <div class="peak-hours-details" id="peak-hours-details"></div>
        </div>
      </div>

      <div class="quota-history-section" id="quota-history-section" style="display: none;" aria-label="Quota history heatmap (last 13 weeks)">
        <div class="quota-history-header">
          <div class="section-title">Quota History</div>
          <div class="quota-history-subtitle">Last 13 weeks · peak utilization per day</div>
        </div>
        <div class="quota-history-body" id="quota-history-body"></div>
        <div class="quota-history-legend">
          <span class="quota-history-legend-label">Less</span>
          <span class="quota-history-legend-swatch" data-bucket="0"></span>
          <span class="quota-history-legend-swatch" data-bucket="1"></span>
          <span class="quota-history-legend-swatch" data-bucket="2"></span>
          <span class="quota-history-legend-swatch" data-bucket="3"></span>
          <span class="quota-history-legend-swatch" data-bucket="4"></span>
          <span class="quota-history-legend-label">More</span>
        </div>
      </div>

      <div class="primary-metric-display" data-metric="cost" id="primary-metric-display" style="display: none;" aria-live="polite">
        <div class="metric-value" id="primary-metric-value">$0.00</div>
        <div class="metric-subtitle" id="primary-metric-subtitle">Estimated session cost</div>
      </div>

      <div class="inline-stats" aria-live="polite">
        <div class="inline-stat">
          <div class="stat-value" id="inline-duration">0m</div>
          <div class="stat-label">Duration</div>
        </div>
        <div class="inline-stat">
          <div class="stat-value" id="inline-burn-rate">0</div>
          <div class="stat-label">tok/min</div>
        </div>
        <div class="inline-stat">
          <div class="stat-value" id="inline-api-calls">0</div>
          <div class="stat-label">API calls</div>
        </div>
      </div>

      <div class="latency-section" id="latency-section" style="display: none;">
        <div class="section-title section-title-with-info">
          Response Times
          <span class="info-icon">?<div class="tooltip">
            <p>How long Claude takes to respond to your prompts.</p>
            <p><strong>First Token:</strong> Time until streaming begins (thinking time)</p>
            <p><strong>Total:</strong> Time for complete response</p>
          </div></span>
        </div>
        <div class="latency-display">
          <div class="latency-main">
            <span class="latency-label">First Token:</span>
            <span class="latency-value" id="latency-last">-</span>
            <span class="latency-stats">(avg <span id="latency-avg">-</span> · max <span id="latency-max">-</span>)</span>
          </div>
          <div class="latency-secondary">
            <span class="latency-label">Total:</span>
            <span class="latency-value-secondary">avg <span id="latency-total-avg">-</span></span>
            <span class="latency-count">· <span id="latency-count">0</span> requests</span>
          </div>
        </div>
      </div>

      <!-- Plan Analytics Section -->
      <div class="plan-section" id="plan-section" style="display: none;">
        <div class="section-title">Plan Progress <span class="plan-view-toggle" id="plan-view-toggle" style="display: none;">Show Details</span></div>
        <div id="plan-title" style="font-size: 12px; font-weight: 500; margin-bottom: 4px;"></div>
        <div class="plan-progress-bar-bg">
          <div class="plan-progress-fill" id="plan-progress-fill" style="width: 0%;"></div>
        </div>
        <div class="plan-stats" id="plan-stats"></div>
        <div class="plan-steps-list" id="plan-steps-list"></div>
        <div class="plan-markdown-view" id="plan-markdown-view"></div>
      </div>

      <!-- Plan History Section -->
      <div class="plan-section" id="plan-history-section" style="display: none;">
        <div class="section-title">Plan History</div>
        <div class="plan-stats" id="plan-history-stats"></div>
        <div class="plan-steps-list" id="plan-history-list"></div>
      </div>

      <!-- ── Tier 2/3: Progressive Disclosure ── -->
      <div class="tier-divider"></div>

      <!-- Agent Guidance Suggestions Panel -->
      <div class="suggestions-section" id="suggestions-panel">
        <div class="suggestions-header" id="suggestions-header">
          <div class="suggestions-header-left">
            <span class="suggestions-toggle-icon">▶</span>
            <h3>Improve Agent Guidance</h3>
          </div>
          <button id="analyze-btn" title="Analyze your session patterns to generate suggestions for your agent's instruction file. Better guidance helps the agent work more efficiently on your project.">Get Suggestions</button>
        </div>
        <div class="suggestions-body">
          <p class="suggestions-intro">
            Analyze your session to get AI-powered suggestions for improving your agent's instruction file.
            <a id="guidance-docs-link" href="https://docs.anthropic.com/en/docs/claude-code/memory#claudemd" target="_blank">Best practices →</a>
          </p>
          <div class="suggestions-content">
            <!-- Suggestions will be rendered here -->
          </div>
        </div>
      </div>

      <!-- Session Handoff -->
      <div class="handoff-section">
        <button id="generate-handoff-btn" class="handoff-btn" title="Generate a context handoff document so your next agent session can pick up where this one left off.">Generate Handoff</button>
      </div>

      <!-- Session Activity Group -->
      <div class="details-section" id="session-activity-section">
        <div class="details-toggle" data-group-toggle="session-activity-section">
          <span class="toggle-icon">▶</span>
          <h3 class="details-title">Session Activity <span class="group-count-badge" id="activity-count-badge" style="display:none;">0</span></h3>
          <span class="group-summary" id="session-activity-summary"></span>
          <label class="filter-toggle event-log-toggle" title="Record all session events to ~/.config/sidekick/event-logs/ for debugging. Events are written in real-time as a JSONL audit trail." onclick="event.stopPropagation()">
            <input type="checkbox" id="event-log-toggle" /> Event Log
          </label>
        </div>
        <div class="details-content">
          <!-- Context Attribution -->
          <div class="section" id="context-attribution-section" style="display: none;">
            <div class="section-title section-title-with-info">
              Context Attribution
              <span class="info-icon">?<div class="tooltip">
                <p>Estimated breakdown of where context tokens are spent.</p>
                <p><strong>System Prompt:</strong> CLAUDE.md, system reminders</p>
                <p><strong>User Messages:</strong> Your prompts and text</p>
                <p><strong>Assistant:</strong> Claude's text responses</p>
                <p><strong>Tool I/O:</strong> Tool inputs and outputs</p>
                <p><strong>Thinking:</strong> Extended thinking blocks</p>
              </div></span>
            </div>
            <div id="context-attribution-chart"></div>
            <div class="attribution-legend" id="attribution-legend"></div>
          </div>

          <!-- Per-Turn Attribution Chart -->
          <div class="section" id="turn-attribution-section" style="display: none;">
            <div class="section-title section-title-with-info">
              Per-Turn Token Breakdown
              <span class="info-icon">?<div class="tooltip">
                <p>Token usage per conversation turn, stacked by category.</p>
                <p>Uses actual API token counts for assistant turns.</p>
              </div></span>
            </div>
            <div class="chart-container" style="height: 180px;">
              <canvas id="turnAttributionChart"></canvas>
            </div>
          </div>

          <!-- Context Waterfall Chart -->
          <div class="section" id="context-waterfall-section" style="display: none;">
            <div class="section-title section-title-with-info">
              Context Size Over Time
              <span class="info-icon">?<div class="tooltip">
                <p>Tracks how the context window fills and compacts over time.</p>
                <p>Red vertical lines indicate compaction events.</p>
              </div></span>
            </div>
            <div class="chart-container" style="height: 160px;">
              <canvas id="contextWaterfallChart"></canvas>
            </div>
          </div>

          <!-- Compaction Events -->
          <div class="section" id="compaction-section" style="display: none;">
            <div class="section-title section-title-with-info">
              Context Compactions
              <span class="info-icon">?<div class="tooltip">
                <p>Context compaction occurs when the context window fills up.</p>
                <p>Claude summarizes the conversation to reclaim space.</p>
                <p><strong>Before/After:</strong> Context size in tokens</p>
                <p><strong>Reclaimed:</strong> Tokens freed by compaction</p>
              </div></span>
            </div>
            <div class="compaction-list" id="compaction-list"></div>
            <div id="compaction-ledger" style="font-size:11px;color:var(--vscode-descriptionForeground);margin-top:6px;"></div>
          </div>

          <!-- Notification History -->
          <div class="section" id="notification-history-section" style="display: none;">
            <div class="section-title section-title-with-info">
              Notification History <span class="notification-badge" id="notification-badge" style="display: none;">0</span>
              <span class="info-icon">?<div class="tooltip">
                <p>History of notifications fired during sessions.</p>
                <p>Persisted across extension reloads.</p>
              </div></span>
            </div>
            <div class="notification-actions" id="notification-actions" style="display: none;">
              <button class="small-btn" id="mark-all-read-btn">Mark All Read</button>
              <button class="small-btn" id="clear-notifications-btn">Clear</button>
            </div>
            <div class="notification-list" id="notification-list"></div>
          </div>

          <div class="section">
            <div class="section-title section-title-with-info">
              Activity Timeline
              <span class="info-icon">?<div class="tooltip">
                <p>Chronological log of session events.</p>
                <p><strong>User prompts:</strong> Messages you sent</p>
                <p><strong>Tool calls:</strong> Actions Claude performed</p>
                <p><strong>Results:</strong> Outcomes of tool executions</p>
                <p><strong>Compaction:</strong> Context window was compacted</p>
              </div></span>
            </div>
            <!-- Timeline Search & Filters -->
            <div class="timeline-controls">
              <input type="text" id="timeline-search" class="timeline-search" placeholder="Search timeline..." />
              <div class="timeline-filters" id="timeline-filters">
                <label class="filter-toggle" title="User messages">
                  <input type="checkbox" data-filter="user" checked /> User
                </label>
                <label class="filter-toggle" title="AI responses">
                  <input type="checkbox" data-filter="ai" checked /> AI
                </label>
                <label class="filter-toggle" title="System/noise events">
                  <input type="checkbox" data-filter="system" /> System
                </label>
              </div>
            </div>
            <div class="timeline-list" id="timeline-list">
              <div class="timeline-item">
                <span class="time">--:--</span>
                <span class="description">No activity yet</span>
              </div>
            </div>
          </div>

          <div class="section" id="file-changes-section" style="display: none;">
            <div class="section-title section-title-with-info">
              File Changes
              <span class="info-icon">?<div class="tooltip">
                <p>Summary of code modifications made during this session.</p>
                <p><strong>Files:</strong> Number of unique files edited</p>
                <p><strong>+/-:</strong> Lines added and removed</p>
              </div></span>
            </div>
            <div class="file-changes-display" title="Number of unique files modified with line additions and deletions">
              <span class="file-count" id="file-count">0 files</span>
              <span class="separator">|</span>
              <span class="additions" id="file-additions">+0</span>
              <span class="separator">/</span>
              <span class="deletions" id="file-deletions">-0</span>
              <span class="lines-label">lines</span>
            </div>
            <div id="file-impact" style="font-size:11px;color:var(--vscode-descriptionForeground);margin-top:4px;"></div>
          </div>

          <div class="section" id="error-section" style="display: none;">
            <div class="section-title section-title-with-info">
              Errors
              <span class="info-icon">?<div class="tooltip">
                <p>Errors encountered during tool execution.</p>
                <p>Click on an error type to expand and see details.</p>
                <p>Common causes: file not found, permission denied, syntax errors.</p>
              </div></span>
            </div>
            <div class="error-list" id="error-list"></div>
          </div>
        </div>
      </div>

      <!-- Performance & Cost Group -->
      <div class="details-section" id="perf-cost-section">
        <div class="details-toggle" data-group-toggle="perf-cost-section">
          <span class="toggle-icon">▶</span>
          <h3 class="details-title">Performance &amp; Cost</h3>
          <span class="group-summary" id="perf-cost-summary"></span>
        </div>
        <div class="details-content">
          <div class="section">
            <div class="section-title section-title-with-info">
              Model Breakdown
              <span class="info-icon">?<div class="tooltip">
                <p>Shows which Claude models have been used in this session.</p>
                <p><strong>Opus:</strong> Highest quality, best for complex tasks</p>
                <p><strong>Sonnet:</strong> Balanced speed and quality</p>
                <p><strong>Haiku:</strong> Fast and efficient for simple tasks</p>
              </div></span>
            </div>
            <div class="model-list" id="model-list">
              <!-- Model items will be inserted here -->
            </div>
          </div>

          <div class="section">
            <div class="section-title section-title-with-info">
              Tool Analytics
              <span class="info-icon">?<div class="tooltip">
                <p>Tools invoked by Claude during this session.</p>
                <p><strong>Count:</strong> Number of times each tool was called</p>
                <p><strong>Success rate:</strong> Percentage of successful executions</p>
                <p><strong>Avg time:</strong> Average execution duration</p>
              </div></span>
            </div>
            <div class="tool-list" id="tool-list">
              <div class="tool-item"><span class="tool-name">No tools used yet</span></div>
            </div>
          </div>

          <div class="section" id="tool-eff-section" style="display: none;">
            <div class="section-title">Tool Efficiency</div>
            <div id="tool-eff-body"></div>
          </div>

          <div class="section" id="cache-eff-section" style="display: none;">
            <div class="section-title">Cache Effectiveness</div>
            <div id="cache-eff-body"></div>
          </div>

          <div class="section" id="burn-rate-section" style="display: none;">
            <div class="section-title">Advanced Burn Rate</div>
            <div id="burn-rate-body"></div>
          </div>
        </div>
      </div>

      <!-- Tasks & Recovery Group -->
      <div class="details-section" id="tasks-recovery-section">
        <div class="details-toggle" data-group-toggle="tasks-recovery-section">
          <span class="toggle-icon">▶</span>
          <h3 class="details-title">Tasks &amp; Recovery</h3>
          <span class="group-summary" id="tasks-recovery-summary"></span>
        </div>
        <div class="details-content">
          <div class="section" id="task-perf-section" style="display: none;">
            <div class="section-title">Task Performance</div>
            <div id="task-perf-body"></div>
          </div>

          <div class="section" id="recovery-section" style="display: none;">
            <div class="section-title">Recovery Patterns</div>
            <div id="recovery-body"></div>
          </div>
        </div>
      </div>

      <!-- Decisions Group -->
      <div class="details-section" id="decisions-section-group">
        <div class="details-toggle" data-group-toggle="decisions-section-group">
          <span class="toggle-icon">▶</span>
          <h3 class="details-title">Decisions <span class="group-count-badge" id="decisions-count-badge" style="display:none;">0</span></h3>
          <span class="group-summary" id="decisions-summary"></span>
        </div>
        <div class="details-content">
          <div class="section" id="decisions-section" style="display: none;">
            <div style="margin-bottom:8px;">
              <input type="text" id="decisions-search" placeholder="Search decisions..."
                style="width:100%;padding:4px 8px;background:var(--vscode-input-background);
                color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border);
                border-radius:3px;font-size:11px;box-sizing:border-box;" />
            </div>
            <div id="decisions-count" style="font-size:11px;margin-bottom:8px;color:var(--vscode-descriptionForeground);"></div>
            <div id="decisions-list"></div>
          </div>
        </div>
      </div>

      <!-- Analytics Group (Gonzo/Lazyjournal integration) -->
      <div class="details-section" id="analytics-section-group">
        <div class="details-toggle" data-group-toggle="analytics-section-group">
          <span class="toggle-icon">▶</span>
          <h3 class="details-title">Analytics</h3>
          <span class="group-summary" id="analytics-summary"></span>
        </div>
        <div class="details-content">
          <div class="section" id="tool-freq-section" style="display: none;">
            <div class="section-title">Tool Frequency</div>
            <div class="chart-container" style="height:160px;">
              <canvas id="toolFreqChart"></canvas>
            </div>
          </div>

          <div class="section" id="event-dist-section" style="display: none;">
            <div class="section-title">Event Distribution</div>
            <div class="chart-container" style="height:140px;">
              <canvas id="eventDistChart"></canvas>
            </div>
          </div>

          <div class="section" id="heatmap-section" style="display: none;">
            <div class="section-title">Activity Heatmap <span style="font-weight:normal;font-size:10px;opacity:0.7;">(60 min)</span></div>
            <div id="heatmap-grid"></div>
            <div id="heatmap-stats" style="font-size:10px;color:var(--vscode-descriptionForeground);margin-top:4px;"></div>
          </div>

          <div class="section" id="patterns-section" style="display: none;">
            <div class="section-title">Event Patterns</div>
            <div id="patterns-list"></div>
          </div>
        </div>
      </div>

      <div class="last-updated">
        Last updated: <span id="last-updated" aria-live="polite">-</span>
      </div>
    </div>
  </div>

  <div id="summary-tab" class="tab-content" role="tabpanel" aria-label="Summary">
    <div class="summary-empty" id="summary-empty">
      <p>No session summary available yet.</p>
      <p>A summary will be generated when a session ends, or you can request one during an active session.</p>
    </div>
    <div id="summary-content" style="display: none;">
      <div class="summary-metrics-row" id="summary-metrics">
        <div class="summary-metric-card"><div class="metric-val" id="sum-duration">-</div><div class="metric-lbl">Duration</div></div>
        <div class="summary-metric-card"><div class="metric-val" id="sum-tokens">-</div><div class="metric-lbl">Tokens</div></div>
        <div class="summary-metric-card"><div class="metric-val" id="sum-cost">-</div><div class="metric-lbl">Cost</div></div>
        <div class="summary-metric-card"><div class="metric-val" id="sum-api-calls">-</div><div class="metric-lbl">API Calls</div></div>
        <div class="summary-metric-card"><div class="metric-val" id="sum-context">-</div><div class="metric-lbl">Context Peak</div></div>
        <div class="summary-metric-card"><div class="metric-val" id="sum-completion">-</div><div class="metric-lbl">Tasks Done</div></div>
      </div>

      <div class="narrative-area">
        <button class="narrative-btn" id="generate-narrative-btn">Generate AI Narrative</button>
        <div class="narrative-loading" id="narrative-loading" style="display: none;">
          <span class="narrative-spinner"></span>
          <span>Generating narrative, this usually takes ~15-30s...</span>
        </div>
        <div class="narrative-text" id="narrative-display" style="display: none;"></div>
        <div class="narrative-error" id="narrative-error" style="display: none;"></div>
      </div>

      <div class="summary-section" id="sum-tasks-section">
        <div class="summary-section-title">Tasks</div>
        <div id="sum-tasks-content"></div>
      </div>

      <div class="summary-section" id="sum-files-section">
        <div class="summary-section-title">Files Changed</div>
        <div id="sum-files-content"></div>
      </div>

      <div class="summary-section" id="sum-cost-section">
        <div class="summary-section-title">Cost Breakdown</div>
        <div id="sum-cost-content"></div>
      </div>

      <div class="summary-section" id="sum-errors-section">
        <div class="summary-section-title">Errors &amp; Recovery</div>
        <div id="sum-errors-content"></div>
      </div>

    </div>
  </div>

  <div id="history-tab" class="tab-content" role="tabpanel" aria-label="History">
    <div class="history-controls">
      <div class="range-selector" role="toolbar" aria-label="Time range">
        <button class="range-btn" data-range="today" aria-pressed="false">Today</button>
        <button class="range-btn active" data-range="week" aria-pressed="true">This Week</button>
        <button class="range-btn" data-range="month" aria-pressed="false">This Month</button>
        <button class="range-btn" data-range="all" aria-pressed="false">All Time</button>
      </div>
      <select class="metric-select" id="history-metric-select" aria-label="Metric">
        <option value="tokens">Tokens</option>
        <option value="cost">Cost ($)</option>
        <option value="messages">Messages</option>
      </select>
      <select class="metric-select" id="history-series-select" aria-label="Series">
        <option value="total">Total</option>
        <option value="model">By model</option>
        <option value="tool">By tool</option>
      </select>
      <select class="metric-select" id="history-project-select" aria-label="Project" title="Filter to one workspace (last 500 sessions)">
        <option value="">All projects</option>
      </select>
    </div>

    <div class="chart-container history-chart">
      <canvas id="historyChart"></canvas>
    </div>

    <div class="breadcrumb" id="drill-breadcrumb" style="display: none;">
      <span class="breadcrumb-back" id="drill-up">← Back</span>
      <span class="breadcrumb-current" id="drill-label"></span>
    </div>

    <div class="history-summary" id="history-summary">
      <div class="history-stat">
        <div class="stat-value" id="history-total-tokens">0</div>
        <div class="stat-label">Total Tokens</div>
        <div class="stat-delta" id="history-total-tokens-delta"></div>
      </div>
      <div class="history-stat">
        <div class="stat-value" id="history-total-cost">$0.00</div>
        <div class="stat-label">Total Cost</div>
        <div class="stat-delta" id="history-total-cost-delta"></div>
      </div>
      <div class="history-stat">
        <div class="stat-value" id="history-sessions">0</div>
        <div class="stat-label">Sessions</div>
        <div class="stat-delta" id="history-sessions-delta"></div>
      </div>
      <div class="history-stat">
        <div class="stat-value" id="history-messages">0</div>
        <div class="stat-label">Messages</div>
        <div class="stat-delta" id="history-messages-delta"></div>
      </div>
    </div>

    <div class="section" id="quality-trend-section" style="display: none; margin-top: 12px;">
      <div class="section-title">Session Quality <span style="font-size:10px;color:var(--vscode-descriptionForeground);">BETA</span></div>
      <div id="quality-trend-summary" style="font-size:12px;margin:6px 0;"></div>
      <div id="quality-factor-breakdown" style="display:grid;gap:4px;font-size:11px;"></div>
    </div>

    <div class="history-empty" id="history-empty" style="display: none;">
      <p>No historical data available.</p>
      <button class="import-btn" id="import-historical-btn">Import Historical Data</button>
      <p class="hint">Imports finished Claude Code, Codex, and OpenCode sessions</p>
    </div>

    <div class="history-loading" id="history-loading" style="display: none;">
      <div style="padding: 12px 0;">
        <div class="sk-skeleton sk-skeleton-card" style="width: 100%; height: 120px; margin-bottom: 12px;"></div>
        <div style="display: flex; gap: 8px;">
          <div class="sk-skeleton sk-skeleton-card" style="flex: 1; height: 60px;"></div>
          <div class="sk-skeleton sk-skeleton-card" style="flex: 1; height: 60px;"></div>
        </div>
      </div>
    </div>
  </div>

  <div id="health-tab" class="tab-content" role="tabpanel" aria-label="Health">
    <div class="health-header">
      <div class="section-title">Health</div>
      <button class="range-btn" id="health-refresh" title="Run the checks again">Refresh</button>
    </div>
    <div id="health-loading" class="history-loading" style="display: none;">
      <div class="sk-skeleton sk-skeleton-card" style="width: 100%; height: 48px; margin: 8px 0;"></div>
    </div>
    <div id="health-banner"></div>
    <div class="section">
      <div class="section-title">Checks</div>
      <div id="health-checks"></div>
    </div>
    <div class="section">
      <div class="section-title">Session Providers</div>
      <div id="health-diagnostics" class="health-empty">Open this tab to probe the session providers.</div>
    </div>
    <div class="section">
      <div class="section-title">Failing Tools <span class="section-hint">last 7 and 30 days</span></div>
      <div id="health-tools"></div>
    </div>
  </div>

  <!-- Changelog Modal -->
  <div id="changelog-backdrop" class="changelog-backdrop" style="display: none;">
    <div class="changelog-modal">
      <div class="changelog-header">
        <span class="changelog-title">What's New</span>
        <span class="changelog-close" id="changelog-close" role="button" aria-label="Close changelog">&times;</span>
      </div>
      <div class="changelog-version-info">
        <span class="changelog-current-version">v${options.extVersion}</span>
        <span class="changelog-date">${options.extDate}</span>
      </div>
      <div class="changelog-body" id="changelog-body"></div>
      <div class="changelog-footer">
        <a class="changelog-link" href="https://cesarandreslopez.github.io/sidekick-agent-hub/changelog/" id="changelog-full-link">View full changelog &#8594;</a>
      </div>
    </div>
  </div>

  <script nonce="${options.nonce}" src="${options.chartjsUri}"></script>
  <script type="application/json" id="${DASHBOARD_INIT_ELEMENT_ID}">${options.initJson}</script>
  <script nonce="${options.nonce}" src="${options.scriptUri}"></script>
</body>
</html>`;
}
