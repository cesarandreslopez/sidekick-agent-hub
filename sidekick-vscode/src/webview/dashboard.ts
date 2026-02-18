/**
 * Dashboard Webview - Browser Entry Point
 *
 * Implements the session analytics dashboard UI with:
 * - Token usage cards (input, output, cache write, cache read)
 * - Context window gauge using Chart.js
 * - Burn rate and session timer
 * - Model breakdown table
 *
 * @module webview/dashboard
 */

// VS Code API types
declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
};

// Chart.js loaded from CDN
declare const Chart: {
  new (ctx: CanvasRenderingContext2D, config: ChartConfig): ChartInstance;
};

interface ChartConfig {
  type: string;
  data: {
    datasets: Array<{
      data: number[];
      backgroundColor: string[];
      borderWidth: number;
    }>;
  };
  options: {
    responsive: boolean;
    maintainAspectRatio: boolean;
    circumference: number;
    rotation: number;
    cutout: string;
    plugins: {
      legend: { display: boolean };
      tooltip: { enabled: boolean };
    };
  };
}

interface ChartInstance {
  data: {
    datasets: Array<{
      data: number[];
      backgroundColor: string[];
    }>;
  };
  update(mode?: string): void;
  destroy(): void;
}

/**
 * Model breakdown entry from extension.
 */
interface ModelBreakdownEntry {
  model: string;
  calls: number;
  tokens: number;
  cost: number;
}

/**
 * Latency display data from extension.
 */
interface LatencyDisplay {
  avgFirstToken: string;
  maxFirstToken: string;
  lastFirstToken: string;
  avgTotal: string;
  cycleCount: number;
  hasData: boolean;
}

/**
 * CLAUDE.md suggestion from extension.
 */
interface ClaudeMdSuggestion {
  title: string;
  observed: string;
  suggestion: string;
  reasoning: string;
}

/**
 * Dashboard state received from extension.
 */
interface DashboardState {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheWriteTokens: number;
  totalCacheReadTokens: number;
  totalCost: number;
  contextUsagePercent: number;
  modelBreakdown: ModelBreakdownEntry[];
  sessionActive: boolean;
  lastUpdated: string;
}

// Acquire VS Code API (call once, cache result)
const vscode = acquireVsCodeApi();

// Context gauge chart instance
let contextChart: ChartInstance | null = null;

// Session timer state
let sessionStartTime: Date | null = null;
let sessionTimerInterval: number | null = null;

// CLAUDE.md suggestions state
let currentSuggestions: ClaudeMdSuggestion[] = [];

// Color thresholds for context gauge
const GAUGE_COLORS = {
  green: 'rgb(75, 192, 192)',
  orange: 'rgb(255, 159, 64)',
  red: 'rgb(255, 99, 132)',
  background: 'rgba(100, 100, 100, 0.2)'
};

/**
 * Formats a number with thousands separators.
 * @param num - Number to format
 * @returns Formatted string (e.g., "12,345")
 */
function formatTokenCount(num: number): string {
  return num.toLocaleString();
}

/**
 * Formats cost with appropriate precision.
 * Uses 4 decimals for < $0.01, 2 decimals otherwise.
 * @param cost - Cost in USD
 * @returns Formatted cost string
 */
function formatCost(cost: number): string {
  if (cost < 0.01) {
    return '$' + cost.toFixed(4);
  }
  return '$' + cost.toFixed(2);
}

/**
 * Formats time remaining as "Xh Ym" or "Ym".
 * @param minutes - Minutes remaining
 * @returns Formatted time string
 */
function formatTimeRemaining(minutes: number): string {
  if (minutes < 0) return '0m';
  const hours = Math.floor(minutes / 60);
  const mins = Math.floor(minutes % 60);
  if (hours > 0) {
    return hours + 'h ' + mins + 'm';
  }
  return mins + 'm';
}

/**
 * Extracts short model name from full ID.
 * @param modelId - Full model ID (e.g., "claude-opus-4-20250514")
 * @returns Short name (e.g., "Opus 4")
 */
function getShortModelName(modelId: string): string {
  const match = modelId.match(/claude-(haiku|sonnet|opus)-([0-9.]+)/i);
  if (match) {
    return match[1].charAt(0).toUpperCase() + match[1].slice(1) + ' ' + match[2];
  }
  return modelId;
}

/**
 * Gets the appropriate color for context gauge based on percentage.
 * @param percent - Context usage percentage (0-100)
 * @returns CSS color string
 */
