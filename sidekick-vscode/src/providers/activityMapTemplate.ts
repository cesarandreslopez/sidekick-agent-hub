/**
 * The Activity Map document, shared by the sidebar view and the pop-out
 * panel. It carries no inline executable script: options travel in a JSON
 * block, behaviour in the `activityMap.js` bundle, records by message.
 *
 * The map's class rules (`activityMapStyles`) live here once; each redraw's
 * SVG is rendered with `embedStyles: false` and paints through them.
 *
 * @module providers/activityMapTemplate
 */

import { activityMapStyles } from 'sidekick-shared/activity';
import { ACTIVITY_MAP_INIT_ELEMENT_ID } from '../types/activityMap';
import type { ActivityMapInit, ActivityMapMode } from '../types/activityMap';
import { getDesignTokenCSS, getSharedStyles } from '../utils/designTokens';
import { safeJsonForScript } from '../utils/safeJson';
import { getActivityPaletteCSS } from '../utils/themePalette';
import { ACTIVITY_MAP_STYLES } from './activityMapStyles';

export interface ActivityMapTemplateOptions {
  cspSource: string;
  nonce: string;
  /** Webview URI of `out/webview/activityMap.js`. */
  scriptUri: string;
  mode: ActivityMapMode;
  init: ActivityMapInit;
}

function attr(value: string): string {
  return value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

export function renderActivityMapHtml(options: ActivityMapTemplateOptions): string {
  const panel = options.mode === 'panel';
  const toolbar = panel
    ? `<button class="am-button" id="am-live" type="button" title="Follow the live session (L)">Live</button>`
    : `<button class="am-button" id="am-popout" type="button" title="Open the map in an editor tab with replay controls" aria-label="Open in editor">&#x29C9;</button>`;
  const controls = panel
    ? `
      <div class="am-controls" id="am-controls" hidden>
        <button class="am-button" id="am-play" type="button" title="Play / pause (Space)" aria-label="Play">&#x25B6;</button>
        <div class="am-speed" role="group" aria-label="Playback speed">
          <button class="am-button" type="button" data-speed="1" aria-pressed="true" title="1× (1)">1×</button>
          <button class="am-button" type="button" data-speed="10" aria-pressed="false" title="10× (2)">10×</button>
          <button class="am-button" type="button" data-speed="60" aria-pressed="false" title="60× (3)">60×</button>
        </div>
        <div class="am-scrub">
          <svg class="am-strip" id="am-strip" viewBox="0 0 200 16" preserveAspectRatio="none" aria-hidden="true"></svg>
          <input class="am-range" id="am-range" type="range" min="0" max="1000" step="1" value="1000" aria-label="Session time">
        </div>
        <span class="am-time" id="am-time"></span>
      </div>`
    : '';
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
  <title>Activity Map</title>
  ${getDesignTokenCSS()}
  ${getActivityPaletteCSS()}
  ${getSharedStyles()}
  <style>${ACTIVITY_MAP_STYLES}</style>
  <style>${activityMapStyles()}</style>
</head>
<body data-mode="${attr(options.mode)}">
  <div class="am-root">
    <div class="am-toolbar">
      <span class="am-badge" id="am-badge" data-live="false">—</span>
      <span class="am-source" id="am-source"></span>
      <span class="am-spacer"></span>
      ${toolbar}
      <button class="am-button" id="am-export" type="button" title="Export the map as SVG or JSON" aria-label="Export">&#x2913;</button>
    </div>
    <div class="am-empty" id="am-empty" hidden>No agent session yet. The map fills in as soon as a Claude Code, Codex or OpenCode session starts in this workspace.</div>
    <div class="am-main" id="am-main">
      <div class="am-map-col">
        <div class="am-map" id="am-map" role="img" aria-label="Activity map" tabindex="0"></div>
        <div class="am-now" id="am-now"></div>
        <div class="am-sr-only" id="am-announce" aria-live="polite"></div>
        ${controls}
        <details class="am-section" id="am-feed-section"${panel ? ' open' : ''}>
          <summary>Activity</summary>
          <ol class="am-feed" id="am-feed"></ol>
        </details>
      </div>
      <div class="am-side-col">
        <details class="am-section" id="am-insights-section"${panel ? ' open' : ''}>
          <summary>Insights</summary>
          <div id="am-insights"></div>
        </details>
      </div>
    </div>
    <div class="am-tooltip" id="am-tooltip" role="tooltip" hidden></div>
  </div>
  <script type="application/json" id="${ACTIVITY_MAP_INIT_ELEMENT_ID}">${safeJsonForScript(options.init)}</script>
  <script nonce="${attr(options.nonce)}" src="${attr(options.scriptUri)}"></script>
</body>
</html>`;
}
