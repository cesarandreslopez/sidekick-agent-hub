// @vitest-environment happy-dom
/**
 * The bundle entry against the real template: it announces itself, draws
 * the map from an init, appends, resyncs on a gap, and filters by station.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ActivityRecord } from 'sidekick-shared/activity';
import { renderActivityMapHtml } from '../../providers/activityMapTemplate';
import type { ActivityMapHostMessage, ActivityMapWebviewMessage } from '../../types/activityMap';

const T0 = Date.parse('2026-11-01T12:00:00Z');
const posted: ActivityMapWebviewMessage[] = [];

function records(): ActivityRecord[] {
  return [
    { seq: 0, at: T0, kind: 'session', providerId: 'claude-code' },
    { seq: 1, at: T0, kind: 'prompt' },
    {
      seq: 2,
      at: T0 + 1_000,
      kind: 'toolStart',
      id: 'a',
      station: 'files',
      label: 'src/a.ts',
      tool: 'Read',
    },
    { seq: 3, at: T0 + 1_500, kind: 'toolEnd', id: 'a', outcome: 'ok' },
    {
      seq: 4,
      at: T0 + 2_000,
      kind: 'toolStart',
      id: 'b',
      station: 'shell',
      label: 'npm test',
      tool: 'Bash',
    },
    { seq: 5, at: T0 + 6_000, kind: 'toolEnd', id: 'b', outcome: 'error' },
  ];
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 60));
const send = (message: ActivityMapHostMessage) =>
  window.dispatchEvent(new MessageEvent('message', { data: message }));

beforeAll(async () => {
  const html = renderActivityMapHtml({
    cspSource: 'vscode-resource:',
    nonce: 'n',
    scriptUri: 'activityMap.js',
    mode: 'panel',
    init: {
      protocol: 1,
      mode: 'panel',
      options: { motion: 'none', reduceMotion: 'auto', layout: 'you-top', coreName: '' },
    },
  });
  const open = html.indexOf('>', html.indexOf('<body')) + 1;
  const inner = html.slice(open, html.indexOf('</body>'));
  document.body.innerHTML = inner.replace(/<script nonce[^>]*><\/script>/, '');
  document.body.setAttribute('data-mode', 'panel');
  let state: unknown;
  (globalThis as Record<string, unknown>).acquireVsCodeApi = () => ({
    postMessage: (message: ActivityMapWebviewMessage) => posted.push(message),
    getState: () => state,
    setState: (next: unknown) => (state = next),
  });
  await import('./index');
});

afterAll(() => {
  delete (globalThis as Record<string, unknown>).acquireVsCodeApi;
  vi.restoreAllMocks();
});

describe('activity map webview boot', () => {
  it('announces itself as ready', () => {
    expect(posted[0]).toEqual({ type: 'activity/ready', protocol: 1 });
  });

  it('shows the empty state until a session arrives, then draws it', async () => {
    send({ type: 'activity/empty', reason: 'noSession' });
    await settle();
    expect(document.getElementById('am-empty')?.hidden).toBe(false);

    send({
      type: 'activity/init',
      protocol: 1,
      source: {
        kind: 'live',
        providerId: 'claude-code',
        sessionId: 's1',
        label: 'Claude Code · s1',
      },
      epoch: 1,
      baseSeq: 0,
      nextSeq: 6,
      records: records(),
      hostNow: T0 + 7_000,
      live: false,
    });
    await settle();
    expect(document.getElementById('am-empty')?.hidden).toBe(true);
    expect(document.querySelector('#am-map svg')).not.toBeNull();
    expect(document.getElementById('am-source')?.textContent).toBe('Claude Code · s1');
    expect(document.getElementById('am-badge')?.textContent).toBe('ended');
    expect(document.querySelectorAll('#am-feed li').length).toBeGreaterThan(0);
    expect(document.querySelector('#am-insights button.am-row')).not.toBeNull();
    expect(document.getElementById('am-controls')?.hidden).toBe(false);
    expect(document.getElementById('am-time')?.textContent).toContain('+6.0s');
  });

  it('appends in order and asks for a resync on a gap', async () => {
    send({
      type: 'activity/append',
      epoch: 1,
      fromSeq: 6,
      records: [
        {
          seq: 6,
          at: T0 + 8_000,
          kind: 'toolStart',
          id: 'c',
          station: 'network',
          label: 'github.com',
          tool: 'WebFetch',
        },
      ],
      hostNow: T0 + 8_000,
    });
    await settle();
    expect(document.getElementById('am-feed')?.textContent).toContain('github.com');
    send({ type: 'activity/append', epoch: 1, fromSeq: 99, records: [], hostNow: T0 });
    expect(posted.at(-1)).toEqual({ type: 'activity/resync', reason: 'gap' });
  });

  it('filters the feed by a station chosen in the table', async () => {
    const shell = document.querySelector<HTMLButtonElement>(
      '#am-insights button[data-station="shell"]',
    );
    expect(shell).not.toBeNull();
    shell!.click();
    await settle();
    const stations = Array.from(document.querySelectorAll<HTMLElement>('#am-feed li')).map(
      (li) => li.dataset.station,
    );
    expect(stations.length).toBeGreaterThan(0);
    expect(new Set(stations)).toEqual(new Set(['shell']));
    expect(
      document
        .querySelector('#am-insights button[data-station="shell"]')
        ?.getAttribute('aria-pressed'),
    ).toBe('true');
  });

  it('asks the host to export at the cursor', () => {
    document.getElementById('am-export')?.click();
    expect(posted.at(-1)).toMatchObject({ type: 'activity/export' });
  });
});
