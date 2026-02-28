/**
 * Shared design tokens for all Sidekick webview panels.
 *
 * Provides CSS custom properties (spacing, typography, radius, color, transitions,
 * elevation, surfaces) plus shared component classes used across Dashboard, MindMap,
 * TaskBoard, PlanBoard, and ProjectTimeline webviews.
 */

// ---------------------------------------------------------------------------
// Design Tokens
// ---------------------------------------------------------------------------

export function getDesignTokenCSS(): string {
  return `<style id="sk-design-tokens">
  :root {
    /* ── Spacing (base 4px) ── */
    --sk-space-1: 4px;
    --sk-space-2: 8px;
    --sk-space-3: 12px;
    --sk-space-4: 16px;
    --sk-space-5: 24px;
    --sk-space-6: 32px;

    /* ── Typography ── */
    --sk-font-xs:   9px;
    --sk-font-sm:   10px;
    --sk-font-base: 11px;
    --sk-font-md:   12px;
    --sk-font-lg:   13px;
    --sk-font-xl:   14px;
    --sk-font-hero: 18px;
    --sk-font-display: 24px;
    --sk-font-jumbo: 32px;

    /* ── Border Radius ── */
    --sk-radius-sm:   3px;
    --sk-radius-md:   4px;
    --sk-radius-lg:   6px;
    --sk-radius-xl:   8px;
    --sk-radius-2xl:  12px;
    --sk-radius-pill: 50%;

    /* ── Accent Colors (layered on VS Code theme vars) ── */
    --sk-accent-primary: var(--vscode-textLink-foreground);
    --sk-accent-success: var(--vscode-testing-iconPassed, #4caf50);
    --sk-accent-warning: var(--vscode-editorWarning-foreground, #ff9800);
    --sk-accent-error:   var(--vscode-editorError-foreground, #f44336);
    --sk-accent-info:    var(--vscode-textLink-foreground, #2196f3);

    /* ── Transitions ── */
    --sk-transition-fast:   0.15s ease;
    --sk-transition-base:   0.2s ease;
    --sk-transition-slow:   0.3s ease;
    --sk-transition-spring: 0.4s cubic-bezier(0.34, 1.56, 0.64, 1);

    /* ── Elevation / Shadows ── */
    --sk-shadow-sm:  0 1px 2px rgba(0, 0, 0, 0.08);
    --sk-shadow-md:  0 2px 6px rgba(0, 0, 0, 0.12);
    --sk-shadow-lg:  0 4px 12px rgba(0, 0, 0, 0.16);

    /* ── Surfaces ── */
    --sk-surface-primary: var(--vscode-sideBar-background);
    --sk-surface-raised:  var(--vscode-editor-background);
    --sk-surface-overlay: var(--vscode-editorWidget-background, var(--vscode-editor-background));
    --sk-border-primary:  var(--vscode-panel-border);
    --sk-border-input:    var(--vscode-input-border);

    /* ── Animation Keyframes (durations) ── */
    --sk-pulse-duration: 2s;
  }
</style>`;
}

// ---------------------------------------------------------------------------
// Shared Component Styles
// ---------------------------------------------------------------------------

