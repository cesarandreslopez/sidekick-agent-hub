import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import { EventEmitter } from 'events';
import { render } from 'ink';
import { Dashboard } from './Dashboard';
import { DashboardState } from '../DashboardState';
import type { StaticData } from '../StaticDataLoader';
import type { SidePanel } from '../panels/types';

/** Minimal TTY stand-ins so Ink can mount without a real terminal. */
function fakeStreams() {
  const stdout = Object.assign(new EventEmitter(), {
    columns: 120,
    rows: 40,
    isTTY: false,
    write: vi.fn(() => true),
  });
  const stdin = Object.assign(new EventEmitter(), {
    isTTY: false,
    setEncoding: vi.fn(),
    setRawMode: vi.fn(),
    ref: vi.fn(),
    unref: vi.fn(),
    read: vi.fn(() => null),
    resume: vi.fn(),
    pause: vi.fn(),
  });
  return { stdout, stdin };
}

const staticData: StaticData = {
  sessions: [],
  tasks: [],
  decisions: [],
  notes: [],
  plans: [],
  totalTokens: 0,
  totalCost: 0,
  totalSessions: 0,
};

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('Dashboard memoisation', () => {
  it('rebuilds panel items and detail content only when the metrics identity changes', async () => {
    const getItems = vi.fn(() => [{ id: 'a', label: 'A', sortKey: 0, data: {} }]);
    const renderDetail = vi.fn(() => 'detail');
    const panel: SidePanel = {
      id: 'fake',
      title: 'Fake',
      shortcutKey: 1,
      detailTabs: [{ label: 'Info', render: renderDetail }],
      getItems,
      getActions: () => [],
    };
    const state = new DashboardState();
    const event = (summary: string) => ({
      providerId: 'claude-code' as const,
      type: 'assistant' as const,
      timestamp: new Date().toISOString(),
      summary,
      tokens: { input: 1, output: 1 },
    });
    // Seed one event so the first-event session filter is set on mount rather
    // than mid-test (that dispatch legitimately rebuilds the items once).
    state.processEvent(event('hello'));
    const metrics = state.getMetrics();
    const { stdout, stdin } = fakeStreams();
    const element = (m: typeof metrics) => (
      <Dashboard panels={[panel]} metrics={m} staticData={staticData} />
    );

    const app = render(element(metrics), {
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      debug: true,
      exitOnCtrlC: false,
      patchConsole: false,
    });
    await flush();
    const itemsAfterMount = getItems.mock.calls.length;
    const detailAfterMount = renderDetail.mock.calls.length;
    expect(itemsAfterMount).toBeGreaterThan(0);

    // Same props (a host re-render for a toast, a pin toggle, a key press).
    app.rerender(element(metrics));
    await flush();
    expect(getItems).toHaveBeenCalledTimes(itemsAfterMount);
    expect(renderDetail).toHaveBeenCalledTimes(detailAfterMount);

    // A mutation yields a new metrics object and exactly one rebuild.
    state.processEvent(event('again'));
    app.rerender(element(state.getMetrics()));
    await flush();
    expect(getItems).toHaveBeenCalledTimes(itemsAfterMount + 1);
    expect(renderDetail).toHaveBeenCalledTimes(detailAfterMount + 1);

    app.unmount();
  });
});
