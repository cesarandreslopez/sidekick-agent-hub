import { describe, expect, it } from 'vitest';
import { renderActivityMapHtml } from './activityMapTemplate';
import { ACTIVITY_MAP_INIT_ELEMENT_ID } from '../types/activityMap';
import { readActivityMapInit } from '../webview/activityMap/init';

const options = (mode: 'sidebar' | 'panel', coreName = '') => ({
  cspSource: 'vscode-resource:',
  nonce: 'NONCE123',
  scriptUri: 'vscode-resource:/out/webview/activityMap.js',
  mode,
  init: {
    protocol: 1 as const,
    mode,
    options: {
      motion: 'auto' as const,
      reduceMotion: 'auto' as const,
      layout: 'you-top' as const,
      coreName,
    },
  },
});

describe('renderActivityMapHtml', () => {
  it('carries a CSP with a nonce for the one executable script', () => {
    const html = renderActivityMapHtml(options('sidebar'));
    expect(html).toContain("default-src 'none'");
    expect(html).toContain("script-src 'nonce-NONCE123' vscode-resource:");
    const scripts = [...html.matchAll(/<script([^>]*)>/g)].map((m) => m[1]);
    expect(scripts).toHaveLength(2);
    expect(scripts[0]).toContain('type="application/json"');
    expect(scripts[1]).toContain('nonce="NONCE123"');
    expect(scripts[1]).toContain('src="vscode-resource:/out/webview/activityMap.js"');
  });

  it('has no inline event handlers', () => {
    for (const mode of ['sidebar', 'panel'] as const) {
      expect(renderActivityMapHtml(options(mode))).not.toMatch(/\son[a-z]+=/i);
    }
  });

  it('escapes the init block so a hostile value cannot close the script element', () => {
    const html = renderActivityMapHtml(options('sidebar', '</script><b>'));
    expect(html).not.toContain('</script><b>');
    const block = html.match(
      new RegExp(
        `<script type="application/json" id="${ACTIVITY_MAP_INIT_ELEMENT_ID}">([^<]*)</script>`,
      ),
    );
    expect(block).not.toBeNull();
    const init = readActivityMapInit({
      getElementById: (id) =>
        id === ACTIVITY_MAP_INIT_ELEMENT_ID ? { textContent: block![1] } : null,
    });
    expect(init.options.coreName).toBe('</script><');
  });

  it('gives the panel replay controls and the sidebar a pop-out button', () => {
    const sidebar = renderActivityMapHtml(options('sidebar'));
    const panel = renderActivityMapHtml(options('panel'));
    expect(sidebar).toContain('id="am-popout"');
    expect(sidebar).not.toContain('id="am-range"');
    expect(panel).toContain('id="am-range"');
    expect(panel).toContain('id="am-live"');
    expect(panel).toContain('data-mode="panel"');
  });

  it('declares the activity palette and an accessible map container', () => {
    const html = renderActivityMapHtml(options('sidebar'));
    expect(html).toContain('--sidekick-activity-station-shell');
    expect(html).toMatch(/id="am-map" role="img" aria-label="Activity map"/);
    expect(html).toContain('aria-live="polite"');
  });
});