export function getSharedStyles(): string {
  return `<style id="sk-shared-styles">
  /* ── Keyframe Animations ── */
  @keyframes sk-shimmer {
    0%   { background-position: -200% 0; }
    100% { background-position: 200% 0; }
  }

  @keyframes sk-value-update {
    0%   { background-color: color-mix(in srgb, var(--sk-accent-primary) 25%, transparent); }
    100% { background-color: transparent; }
  }

  @keyframes sk-fade-in {
    from { opacity: 0; transform: translateY(4px); }
    to   { opacity: 1; transform: translateY(0); }
  }

  @keyframes sk-slide-in-left {
    from { opacity: 0; transform: translateX(-8px); }
    to   { opacity: 1; transform: translateX(0); }
  }

  @keyframes sk-pulse-dot {
    0%, 100% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--sk-accent-success) 40%, transparent); }
    50%      { box-shadow: 0 0 0 4px color-mix(in srgb, var(--sk-accent-success) 0%, transparent); }
  }

  @keyframes sk-progress-shimmer {
    0%   { background-position: -200% 0; }
    100% { background-position: 200% 0; }
  }

  @keyframes sk-skeleton-pulse {
    0%, 100% { opacity: 0.4; }
    50%      { opacity: 0.8; }
  }

  /* ── Shared Header ── */
  .sk-header {
    display: flex;
    align-items: center;
    gap: var(--sk-space-2);
    padding: var(--sk-space-2) var(--sk-space-3);
    border-bottom: 1px solid var(--sk-border-primary);
  }

  .sk-header img {
    width: 20px;
    height: 20px;
  }

  .sk-header h1 {
    font-size: var(--sk-font-lg);
    font-weight: 600;
    margin: 0;
  }

  .sk-header-phrase,
  .sk-empty-state-phrase {
    font-size: var(--sk-font-base);
    color: var(--vscode-descriptionForeground);
    font-style: italic;
    margin: 0;
  }

  .sk-header-phrase {
    padding: 2px var(--sk-space-3) var(--sk-space-2) 40px;
  }

  /* ── Status Badges ── */
  .sk-status {
    font-size: var(--sk-font-sm);
    padding: 2px var(--sk-space-2);
    border-radius: var(--sk-radius-sm);
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
    white-space: nowrap;
  }

  .sk-status--active {
    background: var(--sk-accent-success);
    color: var(--vscode-editor-background);
  }

  .sk-status--active::before {
    content: '';
    display: inline-block;
    width: 6px;
    height: 6px;
    border-radius: var(--sk-radius-pill);
    background: currentColor;
    margin-right: 4px;
    animation: sk-pulse-dot var(--sk-pulse-duration) ease-in-out infinite;
  }

  /* ── Empty State ── */
  .sk-empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    min-height: 200px;
    color: var(--vscode-descriptionForeground);
    text-align: center;
    padding: var(--sk-space-5);
  }

  /* ── Cards ── */
  .sk-card {
    background: var(--sk-surface-raised);
    border: 1px solid var(--sk-border-primary);
    border-radius: var(--sk-radius-lg);
    padding: var(--sk-space-3);
    transition: transform var(--sk-transition-fast),
                box-shadow var(--sk-transition-fast);
  }

  .sk-card:hover {
    transform: translateY(-1px);
    box-shadow: var(--sk-shadow-md);
  }

  .sk-card--active {
    border-color: var(--sk-accent-primary);
    box-shadow: 0 0 0 1px color-mix(in srgb, var(--sk-accent-primary) 30%, transparent);
  }

  /* ── Section Titles ── */
  .sk-section-title {
    font-size: var(--sk-font-lg);
    font-weight: 600;
    margin: 0 0 var(--sk-space-2) 0;
    opacity: 0.85;
  }

  /* ── Chips ── */
  .sk-chip {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    font-size: var(--sk-font-xs);
    padding: 1px 6px;
    border-radius: var(--sk-radius-sm);
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
    white-space: nowrap;
  }

  /* ── Collapsible Sections ── */
  .sk-collapsible {
    border-top: 1px solid var(--sk-border-primary);
    margin-top: var(--sk-space-4);
    padding-top: var(--sk-space-4);
  }

  .sk-collapsible__header {
    display: flex;
    align-items: center;
    gap: var(--sk-space-2);
    cursor: pointer;
    padding: var(--sk-space-1) 0;
    user-select: none;
  }

  .sk-collapsible__header:hover {
    opacity: 0.8;
  }

  .sk-collapsible__icon {
    font-size: var(--sk-font-sm);
    transition: transform var(--sk-transition-base);
    color: var(--vscode-foreground);
    opacity: 0.7;
    flex-shrink: 0;
  }

  .sk-collapsible.expanded .sk-collapsible__icon {
    transform: rotate(90deg);
  }

  .sk-collapsible__title {
    font-size: var(--sk-font-lg);
    font-weight: 600;
    margin: 0;
    display: flex;
    align-items: center;
    gap: var(--sk-space-2);
  }

  .sk-collapsible__badge {
    font-size: var(--sk-font-xs);
    padding: 1px 5px;
    border-radius: var(--sk-radius-sm);
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
    font-weight: 400;
  }

  .sk-collapsible__body {
    overflow: hidden;
    max-height: 0;
    opacity: 0;
    transition: max-height var(--sk-transition-slow),
                opacity var(--sk-transition-base),
                margin var(--sk-transition-base);
    margin-top: 0;
  }

  .sk-collapsible.expanded .sk-collapsible__body {
    max-height: 5000px;
    opacity: 1;
    margin-top: var(--sk-space-3);
  }

  .sk-collapsible.expanded {
    border-left: 2px solid color-mix(in srgb, var(--sk-accent-primary) 40%, transparent);
    padding-left: var(--sk-space-3);
  }

  /* ── Icon Buttons ── */
  .sk-icon-btn {
    border: 1px solid var(--vscode-button-border, transparent);
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
    font-size: var(--sk-font-sm);
    line-height: 1;
    padding: var(--sk-space-1) 7px;
    border-radius: var(--sk-radius-sm);
    cursor: pointer;
    transition: background var(--sk-transition-fast);
  }

  .sk-icon-btn:hover:enabled {
    background: var(--vscode-button-secondaryHoverBackground);
  }

  .sk-icon-btn:disabled {
    opacity: 0.5;
    cursor: default;
  }

  /* ── Value Update Pulse ── */
  .sk-value-updated {
    animation: sk-value-update 0.6s ease-out;
  }

  /* ── Timeline Entry Animations ── */
  .sk-timeline-enter {
    animation: sk-slide-in-left 0.3s ease-out;
  }

  /* ── Progress Bar Shimmer ── */
  .sk-progress-shimmer {
    background-image: linear-gradient(
      90deg,
      transparent 0%,
      rgba(255, 255, 255, 0.15) 50%,
      transparent 100%
    );
    background-size: 200% 100%;
    animation: sk-progress-shimmer 1.5s ease-in-out infinite;
  }

  /* ── Skeleton Loading ── */
  .sk-skeleton {
    background: var(--vscode-badge-background);
    border-radius: var(--sk-radius-md);
    animation: sk-skeleton-pulse 1.5s ease-in-out infinite;
  }

  .sk-skeleton-line {
    height: 12px;
    margin-bottom: var(--sk-space-2);
    border-radius: var(--sk-radius-sm);
  }

  .sk-skeleton-line:last-child {
    width: 60%;
  }

  .sk-skeleton-gauge {
    width: 64px;
    height: 64px;
    border-radius: var(--sk-radius-pill);
  }

  .sk-skeleton-card {
    height: 80px;
    border-radius: var(--sk-radius-lg);
  }

  /* ── Tab Transitions ── */
  .sk-tab-content {
    transition: opacity var(--sk-transition-base),
                visibility var(--sk-transition-base);
  }

  .sk-tab-content:not(.active) {
    opacity: 0;
    visibility: hidden;
    height: 0;
    overflow: hidden;
  }

  .sk-tab-content.active {
    opacity: 1;
    visibility: visible;
    height: auto;
    animation: sk-fade-in 0.2s ease-out;
  }

  /* ── Visual Tier Separators (Dashboard) ── */
  .sk-tier-separator {
    border-top: 1px solid var(--sk-border-primary);
    margin-top: var(--sk-space-4);
    padding-top: var(--sk-space-4);
  }

  /* ── Fade-in utility ── */
  .sk-fade-in {
    animation: sk-fade-in 0.3s ease-out;
  }
</style>`;
}
