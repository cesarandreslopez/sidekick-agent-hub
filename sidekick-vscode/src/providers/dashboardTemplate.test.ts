import { describe, expect, it, vi } from 'vitest';

vi.mock('../utils/designTokens', () => ({
  getDesignTokenCSS: () => '<style>/* tokens */</style>',
  getSharedStyles: () => '<style>/* shared */</style>',
}));

import { renderDashboardHtml } from './dashboardTemplate';
import { DASHBOARD_INIT_ELEMENT_ID } from '../webview/dashboard/init';

describe('renderDashboardHtml', () => {
  it('loads the bundle and the init block with the nonce, and leaves no template syntax', () => {
    const initJson = '{"session":{"providerId":"codex"},"changelog":[],"attributionVars":{}}';
    const html = renderDashboardHtml({
      nonce: 'n0nce',
      cspSource: 'vscode-webview:',
      chartjsUri: 'vscode-resource:/out/webview/chartjs-vendor.js',
      scriptUri: 'vscode-resource:/out/webview/dashboard.js',
      iconUri: 'vscode-resource:/images/icon.png',
      extVersion: '0.25.0',
      extDate: '2026-09-04',
      initJson,
    });

    expect(html).toContain(
      '<script nonce="n0nce" src="vscode-resource:/out/webview/chartjs-vendor.js"></script>',
    );
    expect(html).toContain(
      '<script nonce="n0nce" src="vscode-resource:/out/webview/dashboard.js"></script>',
    );
    expect(html).toContain(
      `<script type="application/json" id="${DASHBOARD_INIT_ELEMENT_ID}">${initJson}</script>`,
    );
    expect(html).toContain("script-src 'nonce-n0nce' vscode-webview:");
    expect(html).toContain('v0.25.0');
    expect(html).toContain('/* tokens */');
    expect(html).not.toContain('${');
    // No inline executable script remains: every <script> either has a src or is JSON.
    const inlineScripts = html.match(/<script(?![^>]*\bsrc=)(?![^>]*application\/json)[^>]*>/g);
    expect(inlineScripts).toBeNull();
  });

  it('names the real event-log folder instead of a hardcoded Unix path', () => {
    const base = {
      nonce: 'n',
      cspSource: 'vscode-webview:',
      chartjsUri: '',
      scriptUri: '',
      iconUri: '',
      extVersion: '0.33.2',
      extDate: '',
      initJson: '{}',
    };
    const windows = renderDashboardHtml({
      ...base,
      eventLogDir: 'C:\\Users\\dev\\AppData\\Roaming\\sidekick\\event-logs',
    });
    expect(windows).toContain('Record all session events to C:\\Users\\dev\\AppData');
    expect(windows).not.toContain('~/.config/sidekick/event-logs/');
    expect(renderDashboardHtml(base)).toContain('the Sidekick config folder (event-logs/)');
  });

  it('uses real buttons and dialog semantics, and keeps live regions to the status pill', () => {
    const html = renderDashboardHtml({
      nonce: 'n',
      cspSource: 'vscode-webview:',
      chartjsUri: '',
      scriptUri: '',
      iconUri: '',
      extVersion: '0.33.2',
      extDate: '',
      initJson: '{}',
    });
    for (const id of ['version-badge', 'changelog-close', 'plan-view-toggle', 'drill-up']) {
      expect(html).toMatch(new RegExp(`<button type="button"[^>]*id="${id}"`));
    }
    expect(html).not.toMatch(/<span[^>]*role="button"/);
    expect(html).toContain('role="dialog" aria-modal="true" aria-labelledby="changelog-title"');
    // Numbers that update every flush must not be re-announced each time.
    expect(html.match(/aria-live=/g)).toHaveLength(1);
    expect(html).toContain('<span id="status" class="status inactive" aria-live="polite">');
    expect(html).toContain('aria-label="Search the activity timeline"');
    expect(html).toContain('aria-label="Search decisions"');
    // Health's Refresh is not one of the History range buttons.
    expect(html).not.toMatch(/class="range-btn"[^>]*id="health-refresh"/);
    expect(html.match(/class="range-btn[^"]*"[^>]*>/g)!.every((tag) => /data-range=/.test(tag))).toBe(
      true,
    );
  });
});
