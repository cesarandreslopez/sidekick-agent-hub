/* eslint-disable */
// @ts-nocheck
/**
 * The dashboard webview script, moved verbatim out of the inline template in
 * DashboardViewProvider (September 2026). It is deliberately untyped and
 * unlinted: typing it is scheduled work, and reformatting it here would hide
 * the mechanical move behind thousands of changed lines. New webview code
 * belongs in typed modules beside this file, not in here.
 *
 * Runtime globals: acquireVsCodeApi (VS Code) and Chart (chartjs-vendor.js,
 * loaded before this bundle).
 */
import type { DashboardInit } from '../../types/dashboard';
import type { LegacyHelpers } from './helpers';

/**
 * `helpers` are the typed modules this script delegates to (see index.ts);
 * the History tab's chart data, tiles, and request payloads come from
 * helpers.history.
 */
export function startLegacyDashboard(dashboardInit: DashboardInit, helpers: LegacyHelpers): void {
  window.__initialSessionData = dashboardInit.session;
    (function() {
      const vscode = acquireVsCodeApi();

      // Catch uncaught errors
      window.onerror = function(msg, url, line) {
        const el = document.getElementById('session-list');
        // Diagnostics belong in the log, not narrated into the session list.
        vscode.postMessage({ type: 'webviewError', message: String(msg), line: line });
      };

      // DOM elements
      const statusEl = document.getElementById('status');
      const contentEl = document.getElementById('content');
      const dashboardEl = document.getElementById('dashboard');
      const inputTokensEl = document.getElementById('input-tokens');
      const outputTokensEl = document.getElementById('output-tokens');
      const cacheWriteTokensEl = document.getElementById('cache-write-tokens');
      const cacheReadTokensEl = document.getElementById('cache-read-tokens');
      const contextPercentEl = document.getElementById('context-percent');
      const modelListEl = document.getElementById('model-list');
      const lastUpdatedEl = document.getElementById('last-updated');
      const sessionListEl = document.getElementById('session-list');
      const pinSessionBtn = document.getElementById('pin-session');
      const refreshSessionsBtn = document.getElementById('refresh-sessions');
      const browseFoldersBtn = document.getElementById('browse-folders');
      const openCliDashboardBtn = document.getElementById('open-cli-dashboard');
      const sessionProviderSelect = document.getElementById('session-provider-select');
      const customPathIndicator = document.getElementById('custom-path-indicator');
      const customPathText = document.getElementById('custom-path-text');
      const resetCustomPath = document.getElementById('reset-custom-path');
      const emptyStateTitle = document.getElementById('empty-state-title');
      const emptyStateHint = document.getElementById('empty-state-hint');

      // Tab elements
      const tabBtns = document.querySelectorAll('.tab-btn');
      const tabContents = document.querySelectorAll('.tab-content');

      // Metric toggle elements
      const metricBtns = document.querySelectorAll('.metric-btn');
      const primaryMetricDisplay = document.getElementById('primary-metric-display');
      const primaryMetricValue = document.getElementById('primary-metric-value');
      const primaryMetricSubtitle = document.getElementById('primary-metric-subtitle');
      const gaugeRow = document.getElementById('gauge-row');

      // Group section toggle elements
      const groupToggles = document.querySelectorAll('[data-group-toggle]');

      // Inline stats elements
      const inlineDuration = document.getElementById('inline-duration');
      const inlineBurnRate = document.getElementById('inline-burn-rate');
      const inlineApiCalls = document.getElementById('inline-api-calls');

      // History tab elements
      const rangeBtns = document.querySelectorAll('.range-btn');
      const historyMetricSelect = document.getElementById('history-metric-select');
      const drillBreadcrumb = document.getElementById('drill-breadcrumb');
      const drillUpBtn = document.getElementById('drill-up');
      const drillLabel = document.getElementById('drill-label');
      const historyEmpty = document.getElementById('history-empty');
      const historyLoading = document.getElementById('history-loading');
      const historySummary = document.getElementById('history-summary');

      // Current state
      let currentMetric = 'quota';
      let currentRange = 'week';
      let currentHistoryData = null;

      helpers.history.mount({
        getRange: function() { return currentRange; },
        getMetric: function() { return historyMetricSelect ? historyMetricSelect.value : 'tokens'; },
        post: function(message) { vscode.postMessage(message); },
        formatNumber: function(value) { return formatNumber(value); },
        formatCost: function(value) { return formatCost(value); },
        cssVar: function(name, fallback) { return cssVar(name, fallback); }
      });
      let sessionState = {
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCacheWriteTokens: 0,
        totalCacheReadTokens: 0,
        totalCost: 0,
        messageCount: 0,
        burnRate: 0,
        sessionDuration: '0m'
      };

      let currentProviderId = 'claude-code';
      let currentProviderName = 'Claude Code';
      let currentQuota = null;
      let currentQuotaFailure = null;
      let quotaToastTimer = null;

      // Provider-aware instruction file targeting
      let targetFileName = 'CLAUDE.md';
      let targetFileTip = 'After adding suggestions to your CLAUDE.md, run /init in Claude Code to consolidate and optimize the file.';
      let targetDocsUrl = 'https://docs.anthropic.com/en/docs/claude-code/memory#claudemd';

      // Suggestions state
      let currentSuggestions = [];
      let suggestionsLoading = false;

      // ==== CLAUDE.md Suggestions Functions ====

      function escapeHtml(str) {
        if (!str) return '';
        return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
      }

      // ==== Changelog Modal ====

      const changelogData = dashboardInit.changelog;

      function renderChangelog(entries) {
        const body = document.getElementById('changelog-body');
        if (!body || !entries.length) return;
        body.innerHTML = entries.map(function(entry, i) {
          const isFirst = i === 0;
          const sections = entry.sections.map(function(s) {
            const items = s.items.map(function(item) {
              return '<div class="changelog-entry-item">' + escapeHtml(item) + '</div>';
            }).join('');
            return '<div class="changelog-entry-section"><div class="changelog-entry-heading">' + escapeHtml(s.heading) + '</div>' + items + '</div>';
          }).join('');
          return '<div class="changelog-entry">' +
            (isFirst ? '' : '<div class="changelog-entry-version">v' + escapeHtml(entry.version) + ' — ' + escapeHtml(entry.date) + '</div>') +
            sections + '</div>';
        }).join('');
      }

      const versionBadge = document.getElementById('version-badge');
      const changelogBackdrop = document.getElementById('changelog-backdrop');
      const changelogClose = document.getElementById('changelog-close');
      const changelogFullLink = document.getElementById('changelog-full-link');

      if (versionBadge) {
        versionBadge.addEventListener('click', function() {
          renderChangelog(changelogData);
          if (changelogBackdrop) changelogBackdrop.style.display = 'flex';
        });
      }

      if (changelogClose) {
        changelogClose.addEventListener('click', function() {
          if (changelogBackdrop) changelogBackdrop.style.display = 'none';
        });
      }

      if (changelogBackdrop) {
        changelogBackdrop.addEventListener('click', function(e) {
          if (e.target === changelogBackdrop) changelogBackdrop.style.display = 'none';
        });
      }

      if (changelogFullLink) {
        changelogFullLink.addEventListener('click', function(e) {
          e.preventDefault();
          vscode.postMessage({ type: 'openExternal', url: this.href });
        });
      }

      function setSuggestionsLoading(loading) {
        suggestionsLoading = loading;
        const panel = document.getElementById('suggestions-panel');
        const analyzeBtn = document.getElementById('analyze-btn');

        if (analyzeBtn) {
          analyzeBtn.disabled = loading;
          analyzeBtn.textContent = loading ? 'Analyzing...' : 'Get Suggestions';
        }

        if (panel && loading) {
          const content = panel.querySelector('.suggestions-content');
          if (content) {
            content.innerHTML = '<div class="suggestions-loading" style="padding: 8px 0;"><div class="sk-skeleton sk-skeleton-line" style="width: 85%;"></div><div class="sk-skeleton sk-skeleton-line" style="width: 70%;"></div><div class="sk-skeleton sk-skeleton-line" style="width: 55%;"></div></div>';
          }
        }
      }

      function showSuggestionsError(error) {
        const panel = document.getElementById('suggestions-panel');
        if (!panel) return;

        const content = panel.querySelector('.suggestions-content');
        if (content) {
          content.innerHTML = '<div class="suggestions-error">' + escapeHtml(error) + '</div>';
        }
      }

      function renderSuggestions(suggestions) {
        currentSuggestions = suggestions;
        const panel = document.getElementById('suggestions-panel');
        if (!panel) return;

        const content = panel.querySelector('.suggestions-content');
        if (!content) return;

        if (suggestions.length === 0) {
          content.innerHTML = '<div class="suggestions-empty">No suggestions generated. Try using Claude Code more before analyzing.</div>';
          return;
        }

        // Handle single consolidated suggestion (new format) or multiple suggestions (old format)
        let html;
        if (suggestions.length === 1 && suggestions[0].title === 'Recommended Addition') {
          // New consolidated format - single card with summary, code block, and rationale
          const s = suggestions[0];
          const rationaleItems = s.reasoning.split(' | ').filter(function(item) { return item.trim(); });
          const rationaleHtml = rationaleItems.length > 0
            ? '<ul class="suggestion-rationale-list">' +
                rationaleItems.map(function(item) {
                  return '<li>' + escapeHtml(item) + '</li>';
                }).join('') +
              '</ul>'
            : '<p>' + escapeHtml(s.reasoning) + '</p>';

          html = '<div class="suggestion-card suggestion-card-consolidated">' +
            '<div class="suggestion-header">' + escapeHtml(s.title) + '</div>' +
            '<div class="suggestion-summary"><span class="label">Summary:</span> ' + escapeHtml(s.observed) + '</div>' +
            '<div class="suggestion-code-header">Append this to ' + targetFileName + ':</div>' +
            '<pre class="suggestion-code">' + escapeHtml(s.suggestion) + '</pre>' +
            '<div class="suggestion-actions">' +
              '<button class="copy-btn" data-index="0">Copy to Clipboard</button>' +
            '</div>' +
            '<div class="suggestion-rationale">' +
              '<div class="label">Rationale:</div>' +
              rationaleHtml +
            '</div>' +
          '</div>';
        } else {
          // Legacy multi-suggestion format
          html = suggestions.map(function(s, i) {
            return '<div class="suggestion-card">' +
              '<div class="suggestion-header">' + (i + 1) + '. ' + escapeHtml(s.title) + '</div>' +
              '<div class="suggestion-observed"><span class="label">Observed:</span> ' + escapeHtml(s.observed) + '</div>' +
              '<pre class="suggestion-code">' + escapeHtml(s.suggestion) + '</pre>' +
              '<div class="suggestion-why"><span class="label">Why:</span> ' + escapeHtml(s.reasoning) + '</div>' +
              '<div class="suggestion-actions">' +
                '<button class="copy-btn" data-index="' + i + '">Copy</button>' +
              '</div>' +
            '</div>';
          }).join('');
        }

        content.innerHTML = html +
          '<div class="suggestions-footer">' +
            '<button class="open-claude-md-btn">Open ' + targetFileName + '</button>' +
          '</div>' +
          '<div class="suggestions-tip">' +
            '<strong>💡 Tip:</strong> ' + escapeHtml(targetFileTip) +
          '</div>';

        // Attach event listeners (CSP blocks inline onclick)
        content.querySelectorAll('.copy-btn').forEach(function(btn) {
          btn.addEventListener('click', function() {
            const index = parseInt(btn.getAttribute('data-index'), 10);
            if (index >= 0 && index < currentSuggestions.length) {
              vscode.postMessage({
                type: 'copySuggestion',
                text: currentSuggestions[index].suggestion
              });
            }
          });
        });

        const openBtn = content.querySelector('.open-claude-md-btn');
        if (openBtn) {
          openBtn.addEventListener('click', function() {
            vscode.postMessage({ type: 'openInstructionFile' });
          });
        }
      }

      // ==== End Suggestions Functions ====

      // Tab switching
      tabBtns.forEach(function(btn) {
        btn.addEventListener('click', function() {
          const tab = btn.getAttribute('data-tab');

          tabBtns.forEach(function(b) { b.classList.remove('active'); b.setAttribute('aria-selected', 'false'); });
          tabContents.forEach(function(c) { c.classList.remove('active'); });

          btn.classList.add('active');
          btn.setAttribute('aria-selected', 'true');
          document.getElementById(tab + '-tab').classList.add('active');

          // Request data when switching tabs
          if (tab === 'history') {
            vscode.postMessage(helpers.history.request(currentRange, 'tokens'));
          } else if (tab === 'summary') {
            vscode.postMessage({ type: 'requestSessionSummary' });
          } else if (tab === 'health') {
            vscode.postMessage({ type: 'requestHealth' });
          }
        });
      });

      helpers.health.mount({ post: function(message) { vscode.postMessage(message); } });

      // Metric toggle switching
      metricBtns.forEach(function(btn) {
        btn.addEventListener('click', function() {
          currentMetric = btn.getAttribute('data-metric');
          metricBtns.forEach(function(b) { b.classList.remove('active'); b.setAttribute('aria-pressed', 'false'); });
          btn.classList.add('active');
          btn.setAttribute('aria-pressed', 'true');
          updatePrimaryMetric();
        });
      });

      // Group section toggles
      groupToggles.forEach(function(toggle) {
        toggle.addEventListener('click', function() {
          const sectionId = toggle.getAttribute('data-group-toggle');
          const section = document.getElementById(sectionId);
          if (section) {
            section.classList.toggle('expanded');
          }
        });
      });

      // History range buttons
      rangeBtns.forEach(function(btn) {
        btn.addEventListener('click', function() {
          currentRange = btn.getAttribute('data-range');
          rangeBtns.forEach(function(b) { b.classList.remove('active'); b.setAttribute('aria-pressed', 'false'); });
          btn.classList.add('active');
          btn.setAttribute('aria-pressed', 'true');
          vscode.postMessage(helpers.history.request(currentRange, historyMetricSelect.value));
        });
      });

      // History metric selector
      if (historyMetricSelect) {
        historyMetricSelect.addEventListener('change', function() {
          if (currentHistoryData) {
            updateHistoryChart(currentHistoryData);
          }
        });
      }

      // Drill up button
      if (drillUpBtn) {
        drillUpBtn.addEventListener('click', function() {
          vscode.postMessage({ type: 'drillUp' });
        });
      }

      /**
       * Updates the primary metric display based on selected metric.
       */
      function updatePrimaryMetric() {
        if (!primaryMetricDisplay || !primaryMetricValue || !primaryMetricSubtitle || !gaugeRow) return;

        // Toggle between gauge view and numeric metric view
        if (currentMetric === 'quota') {
          gaugeRow.style.display = 'flex';
          primaryMetricDisplay.style.display = 'none';
        } else {
          gaugeRow.style.display = 'none';
          primaryMetricDisplay.style.display = 'block';
          primaryMetricDisplay.setAttribute('data-metric', currentMetric);

          switch (currentMetric) {
            case 'cost':
              primaryMetricValue.textContent = formatCost(sessionState.totalCost);
              primaryMetricSubtitle.textContent = 'Estimated session cost';
              break;
            case 'tokens':
              // Shared vocabulary (summarizeTokens().total): every billed bucket, cache included.
              const totalTokens = sessionState.totalInputTokens + sessionState.totalOutputTokens + (sessionState.totalCacheWriteTokens || 0) + (sessionState.totalCacheReadTokens || 0);
              primaryMetricValue.textContent = formatNumber(totalTokens);
              primaryMetricSubtitle.textContent = formatNumber(sessionState.totalInputTokens) + ' in / ' + formatNumber(sessionState.totalOutputTokens) + ' out / ' + formatNumber((sessionState.totalCacheWriteTokens || 0) + (sessionState.totalCacheReadTokens || 0)) + ' cache';
              break;
            case 'cache':
              const totalCache = sessionState.totalCacheWriteTokens + sessionState.totalCacheReadTokens;
              primaryMetricValue.textContent = formatNumber(totalCache);
              primaryMetricSubtitle.textContent = formatNumber(sessionState.totalCacheWriteTokens) + ' write / ' + formatNumber(sessionState.totalCacheReadTokens) + ' read';
              break;
          }
        }
      }

      /**
       * Updates inline stats display.
       */
      function updateInlineStats() {
        if (inlineDuration) inlineDuration.textContent = sessionState.sessionDuration;
        if (inlineBurnRate) inlineBurnRate.textContent = formatNumber(sessionState.burnRate);
        if (inlineApiCalls) inlineApiCalls.textContent = formatNumber(sessionState.messageCount);
      }

      // History chart
      let historyChart = null;

      /**
       * Initializes the history bar chart.
       */
      function initHistoryChart() {
        const canvas = document.getElementById('historyChart');
        if (!canvas || !window.Chart) return;

        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        historyChart = new Chart(ctx, {
          type: 'bar',
          data: {
            labels: [],
            datasets: [{
              label: 'Tokens',
              data: [],
              backgroundColor: 'rgba(75, 192, 192, 0.7)',
              borderColor: 'rgb(75, 192, 192)',
              borderWidth: 1
            }]
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            onClick: function(event, elements) {
              if (elements.length > 0 && currentHistoryData) {
                const index = elements[0].index;
                const dataPoint = currentHistoryData.dataPoints[index];
                if (dataPoint && (currentRange === 'all' || currentRange === 'month' || currentRange === 'week')) {
                  vscode.postMessage({
                    type: 'drillDown',
                    timestamp: dataPoint.timestamp,
                    currentRange: currentRange
                  });
                }
              }
            },
            plugins: {
              legend: { display: false },
              tooltip: {
                callbacks: {
                  label: function(context) {
                    const metric = historyMetricSelect ? historyMetricSelect.value : 'tokens';
                    if (metric === 'cost') {
                      return formatCost(context.raw);
                    }
                    return formatNumber(context.raw);
                  }
                }
              }
            },
            scales: {
              y: {
                beginAtZero: true,
                ticks: {
                  callback: function(value) {
                    const metric = historyMetricSelect ? historyMetricSelect.value : 'tokens';
                    if (metric === 'cost') {
                      return formatCost(value);
                    }
                    return formatNumber(value);
                  }
                }
              }
            }
          }
        });
      }

      /**
       * Updates the history chart with new data.
       */
      function updateHistoryChart(data) {
        currentHistoryData = data;

        if (!historyChart) {
          initHistoryChart();
        }
        if (!historyChart) return;

        const metric = helpers.history.effectiveMetric(data, historyMetricSelect ? historyMetricSelect.value : 'tokens');
        helpers.history.applyToChart(historyChart, data, metric);
        helpers.history.applyTiles(data, metric);

        const qualitySection = document.getElementById('quality-trend-section');
        const qualitySummary = document.getElementById('quality-trend-summary');
        const qualityFactors = document.getElementById('quality-factor-breakdown');
        if (qualitySection && data.qualityTrend && data.latestQuality) {
          qualitySection.style.display = 'block';
          const trend = data.qualityTrend;
          const delta = trend.delta == null ? 'not enough prior data' : ((trend.delta >= 0 ? '+' : '') + trend.delta.toFixed(1) + ' week over week');
          qualitySummary.textContent = 'Latest: ' + data.latestQuality.score + '/100 · ' + delta;
          qualityFactors.innerHTML = data.latestQuality.factors.map(function(factor) {
            return '<div title="' + escapeHtml(factor.detail) + '"><strong>' + escapeHtml(factor.label) + ':</strong> ' + factor.contribution + '/' + factor.maximum + '</div>';
          }).join('');
        } else if (qualitySection) {
          qualitySection.style.display = 'none';
        }

        // Show/hide empty state
        if (historyEmpty) {
          historyEmpty.style.display = data.dataPoints.length === 0 ? 'block' : 'none';
        }
        if (historySummary) {
          historySummary.style.display = data.dataPoints.length === 0 ? 'none' : 'grid';
        }
      }

      // Context gauge chart
      let contextChart = null;
      var GAUGE_COLORS = {
        green: 'rgb(75, 192, 192)',
        orange: 'rgb(255, 159, 64)',
        red: 'rgb(255, 99, 132)',
        background: 'rgba(100, 100, 100, 0.2)'
      };

      // Re-resolved on theme change; covers the context gauge and both quota
      // gauges without touching their chart configs.
      function refreshGaugeColors() {
        GAUGE_COLORS.green = cssVar('--vscode-charts-green', 'rgb(75, 192, 192)');
        GAUGE_COLORS.orange = cssVar('--vscode-charts-orange', 'rgb(255, 159, 64)');
        GAUGE_COLORS.red = cssVar('--vscode-charts-red', 'rgb(255, 99, 132)');
        GAUGE_COLORS.background = cssVar('--sk-chart-grid', 'rgba(100, 100, 100, 0.2)');
      }
      refreshGaugeColors();

      // Chart.js defaults are dark-on-light out of the box, so charts that
      // specify no tick color at all (the history chart) were the light-theme
      // mirror of the hardcoded-grey problem.
      if (typeof Chart !== 'undefined' && Chart.defaults) {
        Chart.defaults.color = chartTheme().label;
        Chart.defaults.borderColor = chartTheme().grid;
      }

      /**
       * Re-resolve every canvas-baked color after a theme change.
       * CSS-styled elements re-theme on their own; only Chart.js needs this.
       */
      function applyChartTheme() {
        refreshGaugeColors();
        var t = chartTheme();
        if (typeof Chart !== 'undefined' && Chart.defaults) {
          Chart.defaults.color = t.label;
          Chart.defaults.borderColor = t.grid;
        }
        [historyChart, contextChart, turnAttributionChart, waterfallChart, toolFreqChart, eventDistChart]
          .forEach(function (chart) {
            if (!chart || !chart.options) return;
            var scales = chart.options.scales || {};
            Object.keys(scales).forEach(function (axis) {
              if (scales[axis] && scales[axis].ticks) scales[axis].ticks.color = t.tick;
              if (scales[axis] && scales[axis].grid) scales[axis].grid.color = t.grid;
            });
            var legend = chart.options.plugins && chart.options.plugins.legend;
            if (legend && legend.labels) legend.labels.color = t.label;
            if (chart.data && chart.data.datasets) {
              chart.data.datasets.forEach(function (ds) {
                if (!ds.label || !ATTR_VARS_BY_LABEL[ds.label]) return;
                ds.borderColor = attrColor(ds.label);
                ds.backgroundColor = withAlpha(attrColor(ds.label), 0.6);
              });
            }
            try {
              chart.update('none');
            } catch (e) {
              /* a chart mid-teardown must not break the others */
            }
          });
      }

      /**
       * Formats a number with commas for readability.
       */
      function formatNumber(num) {
        return num.toLocaleString();
      }

      /**
       * Formats cost with appropriate precision.
       */
      function formatCost(cost) {
        if (cost < 0.01) {
          return '$' + cost.toFixed(4);
        }
        return '$' + cost.toFixed(2);
      }

      /**
       * Extracts short model name from full ID.
       */
      function getShortModelName(modelId) {
        const match = modelId.match(/claude-(haiku|sonnet|opus|fable)-([0-9.]+)/i);
        if (match) {
          return match[1].charAt(0).toUpperCase() + match[1].slice(1) + ' ' + match[2];
        }
        return modelId;
      }

      /**
       * Gets the appropriate color for context gauge based on percentage.
       */
      function getGaugeColor(percent) {
        // Match Claude Code statusline thresholds
        if (percent >= 80) return GAUGE_COLORS.red;
        if (percent >= 50) return GAUGE_COLORS.orange;
        return GAUGE_COLORS.green;
      }

      /**
       * Initializes the Chart.js context gauge.
       */
      function initContextGauge() {
        const canvas = document.getElementById('contextChart');
        if (!canvas || !window.Chart) return;

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
       */
      function updateContextGauge(percent) {
        const clampedPercent = Math.min(100, Math.max(0, percent));

        if (contextChart) {
          contextChart.data.datasets[0].data = [clampedPercent, 100 - clampedPercent];
          contextChart.data.datasets[0].backgroundColor = [
            getGaugeColor(clampedPercent),
            GAUGE_COLORS.background
          ];
          contextChart.update('none');
        }

        // Update percentage text with color coding
        if (contextPercentEl) {
          contextPercentEl.textContent = Math.round(percent) + '%';
          contextPercentEl.className = 'context-percent';
          if (percent >= 80) {
            contextPercentEl.classList.add('danger');
          } else if (percent >= 50) {
            contextPercentEl.classList.add('warning');
          }
        }
      }

      // Quota gauge charts
      let quota5hChart = null;
      let quota7dChart = null;

      /**
       * Creates a quota gauge chart.
       */
      function createQuotaGauge(canvasId) {
        const canvas = document.getElementById(canvasId);
        if (!canvas || !window.Chart) return null;

        const ctx = canvas.getContext('2d');
        if (!ctx) return null;

        return new Chart(ctx, {
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
            cutout: '65%',
            plugins: {
              legend: { display: false },
              tooltip: { enabled: false }
            }
          }
        });
      }

      /**
       * Initializes quota gauge charts.
       */
      function initQuotaGauges() {
        quota5hChart = createQuotaGauge('quota5hChart');
        quota7dChart = createQuotaGauge('quota7dChart');
      }

      /**
       * Updates a quota gauge with new percentage.
       */
      function updateQuotaGauge(chart, percentEl, percent) {
        const clampedPercent = Math.min(100, Math.max(0, percent));

        if (chart) {
          chart.data.datasets[0].data = [clampedPercent, 100 - clampedPercent];
          chart.data.datasets[0].backgroundColor = [
            getGaugeColor(clampedPercent),
            GAUGE_COLORS.background
          ];
          chart.update('none');
        }

        if (percentEl) {
          percentEl.textContent = Math.round(percent) + '%';
          percentEl.className = 'quota-percent';
          if (percent >= 80) {
            percentEl.classList.add('danger');
          } else if (percent >= 50) {
            percentEl.classList.add('warning');
          }
        }
      }

      /**
       * Formats a reset time as relative (e.g., "Resets in 2h 15m").
       */
      function formatResetTime(isoString) {
        if (!isoString) return '-';

        const resetDate = new Date(isoString);
        const now = new Date();
        const diffMs = resetDate - now;

        if (diffMs <= 0) return 'Resetting...';

        const diffMins = Math.floor(diffMs / 60000);
        const diffHours = Math.floor(diffMins / 60);
        const diffDays = Math.floor(diffHours / 24);

        if (diffDays > 0) {
          const remainingHours = diffHours % 24;
          return 'Resets in ' + diffDays + 'd ' + remainingHours + 'h';
        }
        if (diffHours > 0) {
          const remainingMins = diffMins % 60;
          return 'Resets in ' + diffHours + 'h ' + remainingMins + 'm';
        }
        return 'Resets in ' + diffMins + 'm';
      }

      /**
       * Updates the projection display element.
       * @param projectionEl - The DOM element to update
       * @param projected - Projected utilization percentage (or undefined)
       */
      function updateProjectionDisplay(projectionEl, projected) {
        if (!projectionEl) return;

        // Hide if no projection data available
        if (projected === undefined) {
          projectionEl.classList.remove('visible', 'warning', 'danger');
          projectionEl.textContent = '';
          return;
        }

        projectionEl.classList.add('visible');
        projectionEl.classList.remove('warning', 'danger');

        if (projected >= 100) {
          projectionEl.textContent = 'May reach limit';
          projectionEl.classList.add('danger');
        } else if (projected >= 80) {
          projectionEl.textContent = '~' + Math.round(projected) + '% by reset';
          projectionEl.classList.add('warning');
        } else {
          projectionEl.textContent = '~' + Math.round(projected) + '% by reset';
        }
      }

      function showQuotaToast(title, body, severity) {
        let toast = document.getElementById('sk-toast');
        if (!toast) {
          toast = document.createElement('div');
          toast.id = 'sk-toast';
          toast.className = 'sk-toast';
          toast.setAttribute('role', 'status');
          toast.setAttribute('aria-live', 'polite');
          document.body.appendChild(toast);
        }

        const compactBody = typeof body === 'string' ? body.split('. ')[0] : '';
        toast.className = 'sk-toast sk-toast--' + (severity || 'info');
        toast.innerHTML = '<div class="sk-toast__title">' + escapeHtml(title || 'Notification') + '</div>' +
          '<div class="sk-toast__body">' + escapeHtml(compactBody || '') + '</div>';
        toast.classList.add('sk-toast--visible');

        if (quotaToastTimer) clearTimeout(quotaToastTimer);
        quotaToastTimer = setTimeout(function() {
          toast.classList.remove('sk-toast--visible');
          quotaToastTimer = null;
        }, severity === 'error' ? 2400 : 1800);
      }

      function renderResetCredits(containerEl, resetCredits) {
        if (!containerEl) return;
        if (!resetCredits || !Array.isArray(resetCredits.credits)) {
          containerEl.style.display = 'none';
          containerEl.innerHTML = '';
          return;
        }

        const availableCredits = resetCredits.credits.filter(function(credit) {
          return String(credit.status || '').toLowerCase() === 'available';
        });
        const count = Number.isFinite(resetCredits.availableCount) ? resetCredits.availableCount : availableCredits.length;
        let html = '<div class="quota-reset-credits-title">Reset Credits: ' + count + ' available</div>';
        if (availableCredits.length > 0) {
          html += '<div class="quota-reset-credits-list">';
          availableCredits.forEach(function(credit) {
            const title = credit.title ? ' - ' + credit.title : '';
            html += '<div class="quota-reset-credit">' + escapeHtml(credit.expiresAt || '') + escapeHtml(title) + '</div>';
          });
          html += '</div>';
        }

        containerEl.innerHTML = html;
        containerEl.style.display = 'block';
      }

      /**
       * Updates the quota display with new data.
       */
      // Five-hour billing block (local estimate) with the official status-line sample beside it.
      function updateBillingBlock(block, official) {
        const sectionEl = document.getElementById('billing-block-section');
        const windowEl = document.getElementById('billing-block-window');
        const usageEl = document.getElementById('billing-block-usage');
        const projectionEl = document.getElementById('billing-block-projection');
        const officialEl = document.getElementById('billing-block-official');
        if (!sectionEl || !windowEl || !usageEl || !projectionEl || !officialEl) return;

        if (!block) {
          sectionEl.classList.remove('visible');
          return;
        }
        const hhmm = (iso) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const hm = (ms) => {
          const minutes = Math.max(0, Math.round(ms / 60000));
          return minutes >= 60 ? Math.floor(minutes / 60) + 'h ' + (minutes % 60) + 'm' : minutes + 'm';
        };
        windowEl.textContent = hhmm(block.start) + ' – ' + hhmm(block.end) + ' · '
          + hm(block.elapsedMs) + ' elapsed · ' + hm(block.remainingMs) + ' left';
        const unpriced = block.costProvenance === 'unpriced';
        const costText = unpriced ? '—' : '$' + block.costUsd.toFixed(2);
        usageEl.innerHTML = '<strong>' + formatTokensShort(block.tokens.total) + '</strong> tokens · <strong>' + costText
          + '</strong> · ' + formatTokensShort(Math.round(block.burnRatePerMinute)) + '/min · local estimate';
        projectionEl.innerHTML = 'Projected by end: <strong>' + formatTokensShort(block.projectedTokens) + '</strong> tokens · <strong>'
          + (unpriced ? '—' : '$' + block.projectedCostUsd.toFixed(2)) + '</strong>';
        if (official) {
          const resetMs = official.fiveHourResetsAt ? Date.parse(official.fiveHourResetsAt) - Date.now() : NaN;
          const resets = Number.isFinite(resetMs) && resetMs > 0 ? ' · resets in ' + hm(resetMs) : '';
          officialEl.textContent = 'Official (status line): 5h ' + Math.round(official.fiveHourUtilization) + '% used' + resets
            + ' · 7d ' + Math.round(official.sevenDayUtilization) + '%';
          officialEl.classList.add('official');
        } else {
          officialEl.textContent = 'No official sample yet — install the status line to compare.';
          officialEl.classList.remove('official');
        }
        sectionEl.classList.add('visible');
      }

      function updateQuota(quota, quotaFailure) {
        currentQuota = quota;
        currentQuotaFailure = quotaFailure || null;

        const sectionEl = document.getElementById('quota-section');
        const contentEl = document.getElementById('quota-content');
        const errorEl = document.getElementById('quota-error');
        const metaEl = document.getElementById('quota-meta');
        const label5hEl = document.getElementById('quota-5h-label');
        const label7dEl = document.getElementById('quota-7d-label');
        const resetCreditsEl = document.getElementById('quota-reset-credits');

        if (!sectionEl || !contentEl || !errorEl) return;

        if (currentProviderId === 'opencode' && quota?.providerId !== 'zai') {
          sectionEl.classList.remove('visible');
          contentEl.style.display = 'none';
          errorEl.style.display = 'none';
          if (metaEl) metaEl.style.display = 'none';
          renderResetCredits(resetCreditsEl, null);
          return;
        }

        // Provider-aware section title and tooltip
        const titleEl = sectionEl.querySelector('.section-title');
        const isZaiQuota = quota?.providerId === 'zai';
        if (titleEl) {
          titleEl.textContent = currentProviderId === 'codex' ? 'Rate Limits' : isZaiQuota ? 'z.ai Quota' : 'Subscription Quota';
        }
        sectionEl.title = currentProviderId === 'codex'
          ? 'Codex CLI rate limits'
          : isZaiQuota
          ? 'z.ai Coding Plan quota'
          : 'Claude Max subscription usage limits';
        if (label5hEl) label5hEl.textContent = quota?.fiveHourLabel || (currentProviderId === 'codex' ? 'Primary' : '5-Hour');
        if (label7dEl) label7dEl.textContent = quota?.sevenDayLabel || (currentProviderId === 'codex' ? 'Secondary' : '7-Day');

        if (!quota) {
          sectionEl.classList.remove('visible');
          contentEl.style.display = 'none';
          errorEl.style.display = 'none';
          if (metaEl) metaEl.style.display = 'none';
          renderResetCredits(resetCreditsEl, null);
          return;
        }

        if (!quota.available) {
          if (quotaFailure) {
            sectionEl.classList.add('visible');
            contentEl.style.display = 'none';
            errorEl.style.display = 'block';
            errorEl.classList.remove('warning', 'error');
            if (quotaFailure.severity === 'warning' || quotaFailure.severity === 'error') {
              errorEl.classList.add(quotaFailure.severity);
            }
            errorEl.innerHTML =
              '<div class="quota-error-title">' + escapeHtml(quotaFailure.title) + '</div>' +
              '<div class="quota-error-body">' + escapeHtml(quotaFailure.message) + '</div>' +
              (quotaFailure.detail ? '<div class="quota-error-detail">' + escapeHtml(quotaFailure.detail) + '</div>' : '');
          } else if (quota.error) {
            sectionEl.classList.add('visible');
            contentEl.style.display = 'none';
            errorEl.style.display = 'block';
            errorEl.classList.remove('warning', 'error');
            errorEl.textContent = quota.error;
          } else {
            sectionEl.classList.remove('visible');
            contentEl.style.display = 'none';
            errorEl.style.display = 'none';
            errorEl.classList.remove('warning', 'error');
          }
          if (metaEl) metaEl.style.display = 'none';
          renderResetCredits(resetCreditsEl, null);
          return;
        }

        // Show quota section with data
        sectionEl.classList.add('visible');
        contentEl.style.display = 'block';
        errorEl.style.display = 'none';
        errorEl.classList.remove('warning', 'error');
        if (metaEl) {
          const metaParts = [];
          if (quota.accountLabel) {
            metaParts.push(quota.accountDetail
              ? quota.accountLabel + ' (' + quota.accountDetail + ')'
              : quota.accountLabel);
          }
          if (quota.stale) {
            metaParts.push('Cached ' + (quota.capturedAt ? new Date(quota.capturedAt).toLocaleString() : 'snapshot'));
          } else if (quota.providerId === 'codex') {
            metaParts.push('Live session');
          } else if (quota.providerId === 'zai') {
            metaParts.push(quota.source === 'cache' || quota.stale ? 'Cached z.ai API snapshot' : 'Live z.ai API');
          }
          metaEl.textContent = metaParts.join(' • ');
          metaEl.style.display = metaParts.length ? 'block' : 'none';
        }
        renderResetCredits(resetCreditsEl, quota.resetCredits);

        // Update 5-hour gauge
        const percent5hEl = document.getElementById('quota-5h-percent');
        const reset5hEl = document.getElementById('quota-5h-reset');
        const projection5hEl = document.getElementById('quota-5h-projection');
        updateQuotaGauge(quota5hChart, percent5hEl, quota.fiveHour.utilization);
        if (reset5hEl) {
          reset5hEl.textContent = formatResetTime(quota.fiveHour.resetsAt);
        }
        updateProjectionDisplay(projection5hEl, quota.projectedFiveHour);

        // Update 7-day gauge
        const percent7dEl = document.getElementById('quota-7d-percent');
        const reset7dEl = document.getElementById('quota-7d-reset');
        const projection7dEl = document.getElementById('quota-7d-projection');
        updateQuotaGauge(quota7dChart, percent7dEl, quota.sevenDay.utilization);
        if (reset7dEl) {
          reset7dEl.textContent = formatResetTime(quota.sevenDay.resetsAt);
        }
        updateProjectionDisplay(projection7dEl, quota.projectedSevenDay);
      }

      /**
       * Updates the provider status display.
       */
      function updateProviderStatus(display) {
        renderProviderStatus('provider-status', display);
      }

      /**
       * Updates the OpenAI provider status display.
       */
      function updateOpenAIStatus(display) {
        renderProviderStatus('openai-status', display);
      }

      function renderProviderStatus(idPrefix, display) {
        const sectionEl = document.getElementById(idPrefix + '-section');
        const titleEl = document.getElementById(idPrefix + '-title');
        const summaryEl = document.getElementById(idPrefix + '-summary');
        const affectedEl = document.getElementById(idPrefix + '-affected');
        const toggleEl = document.getElementById(idPrefix + '-toggle');
        const linkEl = document.getElementById(idPrefix + '-link');
        const detailsEl = document.getElementById(idPrefix + '-details');
        if (!sectionEl || !titleEl || !summaryEl || !affectedEl || !toggleEl || !linkEl || !detailsEl) return;

        sectionEl.classList.remove('visible', 'status-minor', 'status-major', 'status-critical');

        if (!display || !display.visible) {
          sectionEl.classList.remove('visible');
          detailsEl.hidden = true;
          sectionEl.removeAttribute('data-status-key');
          return;
        }

        const components = display.components || [];
        const statusKey = [
          display.severity,
          display.title,
          display.summary,
          components.map(function(component) {
            return component.name + ':' + component.status;
          }).join('|')
        ].join('\n');
        const keepExpanded = sectionEl.getAttribute('data-status-key') === statusKey && detailsEl.hidden === false;
        sectionEl.setAttribute('data-status-key', statusKey);

        sectionEl.classList.add('visible', 'status-' + display.severity);
        titleEl.textContent = display.title || display.providerLabel || 'Provider status';
        summaryEl.textContent = display.summary || '';
        affectedEl.textContent = components.length > 0 ? display.affectedSummary || '' : '';
        affectedEl.style.display = components.length > 0 ? '' : 'none';

        if (display.incidentUrl) {
          linkEl.setAttribute('href', display.incidentUrl);
          linkEl.setAttribute('rel', 'noopener noreferrer');
          linkEl.style.display = '';
        } else {
          linkEl.removeAttribute('href');
          linkEl.style.display = 'none';
        }

        detailsEl.textContent = '';
        for (const component of components) {
          const row = document.createElement('div');
          row.className = 'provider-status-component';
          const name = document.createElement('span');
          name.className = 'provider-status-component-name';
          name.textContent = component.name || 'Unknown';
          const state = document.createElement('span');
          state.className = 'provider-status-component-state';
          state.textContent = component.status || 'unknown';
          row.appendChild(name);
          row.appendChild(state);
          detailsEl.appendChild(row);
        }

        if (components.length > 0) {
          detailsEl.hidden = !keepExpanded;
          toggleEl.hidden = false;
          toggleEl.textContent = keepExpanded ? 'Hide' : 'Details';
          toggleEl.setAttribute('aria-expanded', String(keepExpanded));
          toggleEl.onclick = function() {
            const expanded = detailsEl.hidden;
            detailsEl.hidden = !expanded;
            toggleEl.textContent = expanded ? 'Hide' : 'Details';
            toggleEl.setAttribute('aria-expanded', String(expanded));
          };
        } else {
          detailsEl.hidden = true;
          toggleEl.hidden = true;
          toggleEl.onclick = null;
          toggleEl.setAttribute('aria-expanded', 'false');
        }
      }

      /**
       * Updates the Claude peak-hours pill. Off-peak, unavailable, or
       * non-claude-max states all collapse the pill entirely — only a live
       * "peak active" window is surfaced.
       */
      function updatePeakHours(status) {
        const sectionEl = document.getElementById('peak-hours-section');
        const indicatorEl = document.getElementById('peak-hours-indicator');
        const detailsEl = document.getElementById('peak-hours-details');
        if (!sectionEl || !indicatorEl || !detailsEl) return;

        if (currentProviderId !== 'claude-code' || !status || status.unavailable || !status.isPeak) {
          sectionEl.classList.remove('visible');
          return;
        }

        sectionEl.classList.add('visible');

        const dot = '●';
        indicatorEl.innerHTML =
          '<span style="color: var(--vscode-charts-orange, var(--vscode-charts-yellow))">' +
          dot + '</span> ' +
          escapeHtml(status.label || 'Peak Hours');

        // Joined inline rather than stacked: the pill spans the full dashboard
        // width now, so countdown and schedule fit on one line together.
        const parts = [];
        if (typeof status.minutesUntilChange === 'number' && status.minutesUntilChange > 0) {
          const hours = Math.floor(status.minutesUntilChange / 60);
          const mins = status.minutesUntilChange % 60;
          const countdown = hours > 0 ? hours + 'h ' + mins + 'm' : mins + 'm';
          parts.push('Off-peak in ' + countdown);
        }
        if (status.peakHoursDescription) {
          parts.push(escapeHtml(status.peakHoursDescription));
        }
        detailsEl.innerHTML = parts.join(' · ');
      }

      /**
       * Updates the latency display with new data.
       */
      function updateLatency(latency) {
        const sectionEl = document.getElementById('latency-section');
        if (!sectionEl) return;

        if (!latency || !latency.hasData) {
          sectionEl.style.display = 'none';
          return;
        }

        sectionEl.style.display = 'block';

        const lastEl = document.getElementById('latency-last');
        const avgEl = document.getElementById('latency-avg');
        const maxEl = document.getElementById('latency-max');
        const totalAvgEl = document.getElementById('latency-total-avg');
        const countEl = document.getElementById('latency-count');

        if (lastEl) lastEl.textContent = latency.lastFirstToken;
        if (avgEl) avgEl.textContent = latency.avgFirstToken;
        if (maxEl) maxEl.textContent = latency.maxFirstToken;
        if (totalAvgEl) totalAvgEl.textContent = latency.avgTotal;
        if (countEl) countEl.textContent = latency.cycleCount;
      }

      /**
       * Updates tool analytics display.
       */
      function updateToolAnalytics(analytics) {
        const toolListEl = document.getElementById('tool-list');
        if (!toolListEl) return;

        if (!analytics || analytics.length === 0) {
          toolListEl.innerHTML = '<div class="tool-item"><span class="tool-name">No tools used yet</span></div>';
          return;
        }

        toolListEl.innerHTML = analytics.map(function(tool) {
          const successClass = tool.successRate < 90 ? 'warning' : '';
          const avgDuration = tool.avgDuration < 1000
            ? tool.avgDuration + 'ms'
            : (tool.avgDuration / 1000).toFixed(1) + 's';

          return '<div class="tool-item" data-tool-name="' + escapeHtml(tool.name) + '" style="cursor: pointer;">' +
            '<div class="tool-header">' +
              '<span class="tool-name">' + escapeHtml(tool.name) + '</span>' +
              '<span class="tool-calls">' + tool.totalCalls + ' calls' +
                (tool.pendingCount > 0 ? ' (' + tool.pendingCount + ' pending)' : '') +
              '</span>' +
            '</div>' +
            '<div class="tool-stats">' +
              '<span class="success-rate ' + successClass + '">' +
                tool.successRate.toFixed(0) + '% success' +
              '</span>' +
              '<span class="avg-duration">avg ' + avgDuration + '</span>' +
            '</div>' +
            '<div class="tool-drilldown" style="display: none;"></div>' +
          '</div>';
        }).join('');

        // Add click handlers for drill-down
        toolListEl.querySelectorAll('.tool-item[data-tool-name]').forEach(function(item) {
          item.addEventListener('click', function() {
            const toolName = item.getAttribute('data-tool-name');
            const drilldown = item.querySelector('.tool-drilldown');
            if (!drilldown) return;

            if (drilldown.style.display === 'none') {
              // Request details from extension
              vscode.postMessage({ type: 'requestToolCallDetails', toolName: toolName });
              drilldown.innerHTML = '<div style="padding: 4px;"><div class="sk-skeleton sk-skeleton-line" style="width: 80%;"></div><div class="sk-skeleton sk-skeleton-line" style="width: 60%;"></div></div>';
              drilldown.style.display = 'block';
            } else {
              drilldown.style.display = 'none';
            }
          });
        });
      }

      /**
       * Renders tool call details in the drill-down area.
       */
      function renderToolCallDetails(toolName, calls) {
        const toolListEl = document.getElementById('tool-list');
        if (!toolListEl) return;

        const item = toolListEl.querySelector('.tool-item[data-tool-name="' + escapeHtml(toolName) + '"]');
        if (!item) return;

        const drilldown = item.querySelector('.tool-drilldown');
        if (!drilldown) return;

        if (!calls || calls.length === 0) {
          drilldown.innerHTML = '<div style="padding: 4px; font-size: 10px;">No calls recorded</div>';
          return;
        }

        drilldown.innerHTML = calls.slice(0, 20).map(function(call) {
          const errorStyle = call.isError ? 'color: var(--vscode-errorForeground);' : '';
          return '<div style="display: flex; gap: 6px; padding: 2px 4px; font-size: 10px; border-bottom: 1px solid var(--vscode-panel-border); ' + errorStyle + '">' +
            '<span style="min-width: 45px; color: var(--vscode-descriptionForeground);">' + call.time + '</span>' +
            '<span style="flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">' + escapeHtml(call.description) + '</span>' +
            '<span style="min-width: 40px; text-align: right;">' + call.duration + '</span>' +
          '</div>';
        }).join('') +
        (calls.length > 20 ? '<div style="padding: 2px 4px; font-size: 10px; color: var(--vscode-descriptionForeground);">...and ' + (calls.length - 20) + ' more</div>' : '');
      }

      // Current timeline events cache for client-side filtering
      let currentTimelineEvents = [];

      // Current filter state
      const timelineFilters = { showUser: true, showAi: true, showSystem: false, showSidechain: false };

      /**
       * Updates timeline display with search and filter support.
       */
      function updateTimeline(events) {
        currentTimelineEvents = events || [];
        renderFilteredTimeline();
      }

      /**
       * Renders the timeline with current search query and filters applied.
       */
      function renderFilteredTimeline() {
        const timelineEl = document.getElementById('timeline-list');
        if (!timelineEl) return;

        const events = currentTimelineEvents;
        let searchQuery = '';
        const searchEl = document.getElementById('timeline-search');
        if (searchEl) {
          searchQuery = searchEl.value.trim().toLowerCase();
        }

        // Apply filters
        const filtered = events.filter(function(event) {
          // Noise-level filtering
          const noise = event.noiseLevel || 'ai';
          if (noise === 'user' && !timelineFilters.showUser) return false;
          if (noise === 'ai' && !timelineFilters.showAi) return false;
          if ((noise === 'system' || noise === 'noise') && !timelineFilters.showSystem) return false;
          if (event.isSidechain && !timelineFilters.showSidechain) return false;

          // Search filtering
          if (searchQuery) {
            const desc = (event.description || '').toLowerCase();
            const full = (event.fullText || '').toLowerCase();
            if (desc.indexOf(searchQuery) === -1 && full.indexOf(searchQuery) === -1) {
              return false;
            }
          }

          return true;
        });

        if (filtered.length === 0) {
          timelineEl.innerHTML = '<div class="timeline-item">' +
            '<span class="time">--:--</span>' +
            '<span class="description">' + (searchQuery ? 'No matching events' : 'No activity yet') + '</span>' +
          '</div>';
          return;
        }

        // Show result count when searching
        let countHtml = '';
        if (searchQuery) {
          countHtml = '<div class="timeline-search-count">Showing ' + filtered.length + ' of ' + events.length + ' events</div>';
        }

        const iconMap = {
          'user_prompt': '💬',
          'tool_call': '🔧',
          'tool_result': '✓',
          'error': '❌',
          'assistant_response': '🤖',
          'compaction': '⚠'
        };

        timelineEl.innerHTML = countHtml + filtered.map(function(event, idx) {
          const icon = iconMap[event.type] || '●';
          let classes = 'timeline-item';
          if (event.isError) classes += ' error';
          if (event.type === 'assistant_response') classes += ' assistant';
          if (event.type === 'compaction') classes += ' compaction';
          if (event.isSidechain) classes += ' sidechain';
          if (event.noiseLevel === 'noise') classes += ' noise';
          if (event.noiseLevel === 'system') classes += ' system-event';

          // Highlight search matches
          let desc = escapeHtml(event.description);
          if (searchQuery) {
            try {
              const escaped = searchQuery.replace(/[-\/^$*+?.()|[\]{}]/g, String.fromCharCode(92) + '$&');
              const re = new RegExp('(' + escaped + ')', 'gi');
              desc = desc.replace(re, '<mark>$1</mark>');
            } catch(ex) { /* invalid regex, skip highlighting */ }
          }

          // Add expand link for assistant responses with full text
          let expandLink = '';
          if (event.type === 'assistant_response' && event.fullText) {
            expandLink = ' <span class="expand-link" data-idx="' + idx + '" data-expanded="false">[more]</span>';
          }

          return '<div class="' + classes + '" data-idx="' + idx + '">' +
            '<span class="time">' + event.time + '</span>' +
            '<span class="icon">' + icon + '</span>' +
            '<span class="description" data-truncated="' + escapeHtml(event.description) + '" data-full="' + (event.fullText ? escapeHtml(event.fullText) : '') + '">' + desc + expandLink + '</span>' +
          '</div>';
        }).join('');

        // Add click handlers for expand/collapse
        function setTimelineDescription(descEl, text, idx, expanded) {
          descEl.textContent = text || '';
          descEl.appendChild(document.createTextNode(' '));
          const nextLink = document.createElement('span');
          nextLink.className = 'expand-link';
          nextLink.setAttribute('data-idx', idx);
          nextLink.setAttribute('data-expanded', String(expanded));
          nextLink.textContent = expanded ? '[less]' : '[more]';
          descEl.appendChild(nextLink);
          return nextLink;
        }

        timelineEl.querySelectorAll('.expand-link').forEach(function(link) {
          link.addEventListener('click', function handleExpand(e) {
            e.stopPropagation();
            const clickedLink = e.currentTarget;
            const idx = clickedLink.getAttribute('data-idx');
            const item = timelineEl.querySelector('.timeline-item[data-idx="' + idx + '"]');
            if (!item) return;

            const descEl = item.querySelector('.description');
            if (!descEl) return;

            const isExpanded = clickedLink.getAttribute('data-expanded') === 'true';
            const truncated = descEl.getAttribute('data-truncated');
            const full = descEl.getAttribute('data-full');

            const newLink = setTimelineDescription(
              descEl,
              isExpanded ? truncated : full,
              idx,
              !isExpanded
            );
            newLink.addEventListener('click', handleExpand);
          });
        });
      }

      /**
       * Updates compaction events display.
       */
      function updateCompactions(compactions) {
        const sectionEl = document.getElementById('compaction-section');
        const listEl = document.getElementById('compaction-list');
        const ledgerEl = document.getElementById('compaction-ledger');
        if (!sectionEl || !listEl) return;

        if (!compactions || compactions.length === 0) {
          sectionEl.style.display = 'none';
          return;
        }

        sectionEl.style.display = 'block';
        if (ledgerEl) {
          const evicted = compactions.reduce(function(sum, item) { return sum + item.tokensReclaimed; }, 0);
          const priced = compactions.every(function(item) { return item.reestablishmentCostUsd != null; });
          const cost = compactions.reduce(function(sum, item) { return sum + (item.reestablishmentCostUsd || 0); }, 0);
          const sources = new Set(compactions.map(function(item) { return item.source; }));
          const source = sources.size > 1 ? 'mixed' : (compactions[0].source || 'heuristic');
          ledgerEl.textContent = compactions.length + ' compaction' + (compactions.length === 1 ? '' : 's') + ' · ' + formatNumber(evicted) + ' tokens evicted · ' + (priced ? ('~' + formatCost(cost) + ' re-establishing context') : 'cost unavailable') + ' · ' + source;
        }
        listEl.innerHTML = compactions.map(function(c) {
          const beforeK = Math.round(c.contextBefore / 1000);
          const afterK = Math.round(c.contextAfter / 1000);
          const reclaimedK = Math.round(c.tokensReclaimed / 1000);
          return '<div class="compaction-item">' +
            '<span class="compaction-time">' + c.time + '</span>' +
            '<span class="compaction-delta">' + beforeK + 'K → ' + afterK + 'K</span>' +
            '<span class="compaction-reclaimed">-' + reclaimedK + 'K (' + c.reclaimedPercent + '% · ' + c.source + ')</span>' +
          '</div>';
        }).join('');
      }

      /**
       * Updates context attribution stacked bar + legend.
       */
      function updateContextAttribution(attribution) {
        const sectionEl = document.getElementById('context-attribution-section');
        const chartEl = document.getElementById('context-attribution-chart');
        const legendEl = document.getElementById('attribution-legend');
        if (!sectionEl || !chartEl || !legendEl) return;

        if (!attribution || attribution.length === 0) {
          sectionEl.style.display = 'none';
          return;
        }

        sectionEl.style.display = 'block';

        // Stacked bar
        chartEl.innerHTML = attribution.map(function(a) {
          return '<div class="attr-bar" style="width:' + a.percent + '%;background:' + a.color + '" title="' +
            a.category + ': ' + formatTokensShort(a.tokens) + ' (' + a.percent + '%)"></div>';
        }).join('');

        // Legend
        legendEl.innerHTML = attribution.map(function(a) {
          return '<span class="legend-item">' +
            '<span class="legend-swatch" style="background:' + a.color + '"></span>' +
            '<span>' + a.category + '</span>' +
            '<span class="legend-tokens">' + formatTokensShort(a.tokens) + ' (' + a.percent + '%)</span>' +
          '</span>';
        }).join('');
      }

      function formatTokensShort(tokens) {
        if (tokens >= 1000000) return (tokens / 1000000).toFixed(1) + 'M';
        if (tokens >= 1000) return Math.round(tokens / 1000) + 'K';
        return String(tokens);
      }

      // Per-turn attribution stacked area chart
      let turnAttributionChart = null;

      function updateTurnAttributions(turns) {
        const sectionEl = document.getElementById('turn-attribution-section');
        if (!sectionEl) return;

        if (!turns || turns.length === 0) {
          sectionEl.style.display = 'none';
          return;
        }

        sectionEl.style.display = 'block';

        const canvas = document.getElementById('turnAttributionChart');
        if (!canvas || !window.Chart) return;

        const labels = turns.map(function(t) { return '#' + t.turnIndex; });

        // Build datasets per category
        const categoryMap = {};

        turns.forEach(function(turn) {
          turn.categories.forEach(function(cat) {
            if (!categoryMap[cat.category]) {
              categoryMap[cat.category] = new Array(turns.length).fill(0);
            }
          });
        });

        turns.forEach(function(turn, i) {
          turn.categories.forEach(function(cat) {
            if (categoryMap[cat.category]) {
              categoryMap[cat.category][i] = cat.tokens;
            }
          });
        });

        const datasets = Object.keys(categoryMap).map(function(cat) {
          return {
            label: cat,
            data: categoryMap[cat],
            backgroundColor: withAlpha(attrColor(cat), 0.6),
            borderColor: attrColor(cat),
            borderWidth: 1,
            fill: true,
            pointRadius: 0
          };
        });

        if (turnAttributionChart) {
          turnAttributionChart.data.labels = labels;
          turnAttributionChart.data.datasets = datasets;
          turnAttributionChart.update('none');
        } else {
          const ctx = canvas.getContext('2d');
          if (!ctx) return;
          turnAttributionChart = new Chart(ctx, {
            type: 'line',
            data: { labels: labels, datasets: datasets },
            options: {
              responsive: true,
              maintainAspectRatio: false,
              scales: {
                x: { ticks: { color: chartTheme().tick, maxTicksLimit: 10 }, grid: { color: chartTheme().grid } },
                y: {
                  stacked: true,
                  ticks: {
                    color: chartTheme().tick,
                    callback: function(v) { return formatTokensShort(v); }
                  },
                  grid: { color: chartTheme().grid }
                }
              },
              plugins: {
                legend: { display: true, position: 'bottom', labels: { color: chartTheme().label, boxWidth: 10, padding: 6, font: { size: 10 } } },
                tooltip: {
                  callbacks: {
                    label: function(ctx) { return ctx.dataset.label + ': ' + formatTokensShort(ctx.parsed.y); }
                  }
                }
              },
              interaction: { mode: 'index', intersect: false }
            }
          });
        }
      }

      // Context waterfall chart
      let waterfallChart = null;

      function updateContextWaterfall(waterfall) {
        const sectionEl = document.getElementById('context-waterfall-section');
        if (!sectionEl) return;

        if (!waterfall || !waterfall.points || waterfall.points.length === 0) {
          sectionEl.style.display = 'none';
          return;
        }

        sectionEl.style.display = 'block';

        const canvas = document.getElementById('contextWaterfallChart');
        if (!canvas || !window.Chart) return;

        const labels = waterfall.points.map(function(p) { return '#' + p.turnIndex; });
        const data = waterfall.points.map(function(p) { return p.tokens; });

        // Build compaction annotation lines
        const compactionIndices = [];
        if (waterfall.compactions && waterfall.compactions.length > 0) {
          waterfall.compactions.forEach(function(c) {
            // Find closest point index by matching time
            for (let i = 0; i < waterfall.points.length; i++) {
              if (waterfall.points[i].time === c.time) {
                compactionIndices.push(i);
                break;
              }
            }
          });
        }

        // Segment colors: red after compaction points
        const segmentColor = function(ctx) {
          if (compactionIndices.length === 0) return 'rgba(97, 175, 239, 0.6)';
          for (let i = 0; i < compactionIndices.length; i++) {
            if (ctx.p0DataIndex === compactionIndices[i]) return 'rgba(224, 108, 117, 0.8)';
          }
          return 'rgba(97, 175, 239, 0.6)';
        };

        if (waterfallChart) {
          waterfallChart.data.labels = labels;
          waterfallChart.data.datasets[0].data = data;
          waterfallChart.data.datasets[0].segment = { borderColor: segmentColor };
          waterfallChart.update('none');
        } else {
          const ctx = canvas.getContext('2d');
          if (!ctx) return;
          waterfallChart = new Chart(ctx, {
            type: 'line',
            data: {
              labels: labels,
              datasets: [{
                label: 'Context Size',
                data: data,
                borderColor: 'rgba(97, 175, 239, 0.8)',
                backgroundColor: 'rgba(97, 175, 239, 0.15)',
                fill: true,
                tension: 0.2,
                pointRadius: 1,
                pointHoverRadius: 4,
                segment: { borderColor: segmentColor }
              }]
            },
            options: {
              responsive: true,
              maintainAspectRatio: false,
              scales: {
                x: { ticks: { color: chartTheme().tick, maxTicksLimit: 10 }, grid: { color: chartTheme().grid } },
                y: {
                  ticks: {
                    color: chartTheme().tick,
                    callback: function(v) { return formatTokensShort(v); }
                  },
                  grid: { color: chartTheme().grid }
                }
              },
              plugins: {
                legend: { display: false },
                tooltip: {
                  callbacks: {
                    label: function(ctx) { return 'Context: ' + formatTokensShort(ctx.parsed.y); }
                  }
                }
              }
            }
          });
        }
      }

      // Notification history
      function updateNotificationHistory(notifications, unreadCount) {
        const sectionEl = document.getElementById('notification-history-section');
        const listEl = document.getElementById('notification-list');
        const actionsEl = document.getElementById('notification-actions');
        const badgeEl = document.getElementById('notification-badge');
        if (!sectionEl || !listEl) return;

        if (!notifications || notifications.length === 0) {
          sectionEl.style.display = 'none';
          return;
        }

        sectionEl.style.display = 'block';
        if (actionsEl) actionsEl.style.display = 'flex';

        if (badgeEl) {
          if (unreadCount > 0) {
            badgeEl.textContent = String(unreadCount);
            badgeEl.style.display = 'inline-block';
          } else {
            badgeEl.style.display = 'none';
          }
        }

        const severityIcons = { error: '⚠', warning: '⚠', info: 'ℹ' };

        listEl.innerHTML = notifications.map(function(n) {
          const icon = severityIcons[n.severity] || 'ℹ';
          const readClass = n.isRead ? 'notification-read' : 'notification-unread';
          return '<div class="notification-item ' + readClass + ' notification-' + n.severity + '" data-id="' + n.id + '">' +
            '<span class="notification-icon">' + icon + '</span>' +
            '<div class="notification-content">' +
              '<div class="notification-header">' +
                '<span class="notification-title">' + escapeHtml(n.title) + '</span>' +
                '<span class="notification-time">' + n.time + '</span>' +
              '</div>' +
              '<div class="notification-body">' + escapeHtml(n.body) + '</div>' +
            '</div>' +
          '</div>';
        }).join('');

        // Click to mark read
        listEl.querySelectorAll('.notification-item').forEach(function(item) {
          item.addEventListener('click', function() {
            const id = item.getAttribute('data-id');
            if (id) {
              vscode.postMessage({ type: 'markNotificationRead', id: id });
              item.classList.remove('notification-unread');
              item.classList.add('notification-read');
            }
          });
        });
      }

      /**
       * Updates error display with foldable groups.
       */
      function updateErrorDetails(errorDetails) {
        const sectionEl = document.getElementById('error-section');
        const listEl = document.getElementById('error-list');
        if (!sectionEl || !listEl) return;

        if (!errorDetails || errorDetails.length === 0) {
          sectionEl.style.display = 'none';
          return;
        }

        sectionEl.style.display = 'block';
        listEl.innerHTML = errorDetails.map(function(group, idx) {
          const messagesHtml = group.messages.map(function(msg) {
            return '<li>' + escapeHtml(msg) + '</li>';
          }).join('');

          return '<div class="error-group" data-idx="' + idx + '">' +
            '<div class="error-group-header">' +
              '<span class="error-type">' + group.type + '</span>' +
              '<span class="error-count">' + group.count + ' error' + (group.count > 1 ? 's' : '') + '</span>' +
              '<span class="chevron">▶</span>' +
            '</div>' +
            '<ul class="error-group-messages">' + messagesHtml + '</ul>' +
          '</div>';
        }).join('');

        // Add click listeners (CSP blocks inline onclick)
        listEl.querySelectorAll('.error-group-header').forEach(function(header) {
          header.addEventListener('click', function() {
            header.parentElement.classList.toggle('expanded');
          });
        });
      }


      function updateProviderDisplay(providerId, providerName) {
        if (!providerId || !providerName) return;
        currentQuota = null;
        currentQuotaFailure = null;
        currentProviderId = providerId;
        currentProviderName = providerName;
        if (currentProviderId !== 'claude-code') {
          updatePeakHours(null);
        }

        // Update instruction file targeting based on provider
        const instructionTargets = {
          'claude-code': {
            file: 'CLAUDE.md',
            tip: 'After adding suggestions to your CLAUDE.md, run /init in Claude Code to consolidate and optimize the file.',
            docsUrl: 'https://docs.anthropic.com/en/docs/claude-code/memory#claudemd'
          },
          'opencode': {
            file: 'AGENTS.md',
            tip: 'OpenCode reads AGENTS.md for project-specific instructions. It falls back to CLAUDE.md if AGENTS.md is not found.',
            docsUrl: 'https://github.com/opencode-ai/opencode'
          },
          'codex': {
            file: 'AGENTS.md',
            tip: 'Codex reads AGENTS.md for project-specific agent instructions.',
            docsUrl: 'https://github.com/openai/codex'
          }
        };
        const instrTarget = instructionTargets[providerId] || instructionTargets['claude-code'];
        targetFileName = instrTarget.file;
        targetFileTip = instrTarget.tip;
        targetDocsUrl = instrTarget.docsUrl;

        // Update docs link if present
        const docsLink = document.getElementById('guidance-docs-link');
        if (docsLink) docsLink.setAttribute('href', targetDocsUrl);

        if (sessionProviderSelect) {
          sessionProviderSelect.value = providerId;
        }

        if (emptyStateTitle) {
          emptyStateTitle.textContent = 'No active ' + providerName + ' session detected.';
        }
        if (emptyStateHint) {
          emptyStateHint.textContent = 'Start a ' + providerName + ' session to see analytics.';
        }

        const quotaSectionEl = document.getElementById('quota-section');
        const quotaContentEl = document.getElementById('quota-content');
        const quotaErrorEl = document.getElementById('quota-error');

        if (gaugeRow) {
          gaugeRow.classList.toggle('opencode-provider', currentProviderId === 'opencode');
        }

        // For OpenCode: repurpose the Quota button as "Context" (no subscription quota)
        // For Claude Code: restore the Quota button label and show subscription quota
        const quotaBtn = document.querySelector('.metric-btn[data-metric="quota"]');
        if (currentProviderId === 'opencode') {
          if (quotaSectionEl) quotaSectionEl.classList.remove('visible');
          if (quotaContentEl) quotaContentEl.style.display = 'none';
          if (quotaErrorEl) quotaErrorEl.style.display = 'none';
          if (quotaBtn) quotaBtn.textContent = 'Context';
          return;
        }

        // Restore for non-OpenCode providers
        if (quotaBtn) quotaBtn.textContent = currentProviderId === 'codex' ? 'Limits' : 'Quota';

        if (currentQuota) {
          updateQuota(currentQuota, currentQuotaFailure);
        }
      }

      /**
       * Updates the session card navigator.
       */
      function updateSessionList(groups, isPinned, isUsingCustomPath, customPathDisplay) {
        if (!sessionListEl) return;

        // Update custom path indicator
        if (customPathIndicator && customPathText) {
          if (isUsingCustomPath && customPathDisplay) {
            customPathIndicator.classList.add('visible');
            customPathText.textContent = 'Custom: ' + customPathDisplay;
          } else {
            customPathIndicator.classList.remove('visible');
          }
        }

        // Update pin button
        if (pinSessionBtn) {
          pinSessionBtn.textContent = isPinned ? 'Unpin' : 'Pin';
          pinSessionBtn.setAttribute('aria-pressed', isPinned ? 'true' : 'false');
          if (isPinned) {
            pinSessionBtn.classList.add('pinned');
            pinSessionBtn.title = 'Unpin session to allow auto-switching';
          } else {
            pinSessionBtn.classList.remove('pinned');
            pinSessionBtn.title = 'Pin session to prevent auto-switching';
          }
        }

        // Clear current content
        sessionListEl.innerHTML = '';

        if (!groups || groups.length === 0) {
          sessionListEl.innerHTML = '<div class="session-list-empty">No sessions available</div>';
          return;
        }

        let totalSessions = 0;
        groups.forEach(function(group) {
          // Add group header for non-current groups
          if (group.proximity !== 'current') {
            const header = document.createElement('div');
            header.className = 'session-group-header';
            header.textContent = group.displayPath || group.projectPath;
            sessionListEl.appendChild(header);
          }

          // Add session cards
          group.sessions.forEach(function(session, index) {
            const card = document.createElement('div');
            card.className = 'session-card' + (session.isCurrent ? ' current' : '');
            card.setAttribute('data-path', session.path);

            const statusDiv = document.createElement('div');
            statusDiv.className = 'session-card-status';
            const dot = document.createElement('span');
            dot.className = 'status-dot' + (session.isActive ? ' active' : '');
            statusDiv.appendChild(dot);

            const contentDiv = document.createElement('div');
            contentDiv.className = 'session-card-content';

            const labelDiv = document.createElement('div');
            labelDiv.className = 'session-card-label';
            labelDiv.textContent = session.label || session.filename.slice(0, 8) + '...';

            const metaDiv = document.createElement('div');
            metaDiv.className = 'session-card-meta';
            const date = new Date(session.modifiedTime);
            metaDiv.textContent = (index === 0 && group.proximity === 'current') ? 'Latest' : formatRelativeTime(date);

            contentDiv.appendChild(labelDiv);
            contentDiv.appendChild(metaDiv);

            card.appendChild(statusDiv);
            card.appendChild(contentDiv);

            sessionListEl.appendChild(card);
            totalSessions++;
          });
        });

        if (totalSessions === 0) {
          sessionListEl.innerHTML = '<div class="session-list-empty">No sessions available</div>';
        }
      }

      /**
       * Formats a date as relative time (e.g., "5m ago", "2h ago").
       */
      function formatRelativeTime(date) {
        const now = new Date();
        const diffMs = now - date;
        const diffMins = Math.floor(diffMs / 60000);
        const diffHours = Math.floor(diffMins / 60);
        const diffDays = Math.floor(diffHours / 24);

        if (diffMins < 1) return 'Just now';
        if (diffMins < 60) return diffMins + 'm ago';
        if (diffHours < 24) return diffHours + 'h ago';
        return diffDays + 'd ago';
      }

      /**
       * Updates the file changes display.
       */
      function updateFileChanges(summary) {
        const sectionEl = document.getElementById('file-changes-section');
        const fileCountEl = document.getElementById('file-count');
        const additionsEl = document.getElementById('file-additions');
        const deletionsEl = document.getElementById('file-deletions');
        const impactEl = document.getElementById('file-impact');

        if (!sectionEl || !fileCountEl || !additionsEl || !deletionsEl) return;

        // Hide section if no changes
        if (!summary || (summary.totalFilesChanged === 0 && summary.totalAdditions === 0 && summary.totalDeletions === 0)) {
          sectionEl.style.display = 'none';
          return;
        }

        // Show section with data
        sectionEl.style.display = 'block';
        const fileCount = summary.totalFilesChanged || 0;
        fileCountEl.textContent = fileCount + ' file' + (fileCount !== 1 ? 's' : '');
        additionsEl.textContent = '+' + formatNumber(summary.totalAdditions || 0);
        deletionsEl.textContent = '-' + formatNumber(summary.totalDeletions || 0);
        if (impactEl) {
          impactEl.textContent = summary.costPerChangedLine == null ? 'Cost per changed line: —' : 'Cost per changed line: ' + formatCost(summary.costPerChangedLine);
        }
      }

      /**
       * Updates the dashboard with new state.
       */
      function updateDashboard(state) {
        // Update session state for metric toggles
        sessionState.totalInputTokens = state.totalInputTokens;
        sessionState.totalOutputTokens = state.totalOutputTokens;
        sessionState.totalCacheWriteTokens = state.totalCacheWriteTokens;
        sessionState.totalCacheReadTokens = state.totalCacheReadTokens;
        sessionState.totalCost = state.totalCost;
        sessionState.messageCount = state.modelBreakdown.reduce(function(sum, m) { return sum + m.calls; }, 0);

        // Show dashboard, hide empty state
        if (state.sessionActive || state.totalInputTokens > 0) {
          contentEl.style.display = 'none';
          dashboardEl.style.display = 'block';
        } else {
          contentEl.style.display = 'block';
          dashboardEl.style.display = 'none';
        }

        // Update status
        if (state.sessionActive) {
          statusEl.textContent = 'Active';
          statusEl.className = 'status active';
        } else {
          statusEl.textContent = 'No Session';
          statusEl.className = 'status inactive';
        }

        // Update tokens (in details section)
        if (inputTokensEl) inputTokensEl.textContent = formatNumber(state.totalInputTokens);
        if (outputTokensEl) outputTokensEl.textContent = formatNumber(state.totalOutputTokens);
        if (cacheWriteTokensEl) cacheWriteTokensEl.textContent = formatNumber(state.totalCacheWriteTokens);
        if (cacheReadTokensEl) cacheReadTokensEl.textContent = formatNumber(state.totalCacheReadTokens);

        // Update primary metric display
        updatePrimaryMetric();
        updateInlineStats();

        // Update context gauge
        updateContextGauge(state.contextUsagePercent || 0);

        // Update latency display
        if (state.latencyDisplay) {
          updateLatency(state.latencyDisplay);
        }

        // Update model breakdown
        if (modelListEl) {
          modelListEl.innerHTML = '';
          if (state.modelBreakdown.length === 0) {
            modelListEl.innerHTML = '<div class="model-item"><span class="name">No models used yet</span></div>';
          } else {
            state.modelBreakdown.forEach(function(model) {
              const item = document.createElement('div');
              item.className = 'model-item';
              item.innerHTML = '<span class="name">' + escapeHtml(getShortModelName(model.model)) + '</span>' +
                '<span class="stats">' + model.calls + ' calls, ' + formatNumber(model.tokens) + ' tokens, ' + formatCost(model.cost) + '</span>';
              modelListEl.appendChild(item);
            });
          }
        }

        // Update error details
        if (state.errorDetails) {
          updateErrorDetails(state.errorDetails);
        }

        // Update file changes
        updateFileChanges(state.fileChangeSummary);

        // Update compactions
        if (state.compactions) {
          updateCompactions(state.compactions);
        }

        // Update context attribution
        if (state.contextAttribution) {
          updateContextAttribution(state.contextAttribution);
        }

        // Update timestamp
        if (state.lastUpdated && lastUpdatedEl) {
          const date = new Date(state.lastUpdated);
          lastUpdatedEl.textContent = date.toLocaleTimeString();
        }

        // ── Update group summaries ──
        updateGroupSummaries(state);
      }

      function updateGroupSummaries(state) {
        // Session Activity summary
        var actSummary = document.getElementById('session-activity-summary');
        if (actSummary) {
          var parts = [];
          var totalToolCalls = (state.toolAnalytics || []).reduce(function(s, t) { return s + (t.totalCalls || 0); }, 0);
          if (totalToolCalls > 0) parts.push(totalToolCalls + ' tool calls');
          var errorCount = (state.errorDetails || []).reduce(function(s, e) { return s + (e.count || 0); }, 0);
          if (errorCount > 0) parts.push(errorCount + ' error' + (errorCount !== 1 ? 's' : ''));
          var fileCount = state.fileChangeSummary ? (state.fileChangeSummary.totalFilesChanged || 0) : 0;
          if (fileCount > 0) parts.push(fileCount + ' file' + (fileCount !== 1 ? 's' : '') + ' changed');
          actSummary.textContent = parts.length ? parts.join(', ') : '';
        }
        // Activity count badge
        var actBadge = document.getElementById('activity-count-badge');
        if (actBadge) {
          var timelineCount = document.querySelectorAll('#timeline-list .timeline-item').length;
          if (timelineCount > 0 && !(timelineCount === 1 && document.querySelector('#timeline-list .timeline-item .description') && document.querySelector('#timeline-list .timeline-item .description').textContent === 'No activity yet')) {
            actBadge.textContent = timelineCount;
            actBadge.style.display = 'inline';
          }
        }

        // Performance & Cost summary
        var perfSummary = document.getElementById('perf-cost-summary');
        if (perfSummary) {
          var perfParts = [];
          var modelCount = (state.modelBreakdown || []).length;
          if (modelCount > 0) perfParts.push(modelCount + ' model' + (modelCount !== 1 ? 's' : ''));
          var toolCount = (state.toolAnalytics || []).length;
          if (toolCount > 0) perfParts.push(toolCount + ' tool' + (toolCount !== 1 ? 's' : ''));
          if (state.totalCost > 0) perfParts.push(formatCost(state.totalCost));
          perfSummary.textContent = perfParts.length ? perfParts.join(', ') : '';
        }

        // Decisions count badge
        var decBadge = document.getElementById('decisions-count-badge');
        var decSummary = document.getElementById('decisions-summary');
        var decCountEl = document.getElementById('decisions-count');
        if (decCountEl && decBadge) {
          var decText = decCountEl.textContent || '';
          var decMatch = decText.match(/(\d+)/);
          if (decMatch && parseInt(decMatch[1]) > 0) {
            decBadge.textContent = decMatch[1];
            decBadge.style.display = 'inline';
            if (decSummary) decSummary.textContent = decMatch[1] + ' decisions logged';
          }
        }
      }

      // Plan markdown renderer
      function renderPlanMarkdown(raw, steps) {
        const lines = raw.split('\n');
        let html = '';
        let inPhase = false;
        const phasePattern = /^#{2,4}\s+(?:Phase|Step|Stage)\s*\d*[:.](.*)/i;
        const titlePattern = /^#{1,2}\s+(.+)/;
        const headerPattern = /^#{3,4}\s+(.+)/;
        const checkboxPattern = /^[-*]\s+\[([ xX])\]\s+(.+)/;
        const numberedPattern = /^\d+[.)\s]+(.+)/;
        const bulletPattern = /^[-*]\s+(.+)/;

        // Build step lookup by description for status matching
        const stepMap = {};
        for (let si = 0; si < steps.length; si++) {
          stepMap[steps[si].description.toLowerCase().trim()] = steps[si];
        }

        function findStep(desc) {
          const key = desc.toLowerCase().trim();
          if (stepMap[key]) return stepMap[key];
          // Fuzzy: find step whose description is contained in or contains desc
          for (const k in stepMap) {
            if (key.indexOf(k) >= 0 || k.indexOf(key) >= 0) return stepMap[k];
          }
          return null;
        }

        function stepIcon(status) {
          if (status === 'completed') return '\u2713';
          if (status === 'in_progress') return '\u2192';
          if (status === 'failed') return '\u2717';
          if (status === 'skipped') return '\u2013';
          return '\u25CB';
        }

        function stepMeta(s) {
          const parts = [];
          if (s.durationMs) {
            const sec = Math.round(s.durationMs / 1000);
            const min = Math.floor(sec / 60);
            parts.push(min > 0 ? min + 'm ' + (sec % 60) + 's' : sec + 's');
          }
          if (s.tokensUsed) parts.push(s.tokensUsed >= 1000 ? (s.tokensUsed / 1000).toFixed(1) + 'k' : s.tokensUsed + '');
          if (s.toolCalls) parts.push(s.toolCalls + ' calls');
          return parts.length > 0 ? '<span class="plan-md-step-meta">' + parts.join(' \u00B7 ') + '</span>' : '';
        }

        function esc(text) {
          return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        }

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          const trimmed = line.trim();
          if (!trimmed) continue;

          // Phase headers
          const pm = trimmed.match(phasePattern);
          if (pm) {
            if (inPhase) html += '</div>';
            html += '<div class="plan-md-phase"><h2>' + esc(pm[1].trim()) + '</h2>';
            inPhase = true;
            continue;
          }

          // Title headers
          const tm = trimmed.match(titlePattern);
          if (tm && !trimmed.match(phasePattern)) {
            const level = trimmed.indexOf('## ') === 0 ? 'h2' : 'h1';
            html += '<' + level + '>' + esc(tm[1].trim()) + '</' + level + '>';
            continue;
          }

          // Sub-headers
          const hm = trimmed.match(headerPattern);
          if (hm) {
            html += '<h3>' + esc(hm[1].trim()) + '</h3>';
            continue;
          }

          // Checkbox items → match to plan steps
          const cm = trimmed.match(checkboxPattern);
          if (cm) {
            const desc = cm[2].trim();
            const matched = findStep(desc);
            if (matched) {
              html += '<div class="plan-md-step"><span class="plan-md-step-icon">' + stepIcon(matched.status)
                + '</span><span class="plan-md-step-desc">' + esc(desc) + '</span>' + stepMeta(matched) + '</div>';
            } else {
              const chk = cm[1].toLowerCase() === 'x' ? '\u2713' : '\u25CB';
              html += '<div class="plan-md-step"><span class="plan-md-step-icon">' + chk
                + '</span><span class="plan-md-step-desc">' + esc(desc) + '</span></div>';
            }
            continue;
          }

          // Numbered items → match to plan steps
          const nm = trimmed.match(numberedPattern);
          if (nm) {
            const ndesc = nm[1].trim();
            const nmatched = findStep(ndesc);
            if (nmatched) {
              html += '<div class="plan-md-step"><span class="plan-md-step-icon">' + stepIcon(nmatched.status)
                + '</span><span class="plan-md-step-desc">' + esc(ndesc) + '</span>' + stepMeta(nmatched) + '</div>';
            } else {
              html += '<div class="plan-md-step"><span class="plan-md-step-icon">\u25CB</span><span class="plan-md-step-desc">' + esc(ndesc) + '</span></div>';
            }
            continue;
          }

          // Context bullets
          const bm = trimmed.match(bulletPattern);
          if (bm) {
            html += '<div class="plan-md-context">\u2022 ' + esc(bm[1].trim()) + '</div>';
            continue;
          }

          // Plain text (rationale/descriptions)
          html += '<div class="plan-md-text">' + esc(trimmed) + '</div>';
        }

        if (inPhase) html += '</div>';
        return html;
      }

      // Analytics charts (tool frequency + event distribution)
      var toolFreqChart = null;
      var eventDistChart = null;
      var pendingToolFreq = null;
      var pendingEventDist = null;

      function cssVar(name, fallback) {
        return (
          getComputedStyle(document.documentElement).getPropertyValue(name).trim() ||
          fallback ||
          '#888'
        );
      }

      // Chart.js bakes colors into the canvas, so unlike CSS-styled elements
      // these have to be re-read when the theme changes.
      function chartTheme() {
        return {
          tick: cssVar('--sk-chart-tick', '#888'),
          label: cssVar('--sk-chart-label', '#ccc'),
          grid: cssVar('--sk-chart-grid', 'rgba(128,128,128,0.15)')
        };
      }

      var ATTR_VARS_BY_LABEL = dashboardInit.attributionVars;

      function attrColor(label) {
        var name = ATTR_VARS_BY_LABEL[label];
        return name ? cssVar(name, '#abb2bf') : cssVar('--sk-attr-other', '#abb2bf');
      }

      // Replaces string-concatenating an alpha suffix, which silently broke
      // whenever the resolved value was not 6-digit hex.
      function withAlpha(color, alpha) {
        var c = String(color).trim();
        var m = c.match(/^#([0-9a-f]{6})$/i);
        if (m) {
          var n = parseInt(m[1], 16);
          return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + alpha + ')';
        }
        m = c.match(/^rgba?\(([^)]+)\)$/i);
        if (m) {
          var parts = m[1].split(',').map(function (p) { return p.trim(); });
          return 'rgba(' + parts[0] + ',' + parts[1] + ',' + parts[2] + ',' + alpha + ')';
        }
        return c;
      }

      function updateAnalyticsCharts(analytics) {
        if (!analytics) return;

        var summaryParts = [];

        // Tool frequency horizontal bar chart
        var toolFreqSection = document.getElementById('tool-freq-section');
        if (toolFreqSection) {
          var tf = analytics.toolFrequency;
          if (tf && tf.length > 0) {
            toolFreqSection.style.display = '';
            summaryParts.push(tf.length + ' tools');

            var top = tf.slice(0, 10);
            var tfLabels = top.map(function(t) { return t.name; });
            var tfData = top.map(function(t) { return t.count; });

            if (toolFreqChart) {
              toolFreqChart.data.labels = tfLabels;
              toolFreqChart.data.datasets[0].data = tfData;
              toolFreqChart.update('none');
            } else {
              // Defer creation to next frame so container has non-zero dimensions
              pendingToolFreq = { labels: tfLabels, data: tfData };
              requestAnimationFrame(function() {
                if (!pendingToolFreq) return;
                var ptf = pendingToolFreq;
                pendingToolFreq = null;
                var c = document.getElementById('toolFreqChart');
                if (!c || !window.Chart) return;
                var cx = c.getContext('2d');
                if (!cx) return;
                toolFreqChart = new Chart(cx, {
                  type: 'bar',
                  data: {
                    labels: ptf.labels,
                    datasets: [{
                      data: ptf.data,
                      backgroundColor: 'rgba(75, 192, 192, 0.7)',
                      borderColor: 'rgba(75, 192, 192, 1)',
                      borderWidth: 1
                    }]
                  },
                  options: {
                    indexAxis: 'y',
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: {
                      legend: { display: false },
                      tooltip: { enabled: true }
                    },
                    scales: {
                      x: {
                        beginAtZero: true,
                        ticks: { color: cssVar('--vscode-descriptionForeground'), font: { size: 10 } },
                        grid: { color: 'rgba(128,128,128,0.15)' }
                      },
                      y: {
                        ticks: { color: cssVar('--vscode-foreground'), font: { size: 10 } },
                        grid: { display: false }
                      }
                    }
                  }
                });
              });
            }
          } else {
            toolFreqSection.style.display = 'none';
          }
        }

        // Event type distribution doughnut chart
        var eventDistSection = document.getElementById('event-dist-section');
        if (eventDistSection) {
          var wf = analytics.wordFrequency;
          if (wf && wf.length > 0) {
            eventDistSection.style.display = '';

            var topWords = wf.slice(0, 8);
            var wLabels = topWords.map(function(w) { return w.name; });
            var wData = topWords.map(function(w) { return w.count; });
            var wColors = [
              'rgba(75, 192, 192, 0.7)',
              'rgba(54, 162, 235, 0.7)',
              'rgba(255, 206, 86, 0.7)',
              'rgba(153, 102, 255, 0.7)',
              'rgba(255, 99, 132, 0.7)',
              'rgba(255, 159, 64, 0.7)',
              'rgba(75, 192, 75, 0.7)',
              'rgba(201, 203, 207, 0.7)'
            ];

            if (eventDistChart) {
              eventDistChart.data.labels = wLabels;
              eventDistChart.data.datasets[0].data = wData;
              eventDistChart.data.datasets[0].backgroundColor = wColors.slice(0, wLabels.length);
              eventDistChart.update('none');
            } else {
              // Defer creation to next frame so container has non-zero dimensions
              pendingEventDist = { labels: wLabels, data: wData, colors: wColors };
              requestAnimationFrame(function() {
                if (!pendingEventDist) return;
                var ped = pendingEventDist;
                pendingEventDist = null;
                var dc = document.getElementById('eventDistChart');
                if (!dc || !window.Chart) return;
                var dcx = dc.getContext('2d');
                if (!dcx) return;
                eventDistChart = new Chart(dcx, {
                  type: 'doughnut',
                  data: {
                    labels: ped.labels,
                    datasets: [{
                      data: ped.data,
                      backgroundColor: ped.colors.slice(0, ped.labels.length),
                      borderWidth: 0
                    }]
                  },
                  options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: {
                      legend: {
                        position: 'right',
                        labels: {
                          color: cssVar('--vscode-foreground'),
                          font: { size: 10 },
                          boxWidth: 10
                        }
                      },
                      tooltip: { enabled: true }
                    }
                  }
                });
              });
            }
          } else {
            eventDistSection.style.display = 'none';
          }
        }

        // Activity heatmap (CSS grid of colored cells)
        var heatmapSection = document.getElementById('heatmap-section');
        if (heatmapSection) {
          var buckets = analytics.heatmapBuckets;
          if (buckets && buckets.length > 0) {
            heatmapSection.style.display = '';

            var maxCount = 0;
            var totalEvents = 0;
            var activeMins = 0;
            for (var bi = 0; bi < buckets.length; bi++) {
              if (buckets[bi].count > maxCount) maxCount = buckets[bi].count;
              totalEvents += buckets[bi].count;
              if (buckets[bi].count > 0) activeMins++;
            }

            var gridEl = document.getElementById('heatmap-grid');
            if (gridEl) {
              var cellsHtml = '';
              for (var ci = 0; ci < buckets.length; ci++) {
                var b = buckets[ci];
                var intensity = maxCount > 0 ? b.count / maxCount : 0;
                var alpha = Math.max(0.08, intensity * 0.9 + 0.1);
                var bgColor = 'rgba(75, 192, 192, ' + alpha.toFixed(2) + ')';
                if (b.count === 0) bgColor = 'rgba(128, 128, 128, 0.1)';
                var time = b.timestamp ? new Date(b.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
                cellsHtml += '<div class="heatmap-cell" style="background:' + bgColor + ';" title="' + time + ': ' + b.count + ' events"></div>';
              }
              gridEl.innerHTML = '<div class="heatmap-grid">' + cellsHtml + '</div>';
            }

            var statsEl = document.getElementById('heatmap-stats');
            if (statsEl) {
              statsEl.textContent = 'Peak: ' + maxCount + '/min · Total: ' + totalEvents + ' · Active: ' + activeMins + '/' + buckets.length + ' min';
            }

            summaryParts.push(activeMins + ' active min');
          } else {
            heatmapSection.style.display = 'none';
          }
        }

        // Event patterns
        var patternsSection = document.getElementById('patterns-section');
        if (patternsSection) {
          var patterns = analytics.patterns;
          if (patterns && patterns.length > 0) {
            patternsSection.style.display = '';
            summaryParts.push(patterns.length + ' patterns');

            var topPatterns = patterns.slice(0, 8);
            var pMaxCount = topPatterns[0] ? topPatterns[0].count : 1;
            var pListEl = document.getElementById('patterns-list');
            if (pListEl) {
              var pHtml = '';
              for (var pi = 0; pi < topPatterns.length; pi++) {
                var p = topPatterns[pi];
                var pPct = Math.round((p.count / pMaxCount) * 100);
                var barW = Math.max(4, Math.round(pPct * 0.6));
                pHtml += '<div class="pattern-item">'
                  + '<div class="pattern-bar" style="width:' + barW + 'px;"></div>'
                  + '<span class="pattern-count">' + p.count + '</span>'
                  + '<span class="pattern-template">' + escapeForHtml(p.template) + '</span>'
                  + '</div>';
                if (p.examples && p.examples.length > 0) {
                  pHtml += '<div class="pattern-example">e.g. ' + escapeForHtml(p.examples[0].substring(0, 60)) + '</div>';
                }
              }
              pListEl.innerHTML = pHtml;
            }
          } else {
            patternsSection.style.display = 'none';
          }
        }

        // Update group summary
        var analyticsSummary = document.getElementById('analytics-summary');
        if (analyticsSummary) {
          analyticsSummary.textContent = summaryParts.join(' · ');
        }
      }

      function escapeForHtml(text) {
        if (!text) return '';
        return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
      }

      // Plan view toggle
      let planViewShowing = 'steps'; // 'steps' | 'details'
      const pvToggle = document.getElementById('plan-view-toggle');
      if (pvToggle) {
        pvToggle.addEventListener('click', function() {
          const stepsList = document.getElementById('plan-steps-list');
          const mdView = document.getElementById('plan-markdown-view');
          if (!stepsList || !mdView) return;
          if (planViewShowing === 'steps') {
            stepsList.style.display = 'none';
            mdView.style.display = 'block';
            pvToggle.textContent = 'Show Steps';
            planViewShowing = 'details';
          } else {
            stepsList.style.display = '';
            mdView.style.display = 'none';
            pvToggle.textContent = 'Show Details';
            planViewShowing = 'steps';
          }
        });
      }

      function updateContextHealthDisplay(score, compactionCount) {
        const el = document.getElementById('context-health');
        if (!el) return;
        const color = score >= 70
          ? 'var(--vscode-charts-green, #4ec9b0)'
          : score >= 40
            ? 'var(--vscode-charts-yellow, #cca700)'
            : 'var(--vscode-charts-red, #f14c4c)';
        el.innerHTML = '<span class="sk-context-health-score" style="color:' + color + '">' +
          Math.round(score) + '%</span><span class="sk-context-health-note"> · ' +
          compactionCount + ' compaction' + (compactionCount === 1 ? '' : 's') + '</span>';
        el.style.display = 'flex';
      }

      function updateTruncationDisplay(count, byTool) {
        const el = document.getElementById('truncation-info');
        if (!el) return;
        if (!count) {
          el.style.display = 'none';
          el.innerHTML = '';
          return;
        }
        const breakdown = (byTool || []).map(function(item) {
          return escapeHtml(item.tool) + ': ' + item.count;
        }).join(', ');
        el.innerHTML = '<span class="sk-truncation-warning">⚠ ' + count + ' truncated</span>' +
          (breakdown ? '<span class="sk-context-health-note"> (' + breakdown + ')</span>' : '');
        el.style.display = 'flex';
      }

      function quotaHistoryBucket(utilization) {
        if (utilization <= 0) return 0;
        if (utilization < 25) return 1;
        if (utilization < 50) return 2;
        if (utilization < 75) return 3;
        return 4;
      }

      function renderQuotaHistoryGrid(cells, weeks) {
        const ns = 'http://www.w3.org/2000/svg';
        const size = 11;
        const gap = 2;
        const rows = 7;
        const cols = weeks;
        const total = rows * cols;
        const padded = new Array(Math.max(0, total - cells.length)).fill(null).concat(cells.slice(-total));
        const svg = document.createElementNS(ns, 'svg');
        svg.setAttribute('class', 'quota-history-grid');
        svg.setAttribute('viewBox', '0 0 ' + (cols * (size + gap) - gap) + ' ' + (rows * (size + gap) - gap));
        svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
        svg.setAttribute('role', 'img');
        padded.forEach(function(cell, index) {
          const rect = document.createElementNS(ns, 'rect');
          rect.setAttribute('x', String(Math.floor(index / rows) * (size + gap)));
          rect.setAttribute('y', String((index % rows) * (size + gap)));
          rect.setAttribute('width', String(size));
          rect.setAttribute('height', String(size));
          rect.setAttribute('rx', '2');
          rect.setAttribute('class', !cell
            ? 'quota-history-cell bucket-0'
            : cell.unavailable && cell.samples > 0
              ? 'quota-history-cell unavailable'
              : 'quota-history-cell bucket-' + quotaHistoryBucket(cell.utilization));
          if (cell) {
            const title = document.createElementNS(ns, 'title');
            title.textContent = cell.date + (cell.unavailable
              ? ' · unavailable'
              : cell.samples === 0
                ? ' · no samples'
                : ' · peak ' + Math.round(cell.utilization) + '% · ' + cell.samples + ' sample' + (cell.samples === 1 ? '' : 's'));
            rect.appendChild(title);
          }
          svg.appendChild(rect);
        });
        return svg;
      }

      function renderQuotaHistory(payload) {
        const section = document.getElementById('quota-history-section');
        const body = document.getElementById('quota-history-body');
        if (!section || !body) return;
        const entries = [];
        if (payload && payload.providers && payload.providers.claude) entries.push(['Claude', payload.providers.claude.cells]);
        if (payload && payload.providers && payload.providers.codex) entries.push(['Codex', payload.providers.codex.cells]);
        body.innerHTML = '';
        entries.forEach(function(entry) {
          const row = document.createElement('div');
          row.className = 'quota-history-provider';
          const label = document.createElement('div');
          label.className = 'quota-history-provider-label';
          label.textContent = entry[0];
          row.appendChild(label);
          row.appendChild(renderQuotaHistoryGrid(entry[1], payload.weeks));
          body.appendChild(row);
        });
        section.style.display = entries.length > 0 ? 'block' : 'none';
      }

      // Handle messages from extension
      window.addEventListener('message', function(event) {
        const message = event.data;

        switch (message.type) {
          case 'updateStats':
            updateDashboard(message.state);
            break;

          case 'themeChanged':
            applyChartTheme();
            break;

          case 'updateToolAnalytics':
            updateToolAnalytics(message.analytics);
            break;

          case 'updateTimeline':
            updateTimeline(message.events);
            break;

          case 'sessionStart':
            statusEl.textContent = 'Active';
            statusEl.className = 'status active';
            break;

          case 'sessionEnd':
            statusEl.textContent = 'Ended';
            statusEl.className = 'status inactive';
            break;

          case 'updateBurnRate':
            sessionState.burnRate = Math.round(message.burnRate);
            if (message.sessionStartTime) {
              const start = new Date(message.sessionStartTime);
              const now = new Date();
              const minutes = Math.floor((now - start) / 60000);
              const hours = Math.floor(minutes / 60);
              const mins = minutes % 60;
              sessionState.sessionDuration = hours > 0 ? hours + 'h ' + mins + 'm' : mins + 'm';
            }
            updateInlineStats();
            break;

          case 'updateSessionList':
            updateSessionList(message.groups, message.isPinned, message.isUsingCustomPath, message.customPathDisplay);
            break;

          case 'sessionsLoading':
            if (message.loading && sessionListEl) {
              sessionListEl.innerHTML = '<div class="session-list-loading">' +
                '<span class="session-list-spinner"></span>' +
                'Loading sessions…' +
                '</div>';
            }
            break;

          case 'updateSessionProvider':
            updateProviderDisplay(message.providerId, message.displayName);
            break;

          case 'updateHistoricalData':
            if (historyLoading) historyLoading.style.display = 'none';
            updateHistoryChart(message.data);
            break;

          case 'historicalDataLoading':
            if (historyLoading) historyLoading.style.display = message.loading ? 'block' : 'none';
            break;

          case 'updateQuota':
            updateQuota(message.quota, message.quotaFailure);
            break;

          case 'updateQuotaHistory':
            renderQuotaHistory(message.payload);
            break;

          case 'updateBillingBlock':
            updateBillingBlock(message.block, message.official);
            break;

          case 'updateContextHealth':
            updateContextHealthDisplay(message.score, message.compactionCount);
            break;

          case 'updateTruncations':
            updateTruncationDisplay(message.count, message.byTool);
            break;

          case 'notification':
            showQuotaToast(message.title, message.body, message.severity);
            break;

          case 'updateProviderStatus':
            updateProviderStatus(message.display);
            break;

          case 'updateOpenAIStatus':
            updateOpenAIStatus(message.display);
            break;

          case 'updatePeakHours':
            updatePeakHours(message.status);
            break;

          case 'updateLatency':
            updateLatency(message.latency);
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

          case 'updateSessionSummary':
            renderSessionSummary(message.summary);
            break;

          case 'updateHealth':
            helpers.health.render(message.data);
            break;

          case 'healthLoading':
            helpers.health.setLoading(message.loading);
            break;

          case 'showTab': {
            const tabButton = document.querySelector('.tab-btn[data-tab="' + message.tab + '"]');
            if (tabButton) tabButton.click();
            break;
          }

          case 'updateTaskPerformance':
            renderTaskPerformance(message.data);
            break;

          case 'updateCacheEffectiveness':
            renderCacheEffectiveness(message.data);
            break;

          case 'updateRecoveryPatterns':
            renderRecoveryPatterns(message.data);
            break;

          case 'updateDecisions':
            renderDecisions(message.decisions, message.totalCount);
            break;

          case 'updateAdvancedBurnRate':
            renderAdvancedBurnRate(message.data);
            break;

          case 'updateToolEfficiency':
            renderToolEfficiency(message.data);
            break;

          case 'sessionNarrative': {
            const narrativeEl = document.getElementById('narrative-display');
            const narrativeErrEl = document.getElementById('narrative-error');
            if (narrativeEl) {
              narrativeEl.textContent = message.narrative;
              narrativeEl.style.display = 'block';
            }
            if (narrativeErrEl) narrativeErrEl.style.display = 'none';
            break;
          }

          case 'narrativeLoading': {
            const narrBtn = document.getElementById('generate-narrative-btn');
            const narrSpinner = document.getElementById('narrative-loading');
            if (narrBtn) {
              narrBtn.disabled = message.loading;
              narrBtn.textContent = message.loading ? 'Generating...' : 'Generate AI Narrative';
            }
            if (narrSpinner) {
              narrSpinner.style.display = message.loading ? 'flex' : 'none';
            }
            break;
          }

          case 'narrativeError': {
            const narrErrEl = document.getElementById('narrative-error');
            if (narrErrEl) {
              narrErrEl.textContent = message.error;
              narrErrEl.style.display = 'block';
            }
            break;
          }

          case 'updateCompactions':
            updateCompactions(message.compactions);
            break;

          case 'updateContextAttribution':
            updateContextAttribution(message.attribution);
            break;

          case 'toolCallDetails':
            renderToolCallDetails(message.toolName, message.calls);
            break;

          case 'updateTurnAttributions':
            updateTurnAttributions(message.turns);
            break;

          case 'updateContextWaterfall':
            updateContextWaterfall(message.waterfall);
            break;

          case 'updateNotificationHistory':
            updateNotificationHistory(message.notifications, message.unreadCount);
            break;

          case 'syncEventLogState': {
            const elToggle = document.getElementById('event-log-toggle');
            if (elToggle) elToggle.checked = message.enabled;
            break;
          }

          case 'updatePhrase': {
            const headerPhrase = document.getElementById('header-phrase');
            if (headerPhrase) headerPhrase.textContent = message.phrase;
            break;
          }

          case 'updateEmptyPhrase': {
            const emptyPhrase = document.getElementById('empty-state-phrase');
            if (emptyPhrase) emptyPhrase.textContent = message.phrase;
            break;
          }

          case 'updatePlan': {
            const planSection = document.getElementById('plan-section');
            if (!planSection) break;
            const plan = message.plan;
            if (!plan || !plan.steps || plan.steps.length === 0) {
              planSection.style.display = 'none';
              break;
            }
            planSection.style.display = '';

            const planTitle = document.getElementById('plan-title');
            if (planTitle) planTitle.textContent = plan.title || 'Plan';

            const planFill = document.getElementById('plan-progress-fill');
            if (planFill) {
              const pct = Math.round((plan.completionRate || 0) * 100);
              planFill.style.width = pct + '%';
            }

            const planStats = document.getElementById('plan-stats');
            if (planStats) {
              const completed = plan.steps.filter(function(s) { return s.status === 'completed'; }).length;
              const total = plan.steps.length;
              const statParts = [completed + '/' + total + ' steps'];
              if (plan.completionRate != null) statParts[0] += ' (' + Math.round(plan.completionRate * 100) + '%)';
              if (plan.totalDurationMs) {
                const durSec = Math.round(plan.totalDurationMs / 1000);
                const durMin = Math.floor(durSec / 60);
                const durRemSec = durSec % 60;
                statParts.push(durMin > 0 ? durMin + 'm ' + durRemSec + 's' : durSec + 's');
              }
              const totalTokens = plan.steps.reduce(function(sum, s) { return sum + (s.tokensUsed || 0); }, 0);
              if (totalTokens > 0) {
                statParts.push(totalTokens >= 1000 ? (totalTokens / 1000).toFixed(1) + 'k tokens' : totalTokens + ' tokens');
              }
              planStats.textContent = statParts.join(' · ');
            }

            const planStepsList = document.getElementById('plan-steps-list');
            if (planStepsList) {
              let stepsHtml = '';
              for (let si = 0; si < plan.steps.length; si++) {
                const step = plan.steps[si];
                let icon = '○';
                let statusClass = 'pending';
                if (step.status === 'completed') { icon = '✓'; statusClass = 'completed'; }
                else if (step.status === 'in_progress') { icon = '→'; statusClass = 'in_progress'; }
                else if (step.status === 'failed') { icon = '✗'; statusClass = 'failed'; }
                else if (step.status === 'skipped') { icon = '–'; statusClass = 'skipped'; }

                const metaParts = [];
                if (step.durationMs) {
                  const sSec = Math.round(step.durationMs / 1000);
                  const sMin = Math.floor(sSec / 60);
                  const sRemSec = sSec % 60;
                  metaParts.push(sMin > 0 ? sMin + 'm ' + sRemSec + 's' : sSec + 's');
                }
                if (step.tokensUsed) {
                  metaParts.push(step.tokensUsed >= 1000 ? (step.tokensUsed / 1000).toFixed(1) + 'k' : step.tokensUsed + '');
                }
                if (step.toolCalls) metaParts.push(step.toolCalls + ' calls');
                if (step.complexity) metaParts.push(step.complexity);

                const metaHtml = metaParts.length > 0 ? '<span class="plan-step-meta">' + metaParts.join(' · ') + '</span>' : '';
                const errorHtml = step.errorMessage ? '<div style="color: var(--vscode-charts-red, #f14c4c); font-size: 10px; margin-left: 20px;">' + escapeHtml(step.errorMessage.substring(0, 100)) + '</div>' : '';

                stepsHtml += '<div class="plan-step-item ' + statusClass + '">'
                  + '<span class="plan-step-icon">' + icon + '</span>'
                  + '<span class="plan-step-desc">' + escapeHtml(step.description) + '</span>'
                  + metaHtml
                  + '</div>'
                  + errorHtml;
              }
              planStepsList.innerHTML = stepsHtml;
            }

            // Render raw markdown view if available
            const planViewToggle = document.getElementById('plan-view-toggle');
            const planMarkdownView = document.getElementById('plan-markdown-view');
            if (planViewToggle && planMarkdownView) {
              if (plan.rawMarkdown) {
                planViewToggle.style.display = '';
                planMarkdownView.innerHTML = renderPlanMarkdown(plan.rawMarkdown, plan.steps);
              } else {
                planViewToggle.style.display = 'none';
                planMarkdownView.style.display = 'none';
                planMarkdownView.innerHTML = '';
              }
            }
            break;
          }

          case 'updatePlanHistory': {
            const phSection = document.getElementById('plan-history-section');
            if (!phSection) break;
            const history = message.history;
            if (!history || history.totalPlans === 0) {
              phSection.style.display = 'none';
              break;
            }
            phSection.style.display = '';

            const phStats = document.getElementById('plan-history-stats');
            if (phStats) {
              const phParts = [
                history.totalPlans + ' plans',
                history.completedPlans + ' completed',
                Math.round(history.avgCompletionRate * 100) + '% avg completion'
              ];
              if (history.avgDurationMs > 0) {
                const dSec = Math.round(history.avgDurationMs / 1000);
                const dMin = Math.floor(dSec / 60);
                phParts.push('avg ' + (dMin > 0 ? dMin + 'm' : dSec + 's'));
              }
              if (history.avgTokensPerPlan > 0) {
                phParts.push('avg ' + (history.avgTokensPerPlan >= 1000 ? (history.avgTokensPerPlan / 1000).toFixed(1) + 'k' : Math.round(history.avgTokensPerPlan)) + ' tokens');
              }
              phStats.textContent = phParts.join(' · ');
            }

            const phList = document.getElementById('plan-history-list');
            if (phList && history.recentPlans) {
              let phHtml = '';
              for (let pi = 0; pi < history.recentPlans.length; pi++) {
                const rp = history.recentPlans[pi];
                const PLAN_STATUS_ICONS = { completed: '✓', failed: '✗', abandoned: '–' };
                const rpIcon = PLAN_STATUS_ICONS[rp.status] || '→';
                const rpPct = Math.round(rp.completionRate * 100);
                const rpDate = new Date(rp.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
                phHtml += '<div class="plan-step-item ' + rp.status + '">'
                  + '<span class="plan-step-icon">' + rpIcon + '</span>'
                  + '<span class="plan-step-desc">' + escapeHtml(rp.title) + '</span>'
                  + '<span class="plan-step-meta">' + rpPct + '% · ' + rp.stepCount + ' steps · ' + rpDate + '</span>'
                  + '</div>';
              }
              phList.innerHTML = phHtml;
            }
            break;
          }

          case 'updateAnalytics': {
            var analytics = message.analytics;
            updateAnalyticsCharts(analytics);
            break;
          }
        }
      });

      // Timeline search input handler (debounced)
      let searchTimer = null;
      const searchInput = document.getElementById('timeline-search');
      if (searchInput) {
        searchInput.addEventListener('input', function() {
          if (searchTimer) clearTimeout(searchTimer);
          searchTimer = setTimeout(function() {
            const query = searchInput.value.trim();
            if (query.length > 0) {
              // Request all events from extension for search
              vscode.postMessage({ type: 'searchTimeline', query: query });
            } else {
              // Clear search - re-render with current events
              renderFilteredTimeline();
            }
          }, 300);
        });
      }

      // Timeline filter checkbox handlers
      const filtersEl = document.getElementById('timeline-filters');
      if (filtersEl) {
        filtersEl.querySelectorAll('input[type="checkbox"]').forEach(function(cb) {
          cb.addEventListener('change', function() {
            const filterName = cb.getAttribute('data-filter');
            if (filterName === 'user') timelineFilters.showUser = cb.checked;
            if (filterName === 'ai') timelineFilters.showAi = cb.checked;
            if (filterName === 'system') {
              timelineFilters.showSystem = cb.checked;
              timelineFilters.showSidechain = cb.checked;
            }
            renderFilteredTimeline();
          });
        });
      }

      // Event log toggle handler
      const eventLogToggle = document.getElementById('event-log-toggle');
      if (eventLogToggle) {
        eventLogToggle.addEventListener('change', function() {
          vscode.postMessage({ type: 'toggleEventLog', enabled: eventLogToggle.checked });
        });
      }

      // Session navigator event handlers
      if (sessionListEl) {
        sessionListEl.addEventListener('click', function(e) {
          let target = e.target;
          while (target && target !== sessionListEl) {
            if (target.classList && target.classList.contains('session-card')) {
              const sessionPath = target.getAttribute('data-path');
              if (sessionPath) {
                vscode.postMessage({ type: 'selectSession', sessionPath: sessionPath });
              }
              return;
            }
            target = target.parentElement;
          }
        });
      }

      if (pinSessionBtn) {
        pinSessionBtn.addEventListener('click', function(e) {
          e.stopPropagation();
          vscode.postMessage({ type: 'togglePin' });
        });
      }

      if (refreshSessionsBtn) {
        refreshSessionsBtn.addEventListener('click', function(e) {
          e.stopPropagation();
          vscode.postMessage({ type: 'refreshSessions' });
        });
      }

      if (sessionProviderSelect) {
        sessionProviderSelect.addEventListener('change', function() {
          const nextProvider = sessionProviderSelect.value;
          if (nextProvider && nextProvider !== currentProviderId) {
            const providerLabel = sessionProviderSelect.options[sessionProviderSelect.selectedIndex].text;
            if (sessionListEl) {
              sessionListEl.innerHTML = '<div class="session-list-loading">' +
                '<span class="session-list-spinner"></span>' +
                'Loading ' + escapeHtml(providerLabel) + ' sessions…' +
                '</div>';
            }
            vscode.postMessage({ type: 'setSessionProvider', providerId: nextProvider });
          }
        });
      }

      if (browseFoldersBtn) {
        browseFoldersBtn.addEventListener('click', function(e) {
          e.stopPropagation();
          vscode.postMessage({ type: 'browseSessionFolders' });
        });
      }

      if (openCliDashboardBtn) {
        openCliDashboardBtn.addEventListener('click', function(e) {
          e.stopPropagation();
          vscode.postMessage({ type: 'openCliDashboard' });
        });
      }

      if (resetCustomPath) {
        resetCustomPath.addEventListener('click', function() {
          vscode.postMessage({ type: 'clearCustomPath' });
        });
      }

      // Import historical data button
      const importHistoricalBtn = document.getElementById('import-historical-btn');
      if (importHistoricalBtn) {
        importHistoricalBtn.addEventListener('click', function() {
          vscode.postMessage({ type: 'importHistoricalData' });
        });
      }

      // Initialize charts and signal ready
      try {
        initContextGauge();
        initQuotaGauges();
        initHistoryChart();
      } catch (chartErr) {
        // Chart init failure should not block session list
      }

      // Set up event listeners for CLAUDE.md suggestions (CSP blocks inline onclick)
      const suggestionsPanel = document.getElementById('suggestions-panel');
      const suggestionsHeader = document.getElementById('suggestions-header');
      const analyzeBtn = document.getElementById('analyze-btn');

      if (suggestionsHeader && suggestionsPanel) {
        suggestionsHeader.addEventListener('click', function(e) {
          // Don't toggle if clicking the analyze button
          if (analyzeBtn && (e.target === analyzeBtn || analyzeBtn.contains(e.target))) {
            return;
          }
          suggestionsPanel.classList.toggle('expanded');
        });
      }

      if (analyzeBtn) {
        analyzeBtn.addEventListener('click', function(e) {
          e.stopPropagation(); // Prevent header toggle
          // Auto-expand when analyzing
          if (suggestionsPanel) {
            suggestionsPanel.classList.add('expanded');
          }
          vscode.postMessage({ type: 'analyzeSession' });
        });
      }

      // Set up handoff button
      const handoffBtn = document.getElementById('generate-handoff-btn');
      if (handoffBtn) {
        handoffBtn.addEventListener('click', function() {
          vscode.postMessage({ type: 'generateHandoff' });
        });
      }

      // Notification history buttons
      const markAllReadBtn = document.getElementById('mark-all-read-btn');
      if (markAllReadBtn) {
        markAllReadBtn.addEventListener('click', function() {
          vscode.postMessage({ type: 'markAllNotificationsRead' });
        });
      }
      const clearNotificationsBtn = document.getElementById('clear-notifications-btn');
      if (clearNotificationsBtn) {
        clearNotificationsBtn.addEventListener('click', function() {
          vscode.postMessage({ type: 'clearNotificationHistory' });
        });
      }

      // Request notification history on load
      vscode.postMessage({ type: 'requestNotificationHistory' });

      // ==== Collapsible panel toggles ====
      document.querySelectorAll('[data-collapsible="true"]').forEach(function(header) {
        header.addEventListener('click', function() {
          header.parentElement.classList.toggle('expanded');
        });
      });

      // ==== Summary tab + Richer panels ====

      const narrativeBtn = document.getElementById('generate-narrative-btn');
      if (narrativeBtn) {
        narrativeBtn.addEventListener('click', function() {
          vscode.postMessage({ type: 'generateNarrative' });
        });
      }

      function formatDurationMs(ms) {
        const sec = Math.floor(ms / 1000);
        if (sec < 60) return sec + 's';
        const min = Math.floor(sec / 60);
        const hours = Math.floor(min / 60);
        if (hours > 0) return hours + 'h ' + (min % 60) + 'm';
        return min + 'm';
      }

      function renderSessionSummary(summary) {
        const empty = document.getElementById('summary-empty');
        const content = document.getElementById('summary-content');
        if (!content) return;

        if (empty) empty.style.display = 'none';
        content.style.display = 'block';

        // Metric cards
        const durEl = document.getElementById('sum-duration');
        const tokEl = document.getElementById('sum-tokens');
        const costEl = document.getElementById('sum-cost');
        const apiEl = document.getElementById('sum-api-calls');
        const ctxEl = document.getElementById('sum-context');
        const compEl = document.getElementById('sum-completion');

        if (durEl) durEl.textContent = formatDurationMs(summary.duration);
        if (tokEl) tokEl.textContent = formatNumber(summary.totalTokens);
        if (costEl) costEl.textContent = formatCost(summary.totalCost);
        if (apiEl) apiEl.textContent = formatNumber(summary.apiCalls);
        if (ctxEl) ctxEl.textContent = Math.round(summary.contextPeak) + '%';
        if (compEl) compEl.textContent = Math.round(summary.taskCompletionRate * 100) + '%';

        // Tasks table
        const tasksEl = document.getElementById('sum-tasks-content');
        if (tasksEl) {
          if (summary.tasks.length === 0) {
            tasksEl.innerHTML = '<div style="color:var(--vscode-descriptionForeground);font-size:11px;">No tasks tracked</div>';
          } else {
            let html = '<table class="summary-task-table"><tr><th>Task</th><th>Status</th><th>Duration</th><th>Tools</th></tr>';
            summary.tasks.forEach(function(t) {
              html += '<tr><td>' + escapeHtml(t.subject) + '</td>' +
                '<td><span class="status-icon ' + t.status + '"></span>' + t.status + '</td>' +
                '<td>' + formatDurationMs(t.duration) + '</td>' +
                '<td>' + t.toolCallCount + '</td></tr>';
            });
            html += '</table>';
            tasksEl.innerHTML = html;
          }
        }

        // Files table
        const filesEl = document.getElementById('sum-files-content');
        if (filesEl) {
          if (summary.filesChanged.length === 0) {
            filesEl.innerHTML = '<div style="color:var(--vscode-descriptionForeground);font-size:11px;">No files changed</div>';
          } else {
            let fhtml = '<div style="margin-bottom:6px;font-size:11px;">' + summary.totalFilesChanged + ' files | <span style="color:var(--vscode-charts-green,#4caf50)">+' + summary.totalAdditions + '</span> / <span style="color:var(--vscode-charts-red,#f44336)">-' + summary.totalDeletions + '</span> · ' + (summary.codeImpact.costPerChangedLine == null ? '—' : formatCost(summary.codeImpact.costPerChangedLine)) + '/line</div>';
            fhtml += '<table class="summary-file-table"><tr><th>File</th><th>+/-</th></tr>';
            summary.filesChanged.slice(0, 15).forEach(function(f) {
              fhtml += '<tr><td style="font-family:var(--vscode-editor-font-family)">' + escapeHtml(f.path) + '</td>' +
                '<td><span style="color:var(--vscode-charts-green,#4caf50)">+' + f.additions + '</span>/<span style="color:var(--vscode-charts-red,#f44336)">-' + f.deletions + '</span></td></tr>';
            });
            fhtml += '</table>';
            filesEl.innerHTML = fhtml;
          }
        }

        // Cost breakdown
        const costContentEl = document.getElementById('sum-cost-content');
        if (costContentEl) {
          let chtml = '';
          if (summary.costByModel.length > 0) {
            chtml += '<div style="font-size:11px;font-weight:600;margin-bottom:4px;">By Model</div>';
            chtml += '<table class="summary-cost-table"><tr><th>Model</th><th>Cost</th><th>%</th></tr>';
            summary.costByModel.forEach(function(m) {
              const impact = summary.codeImpact.byModel.find(function(row) { return row.model === m.model; });
              chtml += '<tr><td>' + escapeHtml(getShortModelName(m.model)) + '</td><td>' + formatCost(m.cost) + (impact && impact.costPerChangedLine != null ? ' (' + formatCost(impact.costPerChangedLine) + '/line)' : '') + '</td><td>' + Math.round(m.percentage) + '%</td></tr>';
            });
            chtml += '</table>';
          }
          if (summary.costByTool.length > 0) {
            chtml += '<div style="font-size:11px;font-weight:600;margin:8px 0 4px;">By Tool (estimated)</div>';
            chtml += '<table class="summary-cost-table"><tr><th>Tool</th><th>Cost</th><th>Calls</th></tr>';
            summary.costByTool.slice(0, 8).forEach(function(t) {
              chtml += '<tr><td>' + escapeHtml(t.tool) + '</td><td>' + formatCost(t.estimatedCost) + '</td><td>' + t.calls + '</td></tr>';
            });
            chtml += '</table>';
          }
          costContentEl.innerHTML = chtml || '<div style="color:var(--vscode-descriptionForeground);font-size:11px;">No cost data</div>';
        }

        // Errors & Recovery
        const errEl = document.getElementById('sum-errors-content');
        if (errEl) {
          if (summary.errors.length === 0) {
            errEl.innerHTML = '<div style="color:var(--vscode-descriptionForeground);font-size:11px;">No errors</div>';
          } else {
            let ehtml = '<div style="font-size:11px;margin-bottom:6px;">Recovery rate: <strong>' + Math.round(summary.recoveryRate * 100) + '%</strong></div>';
            summary.errors.forEach(function(e) {
              ehtml += '<div style="font-size:11px;padding:4px 0;border-bottom:1px solid var(--vscode-panel-border);">' +
                '<span style="font-weight:500;">' + escapeHtml(e.category) + '</span>: ' + e.count +
                (e.recovered ? ' <span style="color:var(--vscode-charts-green,#4caf50);">(recovered)</span>' : '') + '</div>';
            });
            errEl.innerHTML = ehtml;
          }
        }
      }

      function renderTaskPerformance(data) {
        const section = document.getElementById('task-perf-section');
        const body = document.getElementById('task-perf-body');
        if (!section || !body) return;

        if (data.totalTasks === 0) {
          section.style.display = 'none';
          return;
        }
        section.style.display = 'block';

        let html = '<div class="panel-metrics-row">' +
          '<div class="panel-metric-card"><div class="val">' + Math.round(data.completionRate * 100) + '%</div><div class="lbl">Completion</div></div>' +
          '<div class="panel-metric-card"><div class="val">' + data.completedTasks + '/' + data.totalTasks + '</div><div class="lbl">Tasks</div></div>' +
          '</div>';

        if (data.tasks.length > 0) {
          html += '<table class="summary-task-table"><tr><th>Task</th><th>Status</th><th>Tools</th></tr>';
          data.tasks.forEach(function(t) {
            html += '<tr><td>' + escapeHtml(t.subject) + '</td>' +
              '<td><span class="status-icon ' + t.status + '"></span>' + t.status + '</td>' +
              '<td>' + t.toolCallCount + '</td></tr>';
          });
          html += '</table>';
        }
        body.innerHTML = html;
      }

      function renderCacheEffectiveness(data) {
        const section = document.getElementById('cache-eff-section');
        const body = document.getElementById('cache-eff-body');
        if (!section || !body) return;

        if (data.cacheReadTokens === 0 && data.cacheWriteTokens === 0) {
          section.style.display = 'none';
          return;
        }
        section.style.display = 'block';

        body.innerHTML = '<div class="panel-metrics-row">' +
          '<div class="panel-metric-card"><div class="val">' + Math.round(data.cacheHitRate * 100) + '%</div><div class="lbl">Cache Hit Rate</div></div>' +
          '<div class="panel-metric-card"><div class="val">' + formatNumber(data.estimatedTokensSaved) + '</div><div class="lbl">Tokens Saved</div></div>' +
          '<div class="panel-metric-card"><div class="val">' + formatCost(data.estimatedCostSaved) + '</div><div class="lbl">Cost Saved</div></div>' +
          '<div class="panel-metric-card"><div class="val">' + formatNumber(data.cacheWriteTokens) + '</div><div class="lbl">Cache Writes</div></div>' +
          '</div>';
      }

      function renderRecoveryPatterns(data) {
        const section = document.getElementById('recovery-section');
        const body = document.getElementById('recovery-body');
        if (!section || !body) return;

        if (data.patterns.length === 0) {
          section.style.display = 'none';
          return;
        }
        section.style.display = 'block';

        let html = '<div style="font-size:11px;margin-bottom:8px;">Recovery rate: <strong>' + Math.round(data.recoveryRate * 100) + '%</strong> (' + data.totalRecoveries + '/' + data.totalErrors + ' errors)</div>';
        html += '<div class="recovery-list">';
        data.patterns.forEach(function(p) {
          html += '<div class="recovery-item">' +
            '<div class="recovery-desc">' + escapeHtml(p.description) + ' <span style="color:var(--vscode-descriptionForeground)">(' + p.occurrences + 'x)</span></div>' +
            '<div class="recovery-detail">' + escapeHtml(p.failedApproach) + ' → ' + escapeHtml(p.successfulApproach) + '</div>' +
            '</div>';
        });
        html += '</div>';
        body.innerHTML = html;
      }

      function renderDecisions(decisions, totalCount) {
        const section = document.getElementById('decisions-section');
        const listEl = document.getElementById('decisions-list');
        const countEl = document.getElementById('decisions-count');
        if (!section || !listEl) return;

        if (totalCount === 0) {
          section.style.display = 'none';
          return;
        }
        section.style.display = 'block';

        if (countEl) {
          const countText = decisions.length === totalCount
            ? totalCount + ' decision' + (totalCount !== 1 ? 's' : '')
            : decisions.length + ' of ' + totalCount + ' decisions';
          countEl.textContent = countText;
        }

        let html = '';
        decisions.forEach(function(d) {
          const sourceLabel = d.source.replace(/_/g, ' ');
          const timeAgo = formatRelativeTime(d.timestamp);
          html += '<div class="decision-item">' +
            '<div class="decision-desc">' + escapeHtml(d.description) + '</div>' +
            '<div class="decision-chosen">Chosen: ' + escapeHtml(d.chosenOption) + '</div>' +
            '<div class="decision-rationale">' + escapeHtml(d.rationale) + '</div>' +
            (d.alternatives && d.alternatives.length > 0
              ? '<div class="decision-rationale">Alternatives: ' + d.alternatives.map(escapeHtml).join(', ') + '</div>'
              : '') +
            '<div class="decision-meta"><span class="decision-badge">' + escapeHtml(sourceLabel) + '</span> ' + timeAgo + '</div>' +
            '</div>';
        });
        listEl.innerHTML = html;
      }

      function formatRelativeTime(isoString) {
        const now = Date.now();
        const then = new Date(isoString).getTime();
        const diffMs = now - then;
        const diffMin = Math.floor(diffMs / 60000);
        if (diffMin < 1) return 'just now';
        if (diffMin < 60) return diffMin + 'min ago';
        const diffHours = Math.floor(diffMin / 60);
        if (diffHours < 24) return diffHours + 'h ago';
        const diffDays = Math.floor(diffHours / 24);
        return diffDays + 'd ago';
      }

      // Decisions search handler (300ms debounce)
      let decisionsSearchTimer = null;
      const decisionsSearchEl = document.getElementById('decisions-search');
      if (decisionsSearchEl) {
        decisionsSearchEl.addEventListener('input', function() {
          if (decisionsSearchTimer) clearTimeout(decisionsSearchTimer);
          decisionsSearchTimer = setTimeout(function() {
            vscode.postMessage({ type: 'searchDecisions', query: decisionsSearchEl.value });
          }, 300);
        });
      }

      function renderAdvancedBurnRate(data) {
        const section = document.getElementById('burn-rate-section');
        const body = document.getElementById('burn-rate-body');
        if (!section || !body) return;

        if (data.currentRate === 0) {
          section.style.display = 'none';
          return;
        }
        section.style.display = 'block';

        const TREND_ICONS = { increasing: '↑', decreasing: '↓' };
        const trendIcon = TREND_ICONS[data.trendDirection] || '→';

        let html = '<div class="panel-metrics-row">' +
          '<div class="panel-metric-card"><div class="val">' + formatNumber(Math.round(data.currentRate)) + '</div><div class="lbl">tok/min</div></div>' +
          '<div class="panel-metric-card"><div class="val"><span class="trend-indicator ' + data.trendDirection + '">' + trendIcon + ' ' + data.trendDirection + '</span></div><div class="lbl">Trend</div></div>' +
          '</div>';

        if (data.projectedQuotaExhaustion) {
          const exDate = new Date(data.projectedQuotaExhaustion);
          html += '<div style="font-size:11px;color:var(--vscode-editorWarning-foreground);margin-bottom:8px;">Projected quota exhaustion: ' + exDate.toLocaleTimeString() + '</div>';
        }

        if (data.rateByModel.length > 0) {
          html += '<div style="font-size:11px;font-weight:600;margin-bottom:4px;">By Model</div>';
          data.rateByModel.forEach(function(m) {
            html += '<div style="font-size:11px;padding:2px 0;">' + escapeHtml(getShortModelName(m.model)) + ': ' + formatNumber(m.tokensPerMin) + ' tok/min</div>';
          });
        }
        body.innerHTML = html;
      }

      function renderToolEfficiency(data) {
        const section = document.getElementById('tool-eff-section');
        const body = document.getElementById('tool-eff-body');
        if (!section || !body) return;

        if (data.length === 0) {
          section.style.display = 'none';
          return;
        }
        section.style.display = 'block';

        let html = '<table class="summary-cost-table"><tr><th>Tool</th><th>Calls</th><th>Cost</th><th>Fail%</th><th>Avg</th></tr>';
        data.forEach(function(t) {
          html += '<tr>' +
            '<td>' + escapeHtml(t.name) + '</td>' +
            '<td>' + t.totalCalls + '</td>' +
            '<td>' + formatCost(t.estimatedCost) + '</td>' +
            '<td>' + Math.round(t.failureRate * 100) + '%</td>' +
            '<td>' + t.avgDurationFormatted + '</td>' +
            '</tr>';
        });
        html += '</table>';
        body.innerHTML = html;
      }

      // Render initial session data embedded at HTML generation time
      if (window.__initialSessionData) {
        try {
          const init = window.__initialSessionData;
          if (init.groups) {
            updateSessionList(init.groups, init.isPinned, init.isUsingCustomPath, init.customPathDisplay);
          }
          if (init.providerId && init.providerName) {
            updateProviderDisplay(init.providerId, init.providerName);
          }
        } catch (e) {
          const errEl = document.getElementById('session-list');
          vscode.postMessage({ type: 'webviewError', message: 'Init error: ' + e.message });
        }
      }

      vscode.postMessage({ type: 'webviewReady' });
    })();
}
