/**
 * Dashboard webview stylesheet, moved verbatim out of the inline template in
 * DashboardViewProvider. Design-token and shared styles are prepended by the
 * template, so this is only the dashboard-specific CSS.
 *
 * @module providers/dashboardStyles
 */

export const DASHBOARD_STYLES = `
    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background: var(--vscode-sideBar-background);
      padding: 12px;
    }

    .header {
      display: flex;
      align-items: center;
      gap: var(--sk-space-2);
      margin-bottom: var(--sk-space-4);
      padding-bottom: var(--sk-space-2);
      border-bottom: 1px solid var(--sk-border-primary);
    }

    .header img {
      width: 20px;
      height: 20px;
    }

    .header h1 {
      font-size: var(--sk-font-lg);
      font-weight: 600;
    }

    .header-phrase, .empty-state-phrase {
      font-size: var(--sk-font-base);
      color: var(--vscode-descriptionForeground);
      font-style: italic;
      margin: 0;
    }

    .header-phrase {
      margin: -12px 0 var(--sk-space-3) 0;
      padding: 0 0 0 28px;
    }

    .status {
      margin-left: auto;
      font-size: var(--sk-font-base);
      padding: 2px var(--sk-space-2);
      border-radius: var(--sk-radius-sm);
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
    }

    .status.active {
      background: var(--vscode-testing-iconPassed);
      color: var(--vscode-editor-background);
      display: inline-flex;
      align-items: center;
      gap: 4px;
    }

    .status.active::before {
      content: '';
      display: inline-block;
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: currentColor;
      animation: sk-pulse-dot 2s ease-in-out infinite;
    }

    .status.inactive {
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
    }

    /* Tab navigation */
    .tab-container {
      display: flex;
      gap: 0;
      margin-bottom: 16px;
      border-bottom: 1px solid var(--vscode-panel-border);
    }

    .tab-btn {
      flex: 1;
      padding: 8px 12px;
      font-size: 12px;
      font-weight: 500;
      background: transparent;
      color: var(--vscode-descriptionForeground);
      border: none;
      border-bottom: 2px solid transparent;
      cursor: pointer;
      transition: all 0.2s ease;
    }

    .tab-btn:hover {
      color: var(--vscode-foreground);
      background: var(--vscode-list-hoverBackground);
    }

    .tab-btn.active {
      color: var(--vscode-foreground);
      border-bottom-color: var(--vscode-textLink-foreground);
    }

    .tab-content {
      display: none;
      opacity: 0;
    }

    .tab-content.active {
      display: block;
      opacity: 1;
      animation: sk-fade-in 0.2s ease-out;
    }

    /* History tab styles */
    .history-controls {
      display: flex;
      gap: 8px;
      margin-bottom: 12px;
      flex-wrap: wrap;
    }

    .range-selector {
      display: flex;
      gap: 0;
      border-radius: 4px;
      overflow: hidden;
      border: 1px solid var(--vscode-input-border);
    }

    .range-btn {
      padding: 6px 10px;
      font-size: 11px;
      background: var(--vscode-input-background);
      color: var(--vscode-foreground);
      border: none;
      cursor: pointer;
      transition: background 0.2s;
    }

    .range-btn:not(:last-child) {
      border-right: 1px solid var(--vscode-input-border);
    }

    .range-btn:hover {
      background: var(--vscode-list-hoverBackground);
    }

    .range-btn.active {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }

    .metric-select {
      padding: 6px 8px;
      font-size: 11px;
      background: var(--vscode-dropdown-background);
      color: var(--vscode-dropdown-foreground);
      border: 1px solid var(--vscode-dropdown-border);
      border-radius: 4px;
      cursor: pointer;
    }

    .history-chart {
      height: 180px;
      margin-bottom: 16px;
    }

    .breadcrumb {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 12px;
      font-size: 11px;
    }

    .breadcrumb-back {
      color: var(--vscode-textLink-foreground);
      cursor: pointer;
    }

    .breadcrumb-back:hover {
      text-decoration: underline;
    }

    .breadcrumb-current {
      color: var(--vscode-descriptionForeground);
    }

    .health-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
    .health-status { display: flex; align-items: baseline; gap: 8px; padding: 8px 10px; border-radius: 4px; margin-bottom: 12px; background: var(--vscode-editorWidget-background); border-left: 3px solid var(--vscode-descriptionForeground); }
    .health-status.healthy { border-left-color: var(--vscode-charts-green, var(--vscode-testing-iconPassed)); }
    .health-status.attention { border-left-color: var(--vscode-charts-yellow, var(--vscode-editorWarning-foreground)); }
    .health-status.unhealthy { border-left-color: var(--vscode-charts-red, var(--vscode-errorForeground)); }
    .health-status-label { font-weight: 600; text-transform: capitalize; }
    .health-status-detail { font-size: 11px; color: var(--vscode-descriptionForeground); }
    .health-check { display: flex; gap: 8px; padding: 6px 0; border-bottom: 1px solid var(--vscode-widget-border, transparent); font-size: 12px; }
    .health-check-icon { width: 14px; text-align: center; font-weight: 700; }
    .health-check.ok .health-check-icon { color: var(--vscode-charts-green, var(--vscode-testing-iconPassed)); }
    .health-check.warning .health-check-icon { color: var(--vscode-charts-yellow, var(--vscode-editorWarning-foreground)); }
    .health-check.error .health-check-icon { color: var(--vscode-charts-red, var(--vscode-errorForeground)); }
    .health-check-title { font-weight: 600; }
    .health-check-message, .health-check-repair { color: var(--vscode-descriptionForeground); font-size: 11px; }
    .health-check-repair { margin-top: 2px; }
    .health-diagnostic { display: grid; grid-template-columns: auto auto 1fr; gap: 8px; font-size: 11px; padding: 4px 0; }
    .health-diagnostic-provider { font-weight: 600; }
    .health-diagnostic-kind { color: var(--vscode-descriptionForeground); }
    .health-diagnostic.error .health-diagnostic-provider { color: var(--vscode-charts-red, var(--vscode-errorForeground)); }
    .health-empty { font-size: 11px; color: var(--vscode-descriptionForeground); padding: 4px 0; }
    .health-table { width: 100%; border-collapse: collapse; font-size: 11px; }
    .health-table th, .health-table td { text-align: left; padding: 3px 6px; border-bottom: 1px solid var(--vscode-widget-border, transparent); }
    .health-table th:not(:first-child), .health-table td:not(:first-child) { text-align: right; }
    .health-trend.up { color: var(--vscode-charts-red, var(--vscode-errorForeground)); }
    .health-trend.down { color: var(--vscode-charts-green, var(--vscode-testing-iconPassed)); }
    .section-hint { font-size: 10px; font-weight: 400; color: var(--vscode-descriptionForeground); margin-left: 6px; }

    .stat-delta {
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
      min-height: 12px;
    }
    .stat-delta.up { color: var(--vscode-charts-red, var(--vscode-errorForeground)); }
    .stat-delta.down { color: var(--vscode-charts-green, var(--vscode-testing-iconPassed)); }
    .stat-delta.neutral { color: var(--vscode-descriptionForeground); }

    .history-summary {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 8px;
      margin-bottom: 16px;
    }

    .history-stat {
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border);
      border-radius: 4px;
      padding: 8px;
      text-align: center;
    }

    .history-stat .stat-value {
      font-size: 18px;
      font-weight: 600;
      font-family: var(--vscode-editor-font-family);
    }

    .history-stat .stat-label {
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
      margin-top: 2px;
    }

    .history-empty {
      text-align: center;
      padding: 24px 12px;
      color: var(--vscode-descriptionForeground);
    }

    .history-empty p {
      margin-bottom: 12px;
    }

    .history-empty .hint {
      font-size: 11px;
      margin-top: 8px;
      opacity: 0.8;
    }

    .import-btn {
      padding: 8px 16px;
      font-size: 12px;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      border-radius: 4px;
      cursor: pointer;
      transition: background 0.2s;
    }

    .import-btn:hover {
      background: var(--vscode-button-hoverBackground);
    }

    .import-btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    .history-loading {
      text-align: center;
      padding: 24px 12px;
      color: var(--vscode-descriptionForeground);
    }

    /* Metric color variables */
    :root {
      --metric-cost: var(--vscode-charts-green, #4caf50);
      --metric-input: var(--vscode-charts-blue, #2196f3);
      --metric-output: var(--vscode-charts-purple, #9c27b0);
      --metric-cache-write: var(--vscode-charts-orange, #ff9800);
      --metric-cache-read: var(--vscode-charts-yellow, #ffeb3b);
      --metric-messages: var(--vscode-textLink-foreground);
    }

    /* Metric toggle buttons for session tab */
    .metric-toggles {
      display: flex;
      gap: 4px;
      margin-bottom: 12px;
    }

    .metric-btn {
      flex: 1;
      padding: 6px 8px;
      font-size: 11px;
      background: var(--vscode-input-background);
      color: var(--vscode-descriptionForeground);
      border: 1px solid var(--vscode-input-border);
      border-radius: 3px;
      cursor: pointer;
      transition: all 0.2s;
      text-align: center;
    }

    .metric-btn:hover {
      background: var(--vscode-list-hoverBackground);
      color: var(--vscode-foreground);
    }

    .metric-btn.active {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border-color: var(--vscode-button-background);
    }

    /* Primary metric display */
    .primary-metric-display {
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border);
      border-radius: 4px;
      padding: 16px;
      text-align: center;
      margin-bottom: 16px;
    }

    .primary-metric-display .metric-value {
      font-size: 32px;
      font-weight: 700;
      font-family: var(--vscode-editor-font-family);
      color: var(--metric-cost);
    }

    .primary-metric-display .metric-subtitle {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      margin-top: 4px;
    }

    .primary-metric-display[data-metric="cost"] .metric-value { color: var(--metric-cost); }
    .primary-metric-display[data-metric="input"] .metric-value { color: var(--metric-input); }
    .primary-metric-display[data-metric="output"] .metric-value { color: var(--metric-output); }
    .primary-metric-display[data-metric="cache-write"] .metric-value { color: var(--metric-cache-write); }
    .primary-metric-display[data-metric="cache-read"] .metric-value { color: var(--metric-cache-read); }
    .primary-metric-display[data-metric="messages"] .metric-value { color: var(--metric-messages); }

    /* Inline stats row */
    .inline-stats {
      display: flex;
      justify-content: space-around;
      gap: 8px;
      margin-bottom: 16px;
      font-size: 11px;
    }

    .inline-stat {
      text-align: center;
    }

    .inline-stat .stat-value {
      font-weight: 600;
      font-family: var(--vscode-editor-font-family);
    }

    .inline-stat .stat-label {
      color: var(--vscode-descriptionForeground);
      font-size: 10px;
    }

    /* Latency section */
    .latency-section {
      margin-bottom: 16px;
      padding: 8px 12px;
      background: var(--vscode-input-background);
      border-radius: 4px;
      border: 1px solid var(--vscode-input-border);
    }

    .latency-section .section-title {
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 6px;
      letter-spacing: 0.5px;
    }

    .latency-display {
      font-size: 12px;
    }

    .latency-main {
      margin-bottom: 4px;
    }

    .latency-label {
      color: var(--vscode-descriptionForeground);
    }

    .latency-value {
      font-weight: 600;
      font-family: var(--vscode-editor-font-family);
      margin: 0 4px;
    }

    .latency-stats {
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
    }

    .latency-secondary {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
    }

    .latency-value-secondary {
      font-family: var(--vscode-editor-font-family);
    }

    .latency-count {
      color: var(--vscode-descriptionForeground);
    }

    /* Plan analytics section */
    .plan-section {
      margin-bottom: 16px;
      padding: 8px 12px;
      background: var(--vscode-input-background);
      border-radius: 4px;
      border: 1px solid var(--vscode-input-border);
    }

    .plan-section .section-title {
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 6px;
      letter-spacing: 0.5px;
    }

    .plan-progress-bar {
      height: 6px;
      background: var(--vscode-progressBar-background, #0e70c0);
      border-radius: 3px;
      margin: 6px 0;
      position: relative;
      overflow: hidden;
    }

    .plan-progress-bar-bg {
      height: 6px;
      background: var(--vscode-input-border);
      border-radius: 3px;
    }

    .plan-progress-fill {
      height: 100%;
      background: var(--vscode-testing-iconPassed, #73c991);
      border-radius: 3px;
      transition: width 0.3s ease;
      position: relative;
      overflow: hidden;
    }

    .plan-progress-fill::after {
      content: '';
      position: absolute;
      inset: 0;
      background-image: linear-gradient(
        90deg,
        transparent 0%,
        rgba(255, 255, 255, 0.15) 50%,
        transparent 100%
      );
      background-size: 200% 100%;
      animation: sk-progress-shimmer 1.5s ease-in-out infinite;
    }

    .plan-stats {
      display: flex;
      gap: 12px;
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 8px;
    }

    .plan-steps-list {
      font-size: 12px;
      max-height: 200px;
      overflow-y: auto;
    }

    .plan-step-item {
      display: flex;
      align-items: baseline;
      gap: 6px;
      padding: 2px 0;
      line-height: 1.4;
    }

    .plan-step-icon {
      flex-shrink: 0;
      width: 14px;
      text-align: center;
    }

    .plan-step-desc {
      flex: 1;
      min-width: 0;
    }

    .plan-step-meta {
      flex-shrink: 0;
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
    }

    .plan-step-item.completed .plan-step-desc {
      color: var(--vscode-descriptionForeground);
    }

    .plan-step-item.failed .plan-step-desc {
      color: var(--vscode-charts-red, #f14c4c);
    }

    .plan-step-item.skipped .plan-step-desc {
      color: var(--vscode-descriptionForeground);
      text-decoration: line-through;
    }

    .plan-view-toggle {
      font-size: 10px;
      color: var(--vscode-textLink-foreground);
      cursor: pointer;
      margin-left: 8px;
      opacity: 0.8;
    }
    .plan-view-toggle:hover {
      opacity: 1;
      text-decoration: underline;
    }

    .plan-markdown-view {
      max-height: 400px;
      overflow-y: auto;
      font-size: 12px;
      line-height: 1.5;
      display: none;
    }

    .plan-markdown-view h1 {
      font-size: 14px;
      font-weight: 600;
      margin: 8px 0 4px;
    }
    .plan-markdown-view h2 {
      font-size: 13px;
      font-weight: 600;
      margin: 6px 0 4px;
    }
    .plan-markdown-view h3 {
      font-size: 12px;
      font-weight: 600;
      margin: 4px 0 2px;
    }

    .plan-md-phase {
      border-left: 2px solid var(--vscode-charts-blue, #00BCD4);
      padding-left: 8px;
      margin: 6px 0;
    }

    .plan-md-step {
      display: flex;
      align-items: baseline;
      gap: 6px;
      padding: 1px 0;
    }
    .plan-md-step-icon {
      flex-shrink: 0;
      width: 14px;
      text-align: center;
    }
    .plan-md-step-desc {
      flex: 1;
      min-width: 0;
    }
    .plan-md-step-meta {
      flex-shrink: 0;
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
    }

    .plan-md-context {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      padding: 1px 0 1px 20px;
      font-style: italic;
    }

    .plan-md-text {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      padding: 2px 0;
    }

    /* ── Visual Hierarchy Tiers ── */
    .tier-divider {
      border-top: 1px solid var(--sk-border-primary);
      margin-top: var(--sk-space-4);
      padding-top: var(--sk-space-4);
    }

    .primary-metric-display {
      border-left: 3px solid var(--sk-accent-primary);
      padding-left: var(--sk-space-3);
    }

    /* Group summary line (shown when collapsed) */
    .group-summary {
      font-size: var(--sk-font-base);
      color: var(--vscode-descriptionForeground);
      margin-left: auto;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 55%;
      opacity: 0.8;
      transition: opacity var(--sk-transition-fast);
    }

    .details-section.expanded .group-summary {
      opacity: 0;
      width: 0;
      max-width: 0;
      overflow: hidden;
      margin: 0;
      padding: 0;
    }

    /* Count badge in group header */
    .group-count-badge {
      font-size: var(--sk-font-xs);
      padding: 1px 5px;
      border-radius: var(--sk-radius-sm);
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
      font-weight: 400;
      min-width: 16px;
      text-align: center;
      transition: opacity var(--sk-transition-fast);
    }

    .details-section.expanded .group-count-badge {
      opacity: 0.5;
    }

    /* Section content fade-in */
    .details-content {
      animation: sk-fade-in 0.2s ease-out;
    }

    /* Expanded group accent border */
    .details-section.expanded {
      border-left: 2px solid color-mix(in srgb, var(--sk-accent-primary) 35%, transparent);
      padding-left: var(--sk-space-3);
      transition: border-color var(--sk-transition-base), padding-left var(--sk-transition-base);
    }

    .details-section:not(.expanded) {
      border-left: 2px solid transparent;
      padding-left: 0;
      transition: border-color var(--sk-transition-base), padding-left var(--sk-transition-base);
    }

    /* Smooth collapse/expand for details-content */
    .details-content {
      overflow: hidden;
      max-height: 0;
      opacity: 0;
      transition: max-height var(--sk-transition-slow),
                  opacity var(--sk-transition-base),
                  margin var(--sk-transition-base);
      margin-top: 0;
    }

    .details-section.expanded .details-content {
      max-height: 5000px;
      opacity: 1;
      margin-top: var(--sk-space-3);
    }

    /* Unified collapsible section styling */
    .collapsible-section {
      margin-top: 16px;
      padding-top: 16px;
      border-top: 1px solid var(--vscode-panel-border);
    }

    .collapsible-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      cursor: pointer;
      padding: 4px 0;
    }

    .collapsible-header:hover {
      opacity: 0.8;
    }

    .collapsible-header-left {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .collapsible-toggle-icon {
      font-size: 10px;
      transition: transform 0.2s;
      color: var(--vscode-foreground);
      opacity: 0.7;
    }

    .collapsible-section.expanded .collapsible-toggle-icon {
      transform: rotate(90deg);
    }

    .collapsible-header h3 {
      font-size: 13px;
      font-weight: 600;
      display: flex;
      align-items: center;
      gap: 6px;
      margin: 0;
    }

    .collapsible-body {
      overflow: hidden;
      max-height: 0;
      opacity: 0;
      margin-top: 0;
      transition: max-height var(--sk-transition-slow),
                  opacity var(--sk-transition-base),
                  margin var(--sk-transition-base);
    }

    .collapsible-section.expanded .collapsible-body {
      max-height: 5000px;
      opacity: 1;
      margin-top: 12px;
    }

    /* Collapsible group section styling */
    .details-section {
      margin-top: 16px;
      padding-top: 16px;
      border-top: 1px solid var(--vscode-panel-border);
    }

    .details-toggle {
      display: flex;
      align-items: center;
      gap: 8px;
      width: 100%;
      padding: 4px 0;
      background: transparent;
      border: none;
      cursor: pointer;
      font-size: 13px;
      font-weight: 600;
      color: var(--vscode-foreground);
    }

    .details-toggle:hover {
      opacity: 0.8;
    }

    .toggle-icon {
      font-size: 10px;
      transition: transform 0.2s;
      opacity: 0.7;
    }

    .details-section.expanded .toggle-icon {
      transform: rotate(90deg);
    }

    .details-title {
      font-size: 13px;
      font-weight: 600;
      margin: 0;
      display: flex;
      align-items: center;
      gap: 6px;
    }


    .section {
      margin-bottom: 16px;
    }

    .section-title {
      font-size: var(--sk-font-base);
      font-weight: 600;
      text-transform: uppercase;
      color: var(--vscode-descriptionForeground);
      margin-bottom: var(--sk-space-2);
      letter-spacing: 0.5px;
      opacity: 0.85;
    }

    .section-subtitle {
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 6px;
      opacity: 0.8;
    }

    .token-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px;
    }

    .token-card {
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border);
      border-radius: 4px;
      padding: 8px;
    }

    .token-card .label {
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 4px;
    }

    .token-card .value {
      font-size: 16px;
      font-weight: 600;
      font-family: var(--vscode-editor-font-family);
    }

    .file-changes-display {
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border);
      border-radius: 4px;
      padding: 10px 12px;
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 14px;
      font-family: var(--vscode-editor-font-family);
    }

    .file-changes-display .file-count {
      font-weight: 500;
    }

    .file-changes-display .separator {
      color: var(--vscode-descriptionForeground);
    }

    .file-changes-display .additions {
      color: var(--vscode-charts-green, #4caf50);
      font-weight: 600;
    }

    .file-changes-display .deletions {
      color: var(--vscode-charts-red, #f44336);
      font-weight: 600;
    }

    .file-changes-display .lines-label {
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
    }

    .cost-display {
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border);
      border-radius: 4px;
      padding: 12px;
      text-align: center;
    }

    .cost-display .label {
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 4px;
    }

    .cost-display .value {
      font-size: 24px;
      font-weight: 700;
      font-family: var(--vscode-editor-font-family);
      color: var(--vscode-charts-green);
    }

    .context-bar {
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border);
      border-radius: 4px;
      padding: 8px;
    }

    .context-bar .label-row {
      display: flex;
      justify-content: space-between;
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 4px;
    }

    .context-bar .bar {
      height: 8px;
      background: var(--vscode-progressBar-background);
      border-radius: 4px;
      overflow: hidden;
    }

    .context-bar .bar-fill {
      height: 100%;
      background: var(--vscode-charts-blue);
      border-radius: 4px;
      transition: width 0.3s ease;
    }

    .model-list {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }

    .model-item {
      display: flex;
      justify-content: space-between;
      align-items: center;
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border);
      border-radius: 4px;
      padding: 8px;
      font-size: 12px;
    }

    .model-item .name {
      font-family: var(--vscode-editor-font-family);
      font-weight: 500;
    }

    .model-item .stats {
      color: var(--vscode-descriptionForeground);
      font-size: 10px;
    }

    .empty-state {
      text-align: center;
      padding: 24px 12px;
      color: var(--vscode-descriptionForeground);
    }

    .empty-state p {
      margin-top: 8px;
      font-size: 12px;
    }

    .chart-container {
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border);
      border-radius: 4px;
      padding: 8px;
      height: 150px;
    }

    .last-updated {
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
      text-align: center;
      margin-top: 8px;
    }

    .burn-rate, .quota-timer {
      display: flex;
      align-items: baseline;
      gap: 6px;
    }

    .burn-rate .value {
      font-size: 20px;
      font-weight: bold;
      color: var(--vscode-charts-blue);
    }

    .burn-rate .unit {
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
    }

    .quota-timer .value {
      font-size: 20px;
      font-weight: bold;
    }

    .quota-estimate {
      margin-top: 8px;
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
    }

    .quota-estimate.warning {
      color: var(--vscode-editorWarning-foreground);
    }

    .context-gauge {
      position: relative;
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border);
      border-radius: 4px;
      padding: 8px;
    }

    .context-gauge canvas {
      width: 100% !important;
      height: 100px !important;
    }

    .context-gauge .context-percent {
      position: absolute;
      bottom: 12px;
      left: 50%;
      transform: translateX(-50%);
      font-size: 20px;
      font-weight: bold;
      font-family: var(--vscode-editor-font-family);
    }

    .context-gauge .context-percent.warning {
      color: var(--vscode-editorWarning-foreground);
    }

    .context-gauge .context-percent.danger {
      color: var(--vscode-editorError-foreground);
    }

    .gauge-row {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-bottom: 16px;
    }

    .gauge-row-item {
      flex: 1;
      min-width: 0;
    }

    .gauge-row-item .section-title {
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 8px;
      letter-spacing: 0.5px;
    }

    .gauge-row .context-item {
      flex: 1 1 180px;
    }

    .gauge-row.opencode-provider .context-item {
      flex: 1 1 100%;
    }

    .gauge-row .quota-item {
      flex: 2 1 250px;
    }

    .gauge-row .context-gauge {
      height: 90px;
    }

    .gauge-row .context-gauge canvas {
      height: 70px !important;
    }

    .quota-section {
      display: none;
    }

    .quota-section.visible {
      display: block;
    }

    .quota-history-section {
      margin-top: 8px;
      padding: 10px 12px;
      border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
      border-radius: 6px;
      background: var(--vscode-editor-background);
    }

    .quota-history-header {
      display: flex;
      flex-direction: column;
      gap: 2px;
      margin-bottom: 8px;
    }

    .quota-history-subtitle {
      font-size: 9px;
      color: var(--vscode-descriptionForeground);
    }

    .quota-history-body {
      display: flex;
      flex-direction: column;
      gap: 10px;
    }

    .quota-history-provider {
      display: grid;
      grid-template-columns: auto 1fr;
      column-gap: 8px;
      align-items: center;
    }

    .quota-history-provider-label {
      font-size: 9px;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      color: var(--vscode-descriptionForeground);
      writing-mode: vertical-rl;
      transform: rotate(180deg);
      justify-self: end;
      align-self: center;
    }

    .quota-history-grid {
      width: 100%;
      max-width: 100%;
      height: auto;
    }

    .quota-history-cell {
      stroke: var(--vscode-editor-background);
      stroke-width: 0.5;
    }

    .quota-history-cell.bucket-0 { fill: var(--vscode-input-background, rgba(127, 127, 127, 0.12)); }
    .quota-history-cell.bucket-1 { fill: color-mix(in srgb, var(--vscode-textLink-foreground) 25%, transparent); }
    .quota-history-cell.bucket-2 { fill: color-mix(in srgb, var(--vscode-textLink-foreground) 45%, transparent); }
    .quota-history-cell.bucket-3 { fill: color-mix(in srgb, var(--vscode-textLink-foreground) 70%, transparent); }
    .quota-history-cell.bucket-4 { fill: var(--vscode-textLink-foreground); }
    .quota-history-cell.unavailable { fill: var(--vscode-editorError-foreground, #f44336); opacity: 0.55; }

    .quota-history-legend {
      display: flex;
      align-items: center;
      gap: 4px;
      margin-top: 8px;
      font-size: 9px;
      color: var(--vscode-descriptionForeground);
      justify-content: flex-end;
    }

    .quota-history-legend-swatch {
      display: inline-block;
      width: 10px;
      height: 10px;
      border-radius: 2px;
    }
    .quota-history-legend-swatch[data-bucket="0"] { background: var(--vscode-input-background, rgba(127, 127, 127, 0.12)); }
    .quota-history-legend-swatch[data-bucket="1"] { background: color-mix(in srgb, var(--vscode-textLink-foreground) 25%, transparent); }
    .quota-history-legend-swatch[data-bucket="2"] { background: color-mix(in srgb, var(--vscode-textLink-foreground) 45%, transparent); }
    .quota-history-legend-swatch[data-bucket="3"] { background: color-mix(in srgb, var(--vscode-textLink-foreground) 70%, transparent); }
    .quota-history-legend-swatch[data-bucket="4"] { background: var(--vscode-textLink-foreground); }

    .quota-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(104px, 1fr));
      gap: 6px;
    }

    .quota-card {
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border);
      border-radius: 4px;
      padding: 6px;
      text-align: center;
    }

    .quota-card .quota-label {
      font-size: 9px;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 2px;
    }

    .quota-card .quota-gauge {
      position: relative;
      height: 55px;
    }

    .quota-card .quota-gauge canvas {
      width: 100% !important;
      height: 55px !important;
    }

    .quota-card .quota-percent {
      position: absolute;
      bottom: 0;
      left: 50%;
      transform: translateX(-50%);
      font-size: 14px;
      font-weight: bold;
      font-family: var(--vscode-editor-font-family);
    }

    .quota-card .quota-percent.warning {
      color: var(--vscode-editorWarning-foreground);
    }

    .quota-card .quota-percent.danger {
      color: var(--vscode-editorError-foreground);
    }

    .quota-card .quota-reset {
      font-size: 9px;
      color: var(--vscode-descriptionForeground);
      margin-top: 2px;
    }

    .quota-card .quota-projection {
      font-size: 9px;
      margin-top: 2px;
      display: none;
    }

    .quota-card .quota-projection.visible {
      display: block;
    }

    .quota-card .quota-projection.warning {
      color: var(--vscode-editorWarning-foreground);
    }

    .quota-card .quota-projection.danger {
      color: var(--vscode-editorError-foreground);
    }

    .quota-reset-credits {
      margin-top: 8px;
      padding-top: 6px;
      border-top: 1px solid var(--vscode-input-border);
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
      line-height: 1.35;
    }

    .quota-reset-credits-title {
      color: var(--vscode-foreground);
      font-weight: 600;
      margin-bottom: 3px;
    }

    .quota-reset-credits-list {
      display: grid;
      gap: 2px;
    }

    .quota-reset-credit {
      overflow-wrap: anywhere;
    }

    .section-title-with-info {
      display: flex;
      align-items: center;
      gap: 4px;
    }

    .info-icon {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 14px;
      height: 14px;
      font-size: 10px;
      border-radius: 50%;
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
      cursor: help;
      position: relative;
    }

    .info-icon:hover .tooltip {
      display: block;
    }

    .tooltip {
      display: none;
      position: absolute;
      top: 100%;
      left: 50%;
      transform: translateX(-50%);
      margin-top: 6px;
      padding: 8px 10px;
      background: var(--vscode-editorWidget-background);
      border: 1px solid var(--vscode-editorWidget-border);
      border-radius: 4px;
      font-size: 11px;
      font-weight: normal;
      text-transform: none;
      letter-spacing: normal;
      white-space: normal;
      width: 220px;
      z-index: 100;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
      color: var(--vscode-foreground);
    }

    .tooltip::before {
      content: '';
      position: absolute;
      bottom: 100%;
      left: 50%;
      transform: translateX(-50%);
      border: 6px solid transparent;
      border-bottom-color: var(--vscode-editorWidget-border);
    }

    .tooltip::after {
      content: '';
      position: absolute;
      bottom: 100%;
      left: 50%;
      transform: translateX(-50%);
      border: 5px solid transparent;
      border-bottom-color: var(--vscode-editorWidget-background);
    }

    .tooltip p {
      margin: 0 0 6px 0;
    }

    .tooltip p:last-child {
      margin-bottom: 0;
    }

    .tooltip strong {
      color: var(--vscode-foreground);
    }

    .quota-error {
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border);
      border-radius: 4px;
      padding: 8px;
      text-align: left;
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
    }

    .quota-error.warning {
      border-color: var(--vscode-editorWarning-foreground);
    }

    .quota-error.error {
      border-color: var(--vscode-errorForeground);
    }

    .quota-error-title {
      font-size: 11px;
      font-weight: 700;
      color: var(--vscode-foreground);
      margin-bottom: 4px;
    }

    .quota-error.warning .quota-error-title {
      color: var(--vscode-editorWarning-foreground);
    }

    .quota-error.error .quota-error-title {
      color: var(--vscode-errorForeground);
    }

    .quota-error-body {
      line-height: 1.4;
    }

    .quota-error-detail {
      margin-top: 4px;
      color: var(--vscode-descriptionForeground);
    }

    .sk-toast {
      position: fixed;
      bottom: 10px;
      right: 12px;
      z-index: 9999;
      max-width: 220px;
      padding: 6px 8px;
      border-radius: 4px;
      background: var(--vscode-editorWidget-background);
      border: 1px solid var(--vscode-panel-border);
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.16);
      opacity: 0;
      transform: translateY(4px);
      pointer-events: none;
      transition: opacity 120ms ease, transform 120ms ease;
    }

    .sk-toast--visible {
      opacity: 1;
      transform: translateY(0);
    }

    .sk-toast--warning {
      border-color: var(--vscode-editorWarning-foreground);
    }

    .sk-toast--error {
      border-color: var(--vscode-errorForeground);
    }

    .sk-toast__title {
      font-size: 11px;
      font-weight: 700;
      margin-bottom: 2px;
      color: var(--vscode-foreground);
    }

    .sk-toast__body {
      font-size: 10px;
      line-height: 1.2;
      color: var(--vscode-descriptionForeground);
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
      text-overflow: ellipsis;
      max-height: 2.4em;
    }

    .provider-status-stack {
      display: flex;
      flex-direction: column;
      gap: 6px;
      margin-bottom: 8px;
    }

    .provider-status-section {
      display: none;
    }

    .provider-status-section.visible {
      display: block;
    }

    .provider-status-content {
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border);
      border-left-width: 3px;
      border-radius: 4px;
      padding: 6px 8px;
      font-size: 11px;
    }

    .provider-status-section.status-minor .provider-status-content {
      border-left-color: var(--vscode-charts-yellow);
    }

    .provider-status-section.status-major .provider-status-content,
    .provider-status-section.status-critical .provider-status-content {
      border-left-color: var(--vscode-errorForeground);
    }

    .provider-status-summary-row {
      display: flex;
      align-items: center;
      gap: 7px;
      min-width: 0;
    }

    .provider-status-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      flex: 0 0 auto;
      background: var(--vscode-descriptionForeground);
    }

    .provider-status-section.status-minor .provider-status-dot {
      background: var(--vscode-charts-yellow);
    }

    .provider-status-section.status-major .provider-status-dot,
    .provider-status-section.status-critical .provider-status-dot {
      background: var(--vscode-errorForeground);
    }

    .provider-status-main {
      flex: 1;
      min-width: 0;
    }

    .provider-status-title {
      font-weight: 600;
      color: var(--vscode-foreground);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .provider-status-summary {
      color: var(--vscode-descriptionForeground);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      margin-top: 1px;
    }

    .provider-status-affected {
      flex: 0 0 auto;
      color: var(--vscode-descriptionForeground);
      font-size: 10px;
      white-space: nowrap;
    }

    .provider-status-toggle {
      flex: 0 0 auto;
      border: 1px solid var(--vscode-input-border);
      border-radius: 3px;
      background: transparent;
      color: var(--vscode-foreground);
      cursor: pointer;
      font-size: 10px;
      padding: 2px 6px;
    }

    .provider-status-toggle:hover {
      background: var(--vscode-list-hoverBackground);
    }

    .provider-status-link {
      flex: 0 0 auto;
      color: var(--vscode-textLink-foreground);
      text-decoration: none;
      font-size: 13px;
      line-height: 1;
    }

    .provider-status-link:hover {
      text-decoration: underline;
    }

    .provider-status-details {
      margin-top: 6px;
      padding-top: 6px;
      border-top: 1px solid var(--vscode-input-border);
      max-height: 96px;
      overflow-y: auto;
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
      line-height: 1.4;
    }

    .provider-status-component {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 8px;
      padding: 1px 0;
    }

    .provider-status-component-name {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .provider-status-component-state {
      flex: 0 0 auto;
      color: var(--vscode-foreground);
      opacity: 0.8;
      white-space: nowrap;
    }

    /*
     * Full-width band under the gauge row rather than a third column inside it.
     * As a .gauge-row-item it inherited "flex: 1" — shorthand for "flex: 1 1 0%"
     * — so it started from a zero basis and lived on whatever the 180px context
     * gauge and 250px quota gauges left over, collapsing narrower than its own
     * longest word.
     */
    .peak-hours-section {
      display: none;
    }

    .peak-hours-section.visible {
      display: block;
      margin-bottom: 16px;
    }

    .peak-hours-content {
      background: var(--vscode-input-background);
      border-radius: 4px;
      padding: 8px;
      font-size: 11px;
      border: 1px solid var(--vscode-charts-orange, var(--vscode-charts-yellow));
    }

    .peak-hours-indicator {
      font-weight: 600;
      margin-bottom: 4px;
    }

    .peak-hours-details {
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
      line-height: 1.4;
    }

    .billing-block-section {
      display: none;
    }

    .billing-block-section.visible {
      display: block;
      margin-bottom: 16px;
    }

    .billing-block-content {
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border);
      border-radius: 4px;
      padding: 8px;
      font-size: 11px;
    }

    .billing-block-header {
      display: flex;
      justify-content: space-between;
      gap: 8px;
      margin-bottom: 4px;
    }

    .billing-block-title {
      font-weight: 600;
    }

    .billing-block-window,
    .billing-block-row,
    .billing-block-official {
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
      line-height: 1.4;
    }

    .billing-block-row strong {
      color: var(--vscode-foreground);
      font-family: var(--vscode-editor-font-family);
    }

    .billing-block-official {
      margin-top: 4px;
      padding-top: 4px;
      border-top: 1px solid var(--vscode-input-border);
    }

    .billing-block-official.official {
      color: var(--vscode-charts-blue, var(--vscode-textLink-foreground));
    }

    .tool-list {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }

    .tool-item {
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border);
      border-radius: 4px;
      padding: 8px;
    }

    .tool-item .tool-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 4px;
    }

    .tool-item .tool-name {
      font-family: var(--vscode-editor-font-family);
      font-weight: 500;
      font-size: 12px;
    }

    .tool-item .tool-calls {
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
    }

    /* Summary tab styles */
    .summary-metrics-row {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 8px;
      margin-bottom: 16px;
    }

    .summary-metric-card {
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border);
      border-radius: 4px;
      padding: 10px 8px;
      text-align: center;
    }

    .summary-metric-card .metric-val {
      font-size: 18px;
      font-weight: 700;
      font-family: var(--vscode-editor-font-family);
    }

    .summary-metric-card .metric-lbl {
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
      margin-top: 2px;
    }

    .summary-section {
      margin-bottom: 16px;
    }

    .summary-section-title {
      font-size: 12px;
      font-weight: 600;
      margin-bottom: 8px;
      padding-bottom: 4px;
      border-bottom: 1px solid var(--vscode-panel-border);
    }

    .summary-task-table, .summary-file-table, .summary-cost-table {
      width: 100%;
      font-size: 11px;
      border-collapse: collapse;
    }

    .summary-task-table th, .summary-file-table th, .summary-cost-table th {
      text-align: left;
      font-weight: 600;
      color: var(--vscode-descriptionForeground);
      padding: 4px 6px;
      border-bottom: 1px solid var(--vscode-panel-border);
      font-size: 10px;
    }

    .summary-task-table td, .summary-file-table td, .summary-cost-table td {
      padding: 4px 6px;
      border-bottom: 1px solid var(--vscode-panel-border);
    }

    .status-icon {
      display: inline-block;
      width: 8px;
      height: 8px;
      border-radius: 50%;
      margin-right: 4px;
    }

    .status-icon.completed { background: var(--vscode-charts-green, #4caf50); }
    .status-icon.in_progress { background: var(--vscode-charts-blue, #2196f3); }
    .status-icon.pending { background: var(--vscode-charts-yellow, #ffeb3b); }

    .narrative-area {
      margin-top: 16px;
      margin-bottom: 8px;
    }

    .narrative-loading {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-top: 10px;
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
    }

    .narrative-spinner {
      display: inline-block;
      width: 14px;
      height: 14px;
      border: 2px solid var(--vscode-descriptionForeground);
      border-top-color: transparent;
      border-radius: 50%;
      animation: narrative-spin 0.8s linear infinite;
      flex-shrink: 0;
    }

    @keyframes narrative-spin {
      to { transform: rotate(360deg); }
    }

    .narrative-btn {
      padding: 8px 16px;
      font-size: 12px;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      border-radius: 4px;
      cursor: pointer;
    }

    .narrative-btn:hover {
      background: var(--vscode-button-hoverBackground);
    }

    .narrative-btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    .narrative-text {
      margin-top: 12px;
      padding: 12px;
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border);
      border-radius: 4px;
      font-size: 12px;
      line-height: 1.5;
    }

    .narrative-error {
      margin-top: 8px;
      color: var(--vscode-editorError-foreground);
      font-size: 11px;
    }

    /* Richer panel styles */
    .panel-metrics-row {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 8px;
      margin-bottom: 12px;
    }

    .panel-metric-card {
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border);
      border-radius: 4px;
      padding: 8px;
      text-align: center;
    }

    .panel-metric-card .val {
      font-size: 16px;
      font-weight: 600;
      font-family: var(--vscode-editor-font-family);
    }

    .panel-metric-card .lbl {
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
    }

    .recovery-list {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .recovery-item {
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border);
      border-radius: 4px;
      padding: 8px;
      font-size: 11px;
    }

    .recovery-item .recovery-desc {
      font-weight: 500;
      margin-bottom: 4px;
    }

    .recovery-item .recovery-detail {
      color: var(--vscode-descriptionForeground);
      font-size: 10px;
    }

    .trend-indicator {
      display: inline-block;
      font-size: 10px;
      padding: 1px 4px;
      border-radius: 2px;
    }

    .trend-indicator.increasing { color: var(--vscode-editorWarning-foreground); }
    .trend-indicator.stable { color: var(--vscode-descriptionForeground); }
    .trend-indicator.decreasing { color: var(--vscode-charts-green, #4caf50); }

    .decision-item {
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border);
      border-radius: 4px;
      padding: 8px;
      font-size: 11px;
      margin-bottom: 6px;
    }
    .decision-desc { font-weight: 600; font-size: 12px; margin-bottom: 2px; }
    .decision-chosen { font-size: 11px; color: var(--vscode-textLink-foreground); }
    .decision-rationale { font-size: 11px; color: var(--vscode-descriptionForeground); margin-top: 2px; }
    .decision-meta { font-size: 10px; color: var(--vscode-descriptionForeground); margin-top: 4px; }
    .decision-badge {
      display: inline-block;
      font-size: 9px;
      padding: 1px 5px;
      border-radius: 3px;
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
    }

    .summary-empty {
      text-align: center;
      padding: 24px 12px;
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
    }

    .tool-item .tool-stats {
      display: flex;
      gap: 12px;
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
    }

    .tool-item .success-rate {
      color: var(--vscode-charts-green);
    }

    .tool-item .success-rate.warning {
      color: var(--vscode-editorWarning-foreground);
    }

    /* Timeline controls (search + filters) */
    .timeline-controls {
      display: flex;
      flex-direction: column;
      gap: 4px;
      margin-bottom: 6px;
    }

    .timeline-search {
      width: 100%;
      padding: 4px 8px;
      font-size: 11px;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border);
      border-radius: 3px;
      outline: none;
    }

    .timeline-search:focus {
      border-color: var(--vscode-focusBorder);
    }

    .timeline-search::placeholder {
      color: var(--vscode-input-placeholderForeground);
    }

    .timeline-filters {
      display: flex;
      gap: 8px;
      font-size: 10px;
    }

    .filter-toggle {
      display: flex;
      align-items: center;
      gap: 3px;
      color: var(--vscode-descriptionForeground);
      cursor: pointer;
    }

    .filter-toggle input[type="checkbox"] {
      width: 12px;
      height: 12px;
    }

    .event-log-toggle {
      margin-left: auto;
      font-weight: 400;
    }

    /* Compaction display */
    /* Context Attribution */
    #context-attribution-chart {
      display: flex;
      height: 20px;
      border-radius: 3px;
      overflow: hidden;
      margin: 8px 0 6px;
    }

    #context-attribution-chart .attr-bar {
      transition: width 0.3s ease;
      min-width: 2px;
    }

    .attribution-legend {
      display: flex;
      flex-wrap: wrap;
      gap: 4px 10px;
      font-size: 10px;
    }

    .attribution-legend .legend-item {
      display: flex;
      align-items: center;
      gap: 4px;
    }

    .attribution-legend .legend-swatch {
      width: 8px;
      height: 8px;
      border-radius: 2px;
      flex-shrink: 0;
    }

    .attribution-legend .legend-tokens {
      color: var(--vscode-descriptionForeground);
    }

    .compaction-list {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }

    .compaction-item {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 8px;
      font-size: 11px;
      background: var(--vscode-inputValidation-warningBackground);
      border-left: 3px solid var(--vscode-editorWarning-foreground);
      border-radius: 3px;
    }

    .compaction-item .compaction-time {
      color: var(--vscode-descriptionForeground);
      white-space: nowrap;
      min-width: 50px;
    }

    .compaction-item .compaction-delta {
      flex: 1;
    }

    .compaction-item .compaction-reclaimed {
      color: var(--vscode-charts-green);
      font-weight: 500;
      white-space: nowrap;
    }

    /* Chart containers */
    .chart-container {
      position: relative;
      margin: 4px 0;
    }

    /* Notification history */
    .notification-badge {
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
      font-size: 10px;
      padding: 1px 5px;
      border-radius: 8px;
      margin-left: 6px;
      vertical-align: middle;
    }

    .notification-actions {
      display: flex;
      gap: 6px;
      margin-bottom: 6px;
    }

    .notification-actions .small-btn {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      border: none;
      padding: 2px 8px;
      font-size: 11px;
      border-radius: 3px;
      cursor: pointer;
    }

    .notification-actions .small-btn:hover {
      background: var(--vscode-button-secondaryHoverBackground);
    }

    .notification-list {
      max-height: 300px;
      overflow-y: auto;
    }

    .notification-item {
      display: flex;
      gap: 8px;
      padding: 6px 8px;
      border-radius: 4px;
      margin-bottom: 4px;
      cursor: pointer;
      border-left: 3px solid transparent;
    }

    .notification-item:hover {
      background: var(--vscode-list-hoverBackground);
    }

    .notification-unread {
      background: rgba(97, 175, 239, 0.08);
    }

    .notification-read {
      opacity: 0.7;
    }

    .notification-error {
      border-left-color: var(--vscode-editorError-foreground);
    }

    .notification-warning {
      border-left-color: var(--vscode-editorWarning-foreground);
    }

    .notification-info {
      border-left-color: var(--vscode-editorInfo-foreground);
    }

    .notification-icon {
      flex-shrink: 0;
      font-size: 12px;
      margin-top: 1px;
    }

    .notification-content {
      flex: 1;
      min-width: 0;
    }

    .notification-header {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      gap: 6px;
    }

    .notification-title {
      font-weight: 500;
      font-size: 12px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .notification-time {
      color: var(--vscode-descriptionForeground);
      font-size: 10px;
      white-space: nowrap;
    }

    .notification-body {
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
      margin-top: 2px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    /* Timeline item noise classification */
    .timeline-item.compaction {
      background: var(--vscode-inputValidation-warningBackground);
      border-left: 3px solid var(--vscode-editorWarning-foreground);
    }

    .timeline-item.sidechain {
      opacity: 0.6;
    }

    .timeline-item.noise {
      opacity: 0.5;
      font-style: italic;
    }

    .timeline-item.system-event {
      opacity: 0.7;
      border-left: 2px solid var(--vscode-descriptionForeground);
    }

    .timeline-search-count {
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
      padding: 2px 0;
    }

    .timeline-list {
      display: flex;
      flex-direction: column;
      gap: 4px;
      max-height: 400px;
      overflow-y: auto;
    }

    .timeline-item {
      display: flex;
      align-items: flex-start;
      gap: 8px;
      padding: 4px 8px;
      font-size: 11px;
      background: var(--vscode-input-background);
      border-radius: 3px;
      animation: sk-slide-in-left 0.25s ease-out;
    }

    .timeline-item .time {
      color: var(--vscode-descriptionForeground);
      white-space: nowrap;
      min-width: 50px;
    }

    .timeline-item .icon {
      width: 14px;
      text-align: center;
    }

    .timeline-item .description {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .timeline-item.error {
      background: var(--vscode-inputValidation-errorBackground);
    }

    .timeline-item.assistant {
      background: var(--vscode-textBlockQuote-background);
      border-left: 2px solid var(--vscode-textLink-foreground);
    }

    .timeline-item .expand-link {
      color: var(--vscode-textLink-foreground);
      cursor: pointer;
      font-size: 10px;
    }

    .timeline-item .expand-link:hover {
      text-decoration: underline;
    }

    .timeline-item.assistant .description {
      white-space: normal;
      word-wrap: break-word;
    }

    .error-list {
      display: flex;
      flex-direction: column;
      gap: 6px;
      font-size: 11px;
    }

    .error-group {
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border);
      border-radius: 4px;
      overflow: hidden;
    }

    .error-group-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 6px 8px;
      cursor: pointer;
      background: var(--vscode-inputValidation-errorBackground);
      user-select: none;
    }

    .error-group-header:hover {
      filter: brightness(1.1);
    }

    .error-group-header .error-type {
      font-weight: 500;
    }

    .error-group-header .error-count {
      font-size: 10px;
      opacity: 0.8;
    }

    .error-group-header .chevron {
      transition: transform 0.2s;
    }

    .error-group.expanded .chevron {
      transform: rotate(90deg);
    }

    .error-group-messages {
      display: none;
      padding: 0;
      margin: 0;
      list-style: none;
      max-height: 150px;
      overflow-y: auto;
    }

    .error-group.expanded .error-group-messages {
      display: block;
    }

    .error-group-messages li {
      padding: 4px 8px;
      border-top: 1px solid var(--vscode-panel-border);
      font-family: var(--vscode-editor-font-family);
      font-size: 10px;
      word-break: break-word;
    }

    .session-navigator {
      margin-bottom: 12px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
      overflow: hidden;
    }

    .session-nav-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 6px 8px;
      background: var(--vscode-input-background);
      border-bottom: 1px solid var(--vscode-panel-border);
      cursor: pointer;
    }

    .session-nav-header:hover {
      opacity: 0.85;
    }

    .session-nav-header-left {
      display: flex;
      align-items: center;
      gap: 4px;
    }

    .session-navigator .toggle-icon {
      font-size: 10px;
      transition: transform 0.2s;
      opacity: 0.7;
    }

    .session-navigator.expanded .toggle-icon {
      transform: rotate(90deg);
    }

    .session-navigator .session-list {
      display: none;
    }

    .session-navigator.expanded .session-list {
      display: block;
    }

    .session-nav-title {
      font-size: 11px;
      font-weight: 600;
      color: var(--vscode-foreground);
    }

    .session-nav-actions {
      display: flex;
      gap: 4px;
    }

    .session-provider {
      display: flex;
      align-items: center;
      gap: 6px;
      padding-right: 4px;
    }

    .session-provider label {
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
    }

    .session-provider select {
      font-size: 10px;
      background: var(--vscode-dropdown-background);
      color: var(--vscode-dropdown-foreground);
      border: 1px solid var(--vscode-dropdown-border, transparent);
      border-radius: 3px;
      padding: 2px 6px;
      outline: none;
    }

    .session-provider select:focus {
      border-color: var(--vscode-focusBorder);
    }

    .session-nav-actions .nav-btn,
    .session-nav-actions .pin-btn {
      padding: 2px 6px;
      font-size: 10px;
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      border: none;
      border-radius: 3px;
      cursor: pointer;
    }

    .session-nav-actions .nav-btn:hover,
    .session-nav-actions .pin-btn:hover {
      background: var(--vscode-button-secondaryHoverBackground);
    }

    .session-nav-actions .nav-btn.browse {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }

    .session-nav-actions .nav-btn.browse:hover {
      background: var(--vscode-button-hoverBackground);
    }

    .session-nav-actions .pin-btn.pinned {
      background: var(--vscode-inputValidation-warningBackground);
      color: var(--vscode-inputValidation-warningForeground, var(--vscode-foreground));
    }

    .session-list {
      max-height: 200px;
      overflow-y: auto;
    }

    .session-group-header {
      padding: 4px 8px 2px;
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
      background: var(--vscode-sideBar-background);
      border-top: 1px solid var(--vscode-panel-border);
    }

    .session-card {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 5px 8px;
      cursor: pointer;
      border-left: 2px solid transparent;
    }

    .session-card:hover {
      background: var(--vscode-list-hoverBackground);
    }

    .session-card.current {
      background: var(--vscode-list-activeSelectionBackground);
      color: var(--vscode-list-activeSelectionForeground);
      border-left-color: var(--vscode-focusBorder);
    }

    .session-card-status {
      flex-shrink: 0;
    }

    .status-dot {
      display: inline-block;
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: var(--vscode-descriptionForeground);
    }

    .status-dot.active {
      background: #3fb950;
    }

    .session-card-content {
      flex: 1;
      min-width: 0;
    }

    .session-card-label {
      font-size: 11px;
      line-height: 1.3;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .session-card-meta {
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
    }

    .session-card.current .session-card-meta {
      color: var(--vscode-list-activeSelectionForeground);
      opacity: 0.8;
    }

    .session-list-empty {
      padding: 12px 8px;
      text-align: center;
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
    }

    .session-list-loading {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      padding: 16px 8px;
      text-align: center;
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
    }

    .session-list-spinner {
      display: inline-block;
      width: 12px;
      height: 12px;
      border: 2px solid var(--vscode-descriptionForeground);
      border-top-color: transparent;
      border-radius: 50%;
      animation: narrative-spin 0.8s linear infinite;
      flex-shrink: 0;
    }

    .custom-path-indicator {
      display: none;
      margin-bottom: 8px;
      padding: 6px 8px;
      background: var(--vscode-inputValidation-infoBackground);
      border: 1px solid var(--vscode-inputValidation-infoBorder);
      border-radius: 4px;
      font-size: 11px;
    }

    .custom-path-indicator.visible {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
    }

    .custom-path-indicator .path-text {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .custom-path-indicator .reset-link {
      color: var(--vscode-textLink-foreground);
      cursor: pointer;
      white-space: nowrap;
    }

    .custom-path-indicator .reset-link:hover {
      text-decoration: underline;
    }

    /* CLAUDE.md Suggestions Panel */
    .suggestions-section {
      margin-top: 16px;
      padding-top: 16px;
      border-top: 1px solid var(--vscode-panel-border);
    }

    .suggestions-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      cursor: pointer;
      padding: 4px 0;
    }

    .suggestions-header:hover {
      opacity: 0.8;
    }

    .suggestions-header-left {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .suggestions-toggle-icon {
      font-size: 10px;
      transition: transform 0.2s;
      color: var(--vscode-foreground);
      opacity: 0.7;
    }

    .suggestions-section.expanded .suggestions-toggle-icon {
      transform: rotate(90deg);
    }

    .suggestions-header h3 {
      font-size: 13px;
      font-weight: 600;
      display: flex;
      align-items: center;
      gap: 6px;
      margin: 0;
    }

    .suggestions-header h3::before {
      content: '💡';
      font-size: 14px;
    }

    .suggestions-body {
      display: none;
      margin-top: 12px;
    }

    .suggestions-section.expanded .suggestions-body {
      display: block;
    }

    #analyze-btn {
      padding: 6px 12px;
      font-size: 11px;
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      border: none;
      border-radius: 4px;
      cursor: pointer;
      transition: background 0.2s;
    }

    #analyze-btn:hover:not(:disabled) {
      background: var(--vscode-button-secondaryHoverBackground);
    }

    #analyze-btn:disabled {
      opacity: 0.6;
      cursor: not-allowed;
    }

    .suggestions-content {
      min-height: 60px;
    }

    .suggestions-loading,
    .suggestions-empty,
    .suggestions-error {
      text-align: center;
      padding: 16px;
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
    }

    .suggestions-error {
      color: var(--vscode-errorForeground);
    }

    .suggestion-card {
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border);
      border-radius: 6px;
      padding: 12px;
      margin-bottom: 10px;
    }

    .suggestion-card-consolidated {
      border-color: var(--vscode-focusBorder);
    }

    .suggestion-header {
      font-weight: 600;
      font-size: 12px;
      margin-bottom: 8px;
      color: var(--vscode-foreground);
    }

    .suggestion-observed,
    .suggestion-why,
    .suggestion-summary {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 8px;
    }

    .suggestion-observed .label,
    .suggestion-why .label,
    .suggestion-summary .label,
    .suggestion-rationale .label,
    .suggestion-code-header {
      font-weight: 600;
      color: var(--vscode-foreground);
    }

    .suggestion-code-header {
      font-size: 11px;
      margin-bottom: 4px;
    }

    .suggestion-code {
      background: var(--vscode-textBlockQuote-background);
      border: 1px solid var(--vscode-textBlockQuote-border);
      border-radius: 4px;
      padding: 8px 10px;
      font-family: var(--vscode-editor-font-family);
      font-size: 11px;
      white-space: pre-wrap;
      word-break: break-word;
      margin-bottom: 8px;
      overflow-x: auto;
    }

    .suggestion-actions {
      display: flex;
      gap: 8px;
      margin-bottom: 12px;
    }

    .suggestion-rationale {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      border-top: 1px solid var(--vscode-input-border);
      padding-top: 10px;
      margin-top: 4px;
    }

    .suggestion-rationale-list {
      margin: 6px 0 0 0;
      padding-left: 18px;
    }

    .suggestion-rationale-list li {
      margin-bottom: 4px;
    }

    .copy-btn {
      padding: 4px 10px;
      font-size: 10px;
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      border: none;
      border-radius: 3px;
      cursor: pointer;
      transition: background 0.2s;
    }

    .copy-btn:hover {
      background: var(--vscode-button-secondaryHoverBackground);
    }

    .suggestions-footer {
      margin-top: 20px;
      padding-top: 16px;
      text-align: center;
      border-top: 1px solid var(--vscode-widget-border, rgba(255,255,255,0.1));
    }

    .open-claude-md-btn {
      padding: 10px 20px;
      font-size: 11px;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      border-radius: 4px;
      cursor: pointer;
      transition: background 0.2s;
    }

    .open-claude-md-btn:hover {
      background: var(--vscode-button-hoverBackground);
    }

    .suggestions-intro {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 12px;
      line-height: 1.5;
    }

    .suggestions-intro a {
      color: var(--vscode-textLink-foreground);
      text-decoration: none;
    }

    .suggestions-intro a:hover {
      text-decoration: underline;
    }

    .suggestions-tip {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      margin-top: 12px;
      padding: 8px 10px;
      background: var(--vscode-textBlockQuote-background);
      border-radius: 4px;
      line-height: 1.5;
    }

    .suggestions-tip code {
      background: var(--vscode-textCodeBlock-background);
      padding: 1px 4px;
      border-radius: 3px;
      font-family: var(--vscode-editor-font-family);
      font-size: 11px;
      line-height: 1.4;
    }

    /* Session Handoff Button */
    .handoff-section {
      margin-top: 12px;
      padding: 8px 0;
    }

    .handoff-btn {
      width: 100%;
      padding: 6px 12px;
      font-size: 12px;
      color: var(--vscode-button-secondaryForeground);
      background: var(--vscode-button-secondaryBackground);
      border: none;
      border-radius: 4px;
      cursor: pointer;
    }

    .handoff-btn:hover {
      background: var(--vscode-button-secondaryHoverBackground);
    }

    /* Version badge */
    .version-badge {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      cursor: pointer;
      padding: 1px 6px;
      border-radius: 3px;
      transition: background 0.2s;
    }
    .version-badge:hover {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }

    /* Changelog modal */
    .changelog-backdrop {
      position: fixed; inset: 0;
      background: rgba(0,0,0,0.4);
      z-index: 1000;
      display: flex; align-items: center; justify-content: center;
    }
    .changelog-modal {
      background: var(--vscode-sideBar-background);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
      width: 90%; max-width: 480px; max-height: 80vh;
      display: flex; flex-direction: column;
      box-shadow: 0 8px 32px rgba(0,0,0,0.3);
    }
    .changelog-header { display: flex; justify-content: space-between; align-items: center; padding: 12px 16px; border-bottom: 1px solid var(--vscode-panel-border); }
    .changelog-title { font-weight: 600; font-size: 13px; }
    .changelog-close { cursor: pointer; font-size: 18px; color: var(--vscode-descriptionForeground); padding: 0 4px; }
    .changelog-close:hover { color: var(--vscode-foreground); }
    .changelog-version-info { padding: 8px 16px; display: flex; gap: 8px; align-items: center; }
    .changelog-current-version { font-weight: 600; font-size: 13px; color: var(--vscode-textLink-foreground); }
    .changelog-date { font-size: 11px; color: var(--vscode-descriptionForeground); }
    .changelog-body { padding: 0 16px 12px; overflow-y: auto; flex: 1; font-size: 12px; line-height: 1.6; }
    .changelog-entry { margin-bottom: 12px; }
    .changelog-entry-version { font-weight: 600; font-size: 12px; margin-bottom: 4px; }
    .changelog-entry-section { margin: 4px 0; }
    .changelog-entry-heading { font-size: 11px; font-weight: 600; color: var(--vscode-descriptionForeground); text-transform: uppercase; margin: 4px 0 2px; }
    .changelog-entry-item { margin: 2px 0 2px 12px; font-size: 12px; color: var(--vscode-foreground); }
    .changelog-footer { padding: 8px 16px; border-top: 1px solid var(--vscode-panel-border); text-align: center; }
    .changelog-link { font-size: 11px; color: var(--vscode-textLink-foreground); text-decoration: none; }
    .changelog-link:hover { text-decoration: underline; }

    /* Analytics: Chart containers — prevent Chart.js infinite growth */
    .chart-container {
      position: relative;
      width: 100%;
      max-width: 100%;
      overflow: hidden;
    }
    .chart-container canvas {
      max-width: 100% !important;
    }

    /* Analytics: Heatmap grid */
    .heatmap-grid {
      display: flex;
      gap: 1px;
      flex-wrap: wrap;
      margin: 4px 0;
      max-width: 100%;
      overflow: hidden;
    }
    .heatmap-cell {
      width: 8px;
      height: 18px;
      border-radius: 2px;
      transition: opacity 0.2s;
    }
    .heatmap-cell:hover {
      opacity: 0.8;
      outline: 1px solid var(--vscode-foreground);
    }
    .heatmap-cell[title] { cursor: default; }

    /* Analytics: Pattern list */
    .pattern-item {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 3px 0;
      font-size: 11px;
      max-width: 100%;
      overflow: hidden;
    }
    .pattern-bar {
      flex-shrink: 0;
      height: 10px;
      border-radius: 2px;
      background: var(--vscode-charts-purple, #b180d7);
    }
    .pattern-count {
      flex-shrink: 0;
      width: 28px;
      text-align: right;
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
    }
    .pattern-template {
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 10px;
    }
    .pattern-example {
      font-size: 9px;
      color: var(--vscode-descriptionForeground);
      padding-left: 34px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      max-width: 100%;
    }
`;