function getGaugeColor(percent: number): string {
  if (percent >= 95) {
    return GAUGE_COLORS.red;
  }
  if (percent >= 80) {
    return GAUGE_COLORS.orange;
  }
  return GAUGE_COLORS.green;
}

/**
 * Initializes the Chart.js context gauge.
 */
function initContextGauge(): void {
  const canvas = document.getElementById('contextChart') as HTMLCanvasElement;
  if (!canvas) return;

  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  contextChart = new Chart(ctx, {
    type: 'doughnut',
    data: {
      datasets: [{
        data: [0, 100],
        backgroundColor: [GAUGE_COLORS.green, GAUGE_COLORS.background],
        borderWidth: 0
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      circumference: 180,
      rotation: 270,
      cutout: '70%',
      plugins: {
        legend: { display: false },
        tooltip: { enabled: false }
      }
    }
  });
}

/**
 * Updates the context gauge with new percentage.
 * Uses chart.update() instead of destroy/recreate for performance.
 * @param percent - Context usage percentage (0-100)
 */
function updateContextGauge(percent: number): void {
  if (!contextChart) {
    initContextGauge();
  }

  if (contextChart) {
    const clampedPercent = Math.min(100, Math.max(0, percent));
    contextChart.data.datasets[0].data = [clampedPercent, 100 - clampedPercent];
    contextChart.data.datasets[0].backgroundColor = [
      getGaugeColor(clampedPercent),
      GAUGE_COLORS.background
    ];
    contextChart.update('none');
  }

  // Update percentage text
  const percentEl = document.getElementById('context-percent');
  if (percentEl) {
    percentEl.textContent = Math.round(percent) + '%';
  }
}

/**
 * Updates token cards with current values.
 * @param state - Dashboard state
 */
function updateTokenCards(state: DashboardState): void {
  const inputEl = document.querySelector('#input-tokens .value');
  const outputEl = document.querySelector('#output-tokens .value');
  const cacheWriteEl = document.querySelector('#cache-write-tokens .value');
  const cacheReadEl = document.querySelector('#cache-read-tokens .value');

  if (inputEl) inputEl.textContent = formatTokenCount(state.totalInputTokens);
  if (outputEl) outputEl.textContent = formatTokenCount(state.totalOutputTokens);
  if (cacheWriteEl) cacheWriteEl.textContent = formatTokenCount(state.totalCacheWriteTokens);
  if (cacheReadEl) cacheReadEl.textContent = formatTokenCount(state.totalCacheReadTokens);
}

/**
 * Updates cost display.
 * @param state - Dashboard state
 */
function updateCostDisplay(state: DashboardState): void {
  const totalCostEl = document.getElementById('total-cost');
  if (totalCostEl) {
    totalCostEl.textContent = formatCost(state.totalCost);
  }
}

/**
 * Updates burn rate display.
 * @param burnRate - Tokens per minute
 */
function updateBurnRateDisplay(burnRate: number): void {
  const burnRateEl = document.getElementById('burn-rate');
  if (burnRateEl) {
    burnRateEl.textContent = Math.round(burnRate).toLocaleString();
  }
}

/**
 * Updates the session timer display.
 * Shows how long the session has been running.
 */
function updateSessionTimer(): void {
  const sessionTimerEl = document.getElementById('session-timer');
  if (!sessionTimerEl) return;

  if (!sessionStartTime) {
    sessionTimerEl.textContent = '0m';
    return;
  }

  const now = new Date();
  const msElapsed = now.getTime() - sessionStartTime.getTime();
  const minutesElapsed = msElapsed / 60000;

  sessionTimerEl.textContent = formatTimeRemaining(minutesElapsed);
}

/**
 * Starts the session timer interval (updates every second).
 */
function startSessionTimer(): void {
  if (sessionTimerInterval !== null) {
    clearInterval(sessionTimerInterval);
  }
  sessionTimerInterval = window.setInterval(updateSessionTimer, 1000);
}

/**
 * Stops the session timer interval.
 */
function stopSessionTimer(): void {
  if (sessionTimerInterval !== null) {
    clearInterval(sessionTimerInterval);
    sessionTimerInterval = null;
  }
}

/**
 * Updates model breakdown table.
 * @param state - Dashboard state
 */
function updateModelBreakdown(state: DashboardState): void {
  const tbody = document.querySelector('#model-table tbody');
  if (!tbody) return;

  tbody.innerHTML = '';

  if (state.modelBreakdown.length === 0) {
    const row = document.createElement('tr');
    row.innerHTML = '<td colspan="4" class="empty-row">No models used yet</td>';
    tbody.appendChild(row);
    return;
  }

  // Sort by tokens descending
  const sorted = [...state.modelBreakdown].sort((a, b) => b.tokens - a.tokens);

  sorted.forEach(model => {
    const row = document.createElement('tr');
    row.innerHTML = `
      <td class="model-name">${getShortModelName(model.model)}</td>
      <td class="model-calls">${model.calls}</td>
      <td class="model-tokens">${formatTokenCount(model.tokens)}</td>
      <td class="model-cost">${formatCost(model.cost)}</td>
    `;
    tbody.appendChild(row);
  });
}

/**
 * Updates session status indicator.
 * @param active - Whether session is active
 */
function updateSessionStatus(active: boolean): void {
  const indicator = document.querySelector('.status-indicator');
  const text = document.querySelector('.status-text');

  if (indicator) {
    if (active) {
      indicator.classList.add('active');
    } else {
      indicator.classList.remove('active');
    }
  }

  if (text) {
    text.textContent = active ? 'Session active' : 'No active session';
  }
}

/**
 * Shows session active state and starts session timer.
 */
function showSessionActive(): void {
  updateSessionStatus(true);
  startSessionTimer();
}

/**
 * Shows session inactive state and stops session timer.
 */
function showSessionInactive(): void {
  updateSessionStatus(false);
  stopSessionTimer();
}

/**
 * Updates last updated timestamp.
 * @param isoTimestamp - ISO 8601 timestamp
 */
function updateLastUpdated(isoTimestamp: string): void {
  const el = document.getElementById('last-updated');
  if (el) {
    const date = new Date(isoTimestamp);
    el.textContent = date.toLocaleTimeString();
  }
}

/**
 * Updates latency display elements.
 * @param latency - Latency display data from extension
 */
function updateLatencyDisplay(latency: LatencyDisplay): void {
  const section = document.getElementById('latency-section');
  if (section) {
    section.style.display = latency.hasData ? 'block' : 'none';
  }

  const lastEl = document.getElementById('latency-last');
  if (lastEl) lastEl.textContent = latency.lastFirstToken;

  const avgEl = document.getElementById('latency-avg');
  if (avgEl) avgEl.textContent = latency.avgFirstToken;

  const maxEl = document.getElementById('latency-max');
  if (maxEl) maxEl.textContent = latency.maxFirstToken;

  const totalAvgEl = document.getElementById('latency-total-avg');
  if (totalAvgEl) totalAvgEl.textContent = latency.avgTotal;

  const countEl = document.getElementById('latency-count');
  if (countEl) countEl.textContent = String(latency.cycleCount);
}

/**
 * Shows/hides empty state vs dashboard content.
 * @param state - Dashboard state
 */
function updateVisibility(state: DashboardState): void {
  const emptyState = document.getElementById('empty-state');
  const dashboardContent = document.getElementById('dashboard-content');

  const hasData = state.sessionActive || state.totalInputTokens > 0;

  if (emptyState) {
    emptyState.style.display = hasData ? 'none' : 'block';
  }
  if (dashboardContent) {
    dashboardContent.style.display = hasData ? 'block' : 'none';
  }
}

/**
 * Updates all dashboard displays with new state.
 * @param state - Dashboard state from extension
 */
function updateDisplay(state: DashboardState): void {
  updateVisibility(state);
  updateSessionStatus(state.sessionActive);
  updateTokenCards(state);
  updateCostDisplay(state);
  updateContextGauge(state.contextUsagePercent);
  updateModelBreakdown(state);
  updateLastUpdated(state.lastUpdated);
}

// ============================================================================
// CLAUDE.md Suggestions UI
// ============================================================================

/**
 * Escapes HTML special characters to prevent XSS.
 */
function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

/**
 * Requests session analysis from the extension.
 */
function requestAnalysis(): void {
  vscode.postMessage({ type: 'analyzeSession' });
}

/**
 * Copies a suggestion to clipboard.
 * @param index - Index of suggestion in currentSuggestions array
 */
function copySuggestion(index: number): void {
  if (index >= 0 && index < currentSuggestions.length) {
    vscode.postMessage({
      type: 'copySuggestion',
      text: currentSuggestions[index].suggestion
    });
  }
}

/**
 * Opens the project's instruction file (CLAUDE.md or AGENTS.md).
 */
function openInstructionFile(): void {
  vscode.postMessage({ type: 'openInstructionFile' });
}

/**
 * @deprecated Use openInstructionFile instead.
 */
function openClaudeMd(): void {
  openInstructionFile();
}

/**
 * Sets loading state for suggestions panel.
 */
function setSuggestionsLoading(loading: boolean): void {
  const panel = document.getElementById('suggestions-panel');
  const analyzeBtn = document.getElementById('analyze-btn') as HTMLButtonElement | null;

  if (analyzeBtn) {
    analyzeBtn.disabled = loading;
    analyzeBtn.textContent = loading ? 'Analyzing...' : 'Analyze Session';
  }

  if (panel && loading) {
    const content = panel.querySelector('.suggestions-content');
    if (content) {
      content.innerHTML = '<div class="suggestions-loading">Analyzing session data...</div>';
    }
  }
}

/**
 * Shows an error message in the suggestions panel.
 */
function showSuggestionsError(error: string): void {
  const panel = document.getElementById('suggestions-panel');
  if (!panel) return;

  const content = panel.querySelector('.suggestions-content');
  if (content) {
    content.innerHTML = `<div class="suggestions-error">${escapeHtml(error)}</div>`;
  }
}

/**
 * Renders suggestions in the panel.
 */
function renderSuggestions(suggestions: ClaudeMdSuggestion[]): void {
  currentSuggestions = suggestions;
  const panel = document.getElementById('suggestions-panel');
  if (!panel) return;

  const content = panel.querySelector('.suggestions-content');
  if (!content) return;

  if (suggestions.length === 0) {
    content.innerHTML = '<div class="suggestions-empty">No suggestions generated. Try using Claude Code more before analyzing.</div>';
    return;
  }

  const html = suggestions.map((s, i) => `
    <div class="suggestion-card">
      <div class="suggestion-header">${i + 1}. ${escapeHtml(s.title)}</div>
      <div class="suggestion-observed">
        <span class="label">Observed:</span> ${escapeHtml(s.observed)}
      </div>
      <pre class="suggestion-code">${escapeHtml(s.suggestion)}</pre>
      <div class="suggestion-why">
        <span class="label">Why:</span> ${escapeHtml(s.reasoning)}
      </div>
      <div class="suggestion-actions">
        <button class="copy-btn" onclick="copySuggestion(${i})">Copy</button>
      </div>
    </div>
  `).join('');

  content.innerHTML = html + `
    <div class="suggestions-footer">
      <button class="open-claude-md-btn" onclick="openInstructionFile()">Open Instruction File</button>
    </div>
  `;
}

// Expose functions to window for onclick handlers
(window as unknown as Record<string, unknown>).copySuggestion = copySuggestion;
(window as unknown as Record<string, unknown>).openClaudeMd = openClaudeMd;
(window as unknown as Record<string, unknown>).openInstructionFile = openInstructionFile;
(window as unknown as Record<string, unknown>).requestAnalysis = requestAnalysis;

/**
 * Handles messages from the extension.
 */
function handleMessage(event: MessageEvent): void {
  const message = event.data;

  switch (message.type) {
    case 'updateStats':
      updateDisplay(message.state);
      break;
    case 'updateBurnRate':
      sessionStartTime = message.sessionStartTime ? new Date(message.sessionStartTime) : null;
      updateBurnRateDisplay(message.burnRate);
      updateSessionTimer();
      // Start session timer if not already running
      if (sessionStartTime && sessionTimerInterval === null) {
        startSessionTimer();
      }
      break;
    case 'sessionStart':
      showSessionActive();
      break;
    case 'sessionEnd':
      showSessionInactive();
      break;
    case 'updateLatency':
      updateLatencyDisplay(message.latency);
      break;
    case 'showSuggestions':
      renderSuggestions(message.suggestions);
      break;
    case 'suggestionsLoading':
      setSuggestionsLoading(message.loading);
      break;
    case 'suggestionsError':
      showSuggestionsError(message.error);
      break;
  }
}

/**
 * Initializes the dashboard on DOM ready.
 */
function initialize(): void {
  // Initialize Chart.js gauge
  initContextGauge();

  // Listen for messages from extension
  window.addEventListener('message', handleMessage);

  // Signal to extension that webview is ready
  vscode.postMessage({ type: 'webviewReady' });
}

// Initialize when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initialize);
} else {
  initialize();
}
