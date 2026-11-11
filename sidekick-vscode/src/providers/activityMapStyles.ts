/**
 * Styles of the Activity Map document (sidebar view and pop-out panel).
 * Colors come from VS Code theme variables and the activity palette
 * (`getActivityPaletteCSS`); `body[data-mode]` switches the layout.
 *
 * @module providers/activityMapStyles
 */

export const ACTIVITY_MAP_STYLES = `
  html, body {
    margin: 0;
    padding: 0;
    background: var(--sk-activity-surface);
    color: var(--vscode-foreground);
    font-family: var(--vscode-font-family);
    font-size: var(--sk-font-base, 11px);
  }
  .am-root {
    display: flex;
    flex-direction: column;
    gap: var(--sk-space-2, 8px);
    padding: var(--sk-space-2, 8px);
    box-sizing: border-box;
    min-height: 100vh;
  }
  body[data-mode='panel'] .am-root {
    padding: var(--sk-space-3, 12px) var(--sk-space-4, 16px);
  }
  .am-sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
  }

  /* ── Toolbar ── */
  .am-toolbar {
    display: flex;
    align-items: center;
    gap: var(--sk-space-1, 4px);
    min-height: 22px;
  }
  .am-source {
    color: var(--vscode-descriptionForeground);
    font-size: var(--sk-font-sm, 10px);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .am-badge {
    font-size: var(--sk-font-xs, 9px);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    padding: 1px 6px;
    border-radius: 999px;
    border: 1px solid var(--vscode-panel-border, transparent);
    color: var(--vscode-descriptionForeground);
  }
  .am-badge[data-live='true'] {
    color: var(--vscode-testing-iconPassed, #4caf50);
    border-color: currentColor;
  }
  .am-spacer { flex: 1; }
  .am-button {
    background: transparent;
    color: var(--vscode-foreground);
    border: 1px solid transparent;
    border-radius: var(--sk-radius-md, 4px);
    padding: 2px 6px;
    font: inherit;
    cursor: pointer;
  }
  .am-button:hover { background: var(--vscode-toolbar-hoverBackground, rgba(128, 128, 128, 0.15)); }
  .am-button[aria-pressed='true'] {
    border-color: var(--vscode-focusBorder);
    background: var(--vscode-toolbar-activeBackground, rgba(128, 128, 128, 0.2));
  }

  /* ── Layout ── */
  .am-main {
    display: flex;
    flex-direction: column;
    gap: var(--sk-space-2, 8px);
  }
  .am-map-col, .am-side-col {
    display: flex;
    flex-direction: column;
    gap: var(--sk-space-2, 8px);
    min-width: 0;
  }
  @media (min-width: 900px) {
    body[data-mode='panel'] .am-main {
      display: grid;
      grid-template-columns: minmax(0, 3fr) minmax(260px, 2fr);
      align-items: start;
    }
  }

  /* ── Map ── */
  .am-map {
    width: 100%;
    max-width: 720px;
    margin: 0 auto;
    aspect-ratio: 460 / 430;
    position: relative;
  }
  .am-map svg {
    width: 100%;
    height: 100%;
    display: block;
  }
  .am-map [data-station] { cursor: pointer; }
  .am-now {
    text-align: center;
    color: var(--vscode-descriptionForeground);
    font-size: var(--sk-font-sm, 10px);
    min-height: 1.4em;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .am-empty {
    color: var(--vscode-descriptionForeground);
    text-align: center;
    padding: var(--sk-space-5, 24px) var(--sk-space-2, 8px);
    line-height: 1.5;
  }

  /* ── Replay controls ── */
  .am-controls {
    display: grid;
    grid-template-columns: auto auto 1fr auto;
    align-items: center;
    gap: var(--sk-space-2, 8px);
  }
  .am-speed { display: flex; gap: 2px; }
  .am-scrub { position: relative; height: 26px; }
  .am-strip {
    position: absolute;
    inset: 0 0 10px 0;
    width: 100%;
    height: 16px;
    pointer-events: none;
  }
  .am-strip rect.am-density { fill: var(--sidekick-activity-accent); opacity: 0.45; }
  .am-strip rect.am-tick-fault { fill: var(--sidekick-activity-fault); }
  .am-strip rect.am-tick-prompt { fill: var(--sidekick-activity-station-you); }
  .am-range {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    width: 100%;
    margin: 0;
    accent-color: var(--vscode-focusBorder);
  }
  .am-time {
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: var(--sk-font-sm, 10px);
    color: var(--vscode-descriptionForeground);
    white-space: nowrap;
  }

  /* ── Sections ── */
  details.am-section {
    border-top: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.25));
    padding-top: var(--sk-space-1, 4px);
  }
  details.am-section > summary {
    cursor: pointer;
    font-size: var(--sk-font-sm, 10px);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--vscode-descriptionForeground);
    padding: 2px 0;
  }

  /* ── Feed ── */
  .am-feed {
    list-style: none;
    margin: 0;
    padding: 0;
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: var(--sk-font-sm, 10px);
  }
  .am-feed li {
    display: grid;
    grid-template-columns: 1.2em 5.5em minmax(0, 1fr) auto;
    gap: 6px;
    padding: 1px 0;
    align-items: baseline;
  }
  .am-feed .am-mark { text-align: center; }
  .am-feed .am-station { color: var(--vscode-descriptionForeground); overflow: hidden; text-overflow: ellipsis; }
  .am-feed .am-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .am-feed .am-took { color: var(--vscode-descriptionForeground); }
  .am-feed li[data-state='running'] .am-mark { color: var(--sidekick-activity-accent); }
  .am-feed li[data-state='fault'] { color: var(--vscode-errorForeground); }
  .am-feed li[data-state='ok'] { opacity: 0.8; }
  .am-feed li.am-placeholder { display: block; color: var(--vscode-descriptionForeground); }

  /* ── Insights ── */
  .am-table {
    width: 100%;
    border-collapse: collapse;
    font-size: var(--sk-font-sm, 10px);
  }
  .am-table th {
    text-align: left;
    font-weight: normal;
    color: var(--vscode-descriptionForeground);
    padding: 2px 4px;
  }
  .am-table td { padding: 0; }
  .am-row {
    display: grid;
    grid-template-columns: 10px minmax(4em, 1fr) 3.2em 4.6em 3em 4.5em;
    gap: 4px;
    align-items: center;
    width: 100%;
    text-align: left;
    background: transparent;
    color: inherit;
    border: 1px solid transparent;
    border-radius: var(--sk-radius-sm, 3px);
    padding: 2px 4px;
    font: inherit;
    cursor: pointer;
  }
  .am-row:hover { background: var(--vscode-list-hoverBackground, rgba(128, 128, 128, 0.12)); }
  .am-row[aria-pressed='true'] {
    background: var(--vscode-list-activeSelectionBackground, rgba(128, 128, 128, 0.2));
    color: var(--vscode-list-activeSelectionForeground, inherit);
  }
  .am-row .am-num { text-align: right; font-variant-numeric: tabular-nums; }
  .am-row .am-faults { color: var(--vscode-errorForeground); }
  .am-swatch { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
  .am-patterns { list-style: none; margin: var(--sk-space-2, 8px) 0 0; padding: 0; }
  .am-patterns button {
    width: 100%;
    text-align: left;
    background: transparent;
    color: inherit;
    border: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.25));
    border-radius: var(--sk-radius-md, 4px);
    padding: 3px 6px;
    margin-bottom: 4px;
    font: inherit;
    cursor: pointer;
  }
  .am-patterns button[data-state='open'] { border-color: var(--vscode-editorWarning-foreground, #ff9800); }
  .am-summary {
    white-space: pre-line;
    color: var(--vscode-descriptionForeground);
    font-size: var(--sk-font-sm, 10px);
    margin: var(--sk-space-2, 8px) 0 0;
  }

  /* ── Tooltip ── */
  .am-tooltip {
    position: fixed;
    z-index: 10;
    max-width: 260px;
    padding: 6px 8px;
    border-radius: var(--sk-radius-md, 4px);
    background: var(--vscode-editorHoverWidget-background, var(--vscode-editorWidget-background));
    color: var(--vscode-editorHoverWidget-foreground, var(--vscode-foreground));
    border: 1px solid var(--vscode-editorHoverWidget-border, var(--vscode-panel-border, transparent));
    font-size: var(--sk-font-sm, 10px);
    line-height: 1.45;
    pointer-events: none;
    white-space: pre-line;
  }
`;
