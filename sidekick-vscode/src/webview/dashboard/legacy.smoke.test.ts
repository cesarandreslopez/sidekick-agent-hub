// @vitest-environment happy-dom
/**
 * Boots the (untyped) legacy dashboard script against the real template and
 * feeds it the host's messages, so a ReferenceError or a broken handler in
 * legacy.ts fails a test instead of a user's webview.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { renderDashboardHtml } from '../../providers/dashboardTemplate';
import { createHealthView } from './health';
import { createHistoryView } from './history';
import { emptyDashboardInit } from './init';
import { startLegacyDashboard } from './legacy';
import { createNavigation } from './navigation';

const posted: Array<{ type: string; [key: string]: unknown }> = [];
let savedState: unknown;
const errors: unknown[] = [];

class FakeChart {
  static defaults: Record<string, unknown> = {};
  data: { labels: unknown[]; datasets: Array<Record<string, unknown>> };
  options: Record<string, unknown>;
  constructor(
    _ctx: unknown,
    config: { data: FakeChart['data']; options: Record<string, unknown> },
  ) {
    this.data = config.data;
    this.options = config.options ?? {};
  }
  update(): void {}
}

function send(message: Record<string, unknown>): void {
  window.dispatchEvent(new MessageEvent('message', { data: message }));
}

const point = (label: string, tokens: number) => ({
  timestamp: label,
  label,
  inputTokens: tokens,
  outputTokens: 0,
  cacheWriteTokens: 0,
  cacheReadTokens: 0,
  totalCost: tokens / 1000,
  messageCount: tokens ? 1 : 0,
  sessionCount: tokens ? 1 : 0,
});

beforeAll(() => {
  const html = renderDashboardHtml({
    nonce: 'n',
    cspSource: 'test:',
    chartjsUri: '',
    scriptUri: '',
    iconUri: '',
    extVersion: '0.0.0',
    extDate: '',
    initJson: '{}',
  });
  document.body.innerHTML = new DOMParser().parseFromString(html, 'text/html').body.innerHTML;
  HTMLCanvasElement.prototype.getContext = (() => ({})) as never;
  Object.assign(window, {
    Chart: FakeChart,
    requestAnimationFrame: (callback: () => void) => setTimeout(callback, 0),
    acquireVsCodeApi: () => ({
      postMessage: (message: { type: string }) => {
        if (message.type === 'webviewError') errors.push(message);
        posted.push(message);
      },
      getState: () => savedState,
      setState: (state: unknown) => {
        savedState = state;
      },
    }),
  });
  (globalThis as Record<string, unknown>).Chart = FakeChart;
  (globalThis as Record<string, unknown>).acquireVsCodeApi = (
    window as never as Record<string, unknown>
  ).acquireVsCodeApi;
  window.addEventListener('error', (event) => errors.push(event.error ?? event.message));
  startLegacyDashboard(emptyDashboardInit(), {
    history: createHistoryView(document),
    navigation: createNavigation(document),
    health: createHealthView(document),
  });
});

describe('legacy dashboard script', () => {
  it('boots and signals ready', () => {
    expect(posted.map((m) => m.type)).toContain('webviewReady');
    expect(errors).toEqual([]);
  });

  it('handles the session, analytics, and theme messages without throwing', async () => {
    const state = {
      totalInputTokens: 12_345_678,
      totalOutputTokens: 10,
      totalCacheWriteTokens: 0,
      totalCacheReadTokens: 5,
      totalCost: 0,
      contextUsagePercent: 42,
      modelBreakdown: [
        { model: 'claude-sonnet-4-5', calls: 3, tokens: 100, cost: 0, priced: true },
      ],
      sessionActive: true,
      lastUpdated: new Date().toISOString(),
      toolAnalytics: [
        { name: 'Read', totalCalls: 1, successRate: 100, avgDuration: 5, pendingCount: 0 },
      ],
      errorDetails: [{ type: 'Bash · timeout', count: 1, messages: ['timed out'] }],
      fileChangeSummary: {
        totalFilesChanged: 1,
        totalAdditions: 2,
        totalDeletions: 1,
        costPerChangedLine: null,
      },
      compactions: [],
      contextAttribution: [],
    };
    const messages: Array<Record<string, unknown>> = [
      {
        type: 'updateSessionAvailability',
        availability: {
          status: 'active',
          live: false,
          providerName: 'Claude Code',
          workspacePath: '/w',
          sessionDirectory: '/s',
        },
      },
      { type: 'updateStats', state },
      { type: 'updateToolAnalytics', analytics: state.toolAnalytics },
      { type: 'toolCallDetails', toolName: 'Read', calls: [] },
      {
        type: 'updateTimeline',
        events: [
          {
            type: 'assistant_response',
            time: '9:00',
            description: 'grep "x" > out',
            fullText: 'long text',
          },
        ],
      },
      { type: 'updateTimeline', events: [], search: true },
      {
        type: 'updateBurnRate',
        burnRate: 12,
        sessionStartTime: new Date(Date.now() - 600_000).toISOString(),
        lastActivityTime: new Date().toISOString(),
      },
      { type: 'updateContextHealth', score: 80, compactionCount: 0 },
      { type: 'updateTruncations', count: 0, byTool: [] },
      { type: 'updateDecisions', decisions: [], totalCount: 2 },
      {
        type: 'updateAnalytics',
        analytics: {
          toolFrequency: [{ name: 'Read', count: 3 }],
          wordFrequency: [
            { name: 'the', count: 9 },
            { name: 'schema', count: 4 },
          ],
          patterns: [],
          heatmapBuckets: [{ timestamp: new Date().toISOString(), count: 2 }],
        },
      },
      {
        type: 'updateContextWaterfall',
        waterfall: { points: [{ time: '9:00', tokens: 100, turnIndex: 1 }], compactions: [] },
      },
      {
        type: 'updateQuotaHistory',
        payload: {
          weeks: 1,
          providers: {
            zai: {
              cells: [{ date: '2026-11-15', utilization: 10, unavailable: false, samples: 1 }],
            },
          },
        },
      },
      { type: 'updateSessionProvider', providerId: 'codex', displayName: 'Codex CLI' },
      { type: 'themeChanged' },
      {
        type: 'updateHistoricalData',
        data: {
          range: 'week',
          granularity: 'daily',
          dataPoints: [point('Mon', 100), point('Tue', 0)],
          totals: {
            inputTokens: 100,
            outputTokens: 0,
            totalCost: 0.1,
            messageCount: 1,
            sessionCount: 1,
          },
          hasAnyHistory: true,
          drill: { depth: 1, label: 'Tue, Nov 3 · hourly' },
        },
      },
      { type: 'healthError', message: 'doctor broke' },
      { type: 'sessionStart', sessionPath: '/s/b' },
      // The host follows sessionStart with the new session's lists.
      { type: 'updateToolAnalytics', analytics: state.toolAnalytics },
      { type: 'sessionEnd' },
    ];
    for (const message of messages) send(message);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(errors).toEqual([]);

    expect(document.getElementById('status')!.textContent).toBe('Viewing');
    expect(document.getElementById('decisions-count-badge')!.textContent).toBe('2');
    expect(document.getElementById('drill-breadcrumb')!.hidden).toBe(false);
    expect(document.getElementById('drill-label')!.textContent).toBe('Tue, Nov 3 · hourly');
    expect(document.getElementById('health-banner')!.textContent).toContain("Couldn't run checks");
    expect(document.querySelector('.tool-toggle')).not.toBeNull();
    expect(document.querySelector('.error-group-header')!.tagName).toBe('BUTTON');
  });

  it('saves the tab and History choices with the webview', () => {
    document.querySelector<HTMLButtonElement>('.tab-btn[data-tab="history"]')!.click();
    document
      .querySelector<HTMLButtonElement>('.range-selector .range-btn[data-range="month"]')!
      .click();
    expect(savedState).toMatchObject({ tab: 'history', historyRange: 'month' });
    const request = posted.filter((m) => m.type === 'requestHistoricalData').pop();
    expect(request).toMatchObject({ range: 'month' });
    // Health's Refresh is not a range button: it asks for the Health checks only.
    const before = posted.filter((m) => m.type === 'requestHistoricalData').length;
    document.getElementById('health-refresh')!.click();
    expect(posted.filter((m) => m.type === 'requestHistoricalData').length).toBe(before);
    expect(posted[posted.length - 1]).toEqual({ type: 'requestHealth' });
  });

  it("clears the previous session's activity and tools when another session starts", () => {
    send({
      type: 'updateTimeline',
      events: [{ type: 'tool_call', time: '9:01', description: 'old session call' }],
    });
    send({
      type: 'updateToolAnalytics',
      analytics: [
        { name: 'OldTool', totalCalls: 4, successRate: 100, avgDuration: 5, pendingCount: 0 },
      ],
    });
    expect(document.getElementById('timeline-list')!.textContent).toContain('old session call');
    send({ type: 'sessionStart', sessionPath: '/s/c' });
    expect(document.getElementById('timeline-list')!.textContent).not.toContain('old session call');
    expect(document.getElementById('tool-list')!.textContent).not.toContain('OldTool');
    expect(errors).toEqual([]);
  });

  it("ignores a quota sample stamped for another provider than the card's", () => {
    send({ type: 'updateSessionProvider', providerId: 'codex', displayName: 'Codex CLI' });
    const sample = (providerId: string) => ({
      providerId,
      available: true,
      fiveHour: { utilization: 40, resetsAt: '' },
      sevenDay: { utilization: 10, resetsAt: '' },
    });
    send({ type: 'updateQuota', quota: sample('claude-code') });
    expect(document.getElementById('quota-section')!.classList.contains('visible')).toBe(false);
    send({ type: 'updateQuota', quota: sample('codex') });
    expect(document.getElementById('quota-section')!.classList.contains('visible')).toBe(true);
    expect(errors).toEqual([]);
  });

  it('debounces provider picks and holds the next one until the running switch reports', async () => {
    const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const select = document.getElementById('session-provider-select') as HTMLSelectElement;
    const pick = (value: string) => {
      select.value = value;
      select.dispatchEvent(new Event('change'));
    };
    const switches = () => posted.filter((m) => m.type === 'setSessionProvider');
    send({ type: 'updateSessionProvider', providerId: 'claude-code', displayName: 'Claude Code' });
    const before = switches().length;

    // Arrowing through OpenCode to Codex sends one switch, to Codex.
    pick('opencode');
    pick('codex');
    await wait(300);
    expect(switches().slice(before)).toEqual([{ type: 'setSessionProvider', providerId: 'codex' }]);
    expect(select.getAttribute('aria-busy')).toBe('true');
    expect(select.disabled).toBe(false);

    // A pick while that switch runs waits for it instead of overlapping.
    pick('opencode');
    await wait(300);
    expect(switches().length).toBe(before + 1);
    send({ type: 'updateSessionProvider', providerId: 'codex', displayName: 'Codex CLI' });
    expect(switches().slice(before)).toEqual([
      { type: 'setSessionProvider', providerId: 'codex' },
      { type: 'setSessionProvider', providerId: 'opencode' },
    ]);
    send({ type: 'updateSessionProvider', providerId: 'opencode', displayName: 'OpenCode' });
    expect(select.hasAttribute('aria-busy')).toBe(false);
    expect(select.value).toBe('opencode');
    expect(errors).toEqual([]);
  });
});
