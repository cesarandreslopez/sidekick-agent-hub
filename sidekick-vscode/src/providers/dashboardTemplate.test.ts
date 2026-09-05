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
});
