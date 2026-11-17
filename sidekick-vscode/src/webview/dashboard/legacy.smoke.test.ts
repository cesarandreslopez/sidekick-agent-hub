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

  it('keeps keyboard focus on a tool row and a notification across live re-renders', () => {
    const tools = (calls: number) => ({
      type: 'updateToolAnalytics',
      analytics: [
        { name: 'Read', totalCalls: calls, successRate: 100, avgDuration: 5, pendingCount: 0 },
        { name: 'Bash', totalCalls: 1, successRate: 100, avgDuration: 5, pendingCount: 0 },
      ],
    });
    send(tools(1));
    const bashToggle = () =>
      document.querySelector<HTMLElement>('.tool-item[data-tool-name="Bash"] .tool-toggle')!;
    bashToggle().focus();
    send(tools(2));
    expect(document.activeElement).toBe(bashToggle());

    const notifications = (readFirst: boolean) => ({
      type: 'updateNotificationHistory',
      unreadCount: readFirst ? 1 : 2,
      notifications: ['n1', 'n2'].map((id, i) => ({
        id,
        triggerId: 't',
        triggerName: 'Quota',
        severity: 'warning',
        title: 'Alert ' + id,
        body: 'body',
        time: '9:00',
        isRead: readFirst && i === 0,
      })),
    });
    send(notifications(false));
    const item = (id: string) =>
      document.querySelector<HTMLElement>('.notification-item[data-id="' + id + '"]')!;
    item('n1').focus();
    item('n1').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(posted.at(-1)).toEqual({ type: 'markNotificationRead', id: 'n1' });
    expect(document.activeElement).toBe(item('n2'));
    // The host re-renders the list; focus stays on the next unread item.
    send(notifications(true));
    expect(document.activeElement).toBe(item('n2'));
    expect(errors).toEqual([]);
  });

  it('says how many events the filters hide instead of "No activity yet"', () => {
    send({
      type: 'updateTimeline',
      events: [
        { type: 'error', time: '9:00', description: 'tool failed', noiseLevel: 'system' },
        { type: 'compaction', time: '9:01', description: 'compacted', noiseLevel: 'system' },
      ],
    });
    expect(document.getElementById('timeline-list')!.textContent).toContain(
      '2 events hidden by filters',
    );
    expect(errors).toEqual([]);
  });

  it('gives History a keyboard drill-down and a text alternative', () => {
    const totals = {
      inputTokens: 100,
      outputTokens: 0,
      totalCost: 0.1,
      messageCount: 1,
      sessionCount: 1,
    };
    send({
      type: 'updateHistoricalData',
      data: {
        range: 'week',
        granularity: 'daily',
        dataPoints: [{ ...point('Mon', 100), timestamp: '2026-11-02' }, point('Tue', 0)],
        totals,
        hasAnyHistory: true,
      },
    });
    expect(document.getElementById('historyChart')!.getAttribute('aria-label')).toContain(
      'Tokens per day, last 7 days',
    );
    const drill = document.querySelector<HTMLButtonElement>(
      '#history-points .history-point-drill',
    )!;
    expect(drill.getAttribute('aria-label')).toBe('Show hours for Mon, Nov 2');
    drill.focus();
    drill.click();
    expect(posted.at(-1)).toEqual({
      type: 'drillDown',
      timestamp: '2026-11-02',
      currentRange: 'week',
    });

    // The drilled view arrives: focus goes to Back, not the page.
    send({
      type: 'updateHistoricalData',
      data: {
        range: 'today',
        granularity: 'hourly',
        dataPoints: [point('9AM', 100)],
        totals,
        hasAnyHistory: true,
        drill: { depth: 1, label: 'Mon, Nov 2 · hourly' },
      },
    });
    expect(document.activeElement).toBe(document.getElementById('drill-up'));
    // An hourly view has nothing deeper to drill into.
    expect(document.querySelector('#history-points .history-point-drill')).toBeNull();

    // Back to the top level: focus lands on the selected range, not the page.
    send({
      type: 'updateHistoricalData',
      data: {
        range: 'week',
        granularity: 'daily',
        dataPoints: [{ ...point('Mon', 100), timestamp: '2026-11-02' }],
        totals,
        hasAnyHistory: true,
      },
    });
    expect(document.activeElement?.classList.contains('range-btn')).toBe(true);
    expect(errors).toEqual([]);
  });

  it('offers the status-line hint only to Claude Code, and names cache reads as such', () => {
    const block = {
      start: new Date().toISOString(),
      end: new Date(Date.now() + 3_600_000).toISOString(),
      elapsedMs: 60_000,
      remainingMs: 3_600_000,
      tokens: { total: 1000 },
      costUsd: 0.1,
      burnRatePerMinute: 10,
      projectedTokens: 2000,
      projectedCostUsd: 0.2,
    };
    send({ type: 'updateSessionProvider', providerId: 'codex', displayName: 'Codex CLI' });
    send({ type: 'updateBillingBlock', block, official: null });
    expect(document.getElementById('billing-block-official')!.textContent).toBe('');
    send({ type: 'updateSessionProvider', providerId: 'claude-code', displayName: 'Claude Code' });
    send({ type: 'updateBillingBlock', block, official: null });
    expect(document.getElementById('billing-block-official')!.textContent).toContain(
      'install the status line',
    );
    send({
      type: 'updateCacheEffectiveness',
      data: {
        cacheHitRate: 0.9,
        estimatedTokensSaved: 2_500_000,
        estimatedCostSaved: 1.2,
        cacheWriteTokens: 1200,
        cacheReadTokens: 2_500_000,
      },
    });
    const cache = document.getElementById('cache-eff-body')!.textContent!;
    expect(cache).toContain('Cache Reads');
    expect(cache).toContain('2.5M');
    expect(cache).not.toContain('Tokens Saved');
    expect(errors).toEqual([]);
  });

  it('formats compactions in the shared token vocabulary and refreshes a live Summary', () => {
    send({
      type: 'updateCompactions',
      compactions: [
        {
          time: '9:00',
          contextBefore: 400,
          contextAfter: 120,
          tokensReclaimed: 280,
          reclaimedPercent: 70,
          source: 'reported',
          reestablishmentCostUsd: null,
        },
      ],
    });
    const compaction = document.getElementById('compaction-list')!.textContent!;
    expect(compaction).toContain('400 → 120');
    expect(compaction).not.toContain('0K');

    send({
      type: 'updateSessionAvailability',
      availability: {
        status: 'active',
        live: true,
        providerName: 'Claude Code',
        workspacePath: '/w',
        sessionDirectory: '/s',
      },
    });
    document.querySelector<HTMLButtonElement>('.tab-btn[data-tab="summary"]')!.click();
    const requests = () => posted.filter((m) => m.type === 'requestSessionSummary').length;
    const before = requests();
    const burn = {
      type: 'updateBurnRate',
      burnRate: 5,
      sessionStartTime: new Date().toISOString(),
      lastActivityTime: new Date().toISOString(),
    };
    send(burn);
    send(burn);
    // Throttled: one refresh for a burst of burn-rate updates.
    expect(requests()).toBe(before + 1);
    expect(errors).toEqual([]);
  });

  it('says a live session joins History when it ends', () => {
    const availability = (live: boolean) => ({
      type: 'updateSessionAvailability',
      availability: {
        status: 'active',
        live,
        providerName: 'Claude Code',
        workspacePath: '/w',
        sessionDirectory: '/s',
      },
    });
    send(availability(true));
    send({
      type: 'updateHistoricalData',
      data: {
        range: 'today',
        granularity: 'hourly',
        dataPoints: [point('9AM', 0)],
        totals: { inputTokens: 0, outputTokens: 0, totalCost: 0, messageCount: 0, sessionCount: 0 },
        hasAnyHistory: true,
      },
    });
    const note = document.getElementById('history-live-note')!;
    expect(note.hidden).toBe(false);
    expect(document.getElementById('history-empty-message')!.textContent).toBe(
      'No finished sessions today.',
    );
    send(availability(false));
    expect(note.hidden).toBe(true);
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

  it('settles a failed provider switch on the host provider without re-sending it', async () => {
    const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const select = document.getElementById('session-provider-select') as HTMLSelectElement;
    const switches = () => posted.filter((m) => m.type === 'setSessionProvider');
    send({ type: 'updateSessionProvider', providerId: 'claude-code', displayName: 'Claude Code' });
    const before = switches().length;

    select.value = 'codex';
    select.dispatchEvent(new Event('change'));
    await wait(300);
    expect(switches().slice(before)).toEqual([{ type: 'setSessionProvider', providerId: 'codex' }]);

    // The settings write failed: the host still reports the old provider.
    send({ type: 'updateSessionProvider', providerId: 'claude-code', displayName: 'Claude Code' });
    await wait(300);
    expect(switches().length).toBe(before + 1);
    expect(select.hasAttribute('aria-busy')).toBe(false);
    expect(select.value).toBe('claude-code');
    expect(errors).toEqual([]);
  });
});
