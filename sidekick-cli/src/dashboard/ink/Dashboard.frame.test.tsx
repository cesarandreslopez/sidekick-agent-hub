/**
 * Full-frame layout tests: the real dashboard and panels rendered into a
 * fake terminal of a given size, checking that nothing overflows, the frame
 * fits the terminal, and the fixed chrome stays where the mouse hit-testing
 * expects it.
 */

import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import { EventEmitter } from 'events';
import { render, Box } from 'ink';
import stringWidth from 'string-width';
import { Dashboard } from './Dashboard';
import { HelpOverlay } from './HelpOverlay';
import { ChangelogOverlay } from './ChangelogOverlay';
import { StatusBar } from './StatusBar';
import { DashboardState } from '../DashboardState';
import type { StaticData } from '../StaticDataLoader';
import type { SidePanel } from '../panels/types';
import { SessionsPanel } from '../panels/SessionsPanel';
import { TasksPanel } from '../panels/TasksPanel';
import { KanbanPanel } from '../panels/KanbanPanel';
import { NotesPanel } from '../panels/NotesPanel';
import { DecisionsPanel } from '../panels/DecisionsPanel';
import { PlansPanel } from '../panels/PlansPanel';
import { EventStreamPanel } from '../panels/EventStreamPanel';
import { ChartsPanel } from '../panels/ChartsPanel';
import { MapPanel } from '../panels/MapPanel';
import { visibleLength } from '../formatters';

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

function fakeStreams(columns: number, rows: number) {
  const writes: string[] = [];
  const stdout = Object.assign(new EventEmitter(), {
    columns,
    rows,
    isTTY: false,
    write: vi.fn((chunk: string) => {
      writes.push(String(chunk));
      return true;
    }),
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
  return { stdout, stdin, writes };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

async function renderFrame(
  element: React.ReactElement,
  columns: number,
  rows: number,
): Promise<string[]> {
  const { stdout, stdin, writes } = fakeStreams(columns, rows);
  const app = render(element, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    debug: true,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  await flush();
  await flush();
  const frame = (writes[writes.length - 1] ?? '').replace(ANSI, '');
  app.unmount();
  const lines = frame.split('\n');
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

const staticData: StaticData = {
  sessions: [],
  tasks: [],
  decisions: [
    {
      id: 'd1',
      description: 'Use a strict tag pattern so braces in data stay visible to the reader',
      rationale: 'The old pattern ate `${HOME}` and JSON braces.',
      chosenOption: 'strict pattern',
      alternatives: ['escape everything'],
      source: 'manual',
      sessionId: 'cli',
      timestamp: '2026-11-15T10:00:00.000Z',
    } as unknown as StaticData['decisions'][number],
  ],
  notes: [],
  plans: [],
  totalTokens: 0,
  totalCost: 0,
  totalSessions: 0,
};

function seededMetrics() {
  const state = new DashboardState();
  const base = Date.parse('2026-11-15T10:00:00.000Z');
  const ev = (
    i: number,
    type: 'user' | 'assistant' | 'tool_use' | 'tool_result',
    summary: string,
    extra: Record<string, unknown> = {},
  ) => ({
    providerId: 'claude-code' as const,
    type,
    timestamp: new Date(base + i * 1000).toISOString(),
    summary,
    ...extra,
  });
  state.processEvent(ev(0, 'user', 'Please fix the dashboard layout at 80 columns'));
  state.processEvent(
    ev(1, 'assistant', 'Looking at the layout code now', {
      tokens: { input: 175_400, output: 2_300 },
      model: 'claude-opus-5-5',
    }),
  );
  state.processEvent(
    ev(2, 'tool_use', 'Bash: echo ${HOME} && ls /Users/someone/projects/sidekick/src/dashboard', {
      toolName: 'Bash',
    }),
  );
  state.processEvent(
    ev(3, 'tool_result', '日本語のテキストを含む長い結果の要約です。表示幅を確認します。'),
  );
  state.processEvent(
    ev(4, 'tool_use', 'Read /Users/someone/projects/sidekick/src/dashboard/ink/Dashboard.tsx', {
      toolName: 'Read',
    }),
  );
  return state.getMetrics();
}

function allPanels(): SidePanel[] {
  return [
    new SessionsPanel(),
    new TasksPanel(),
    new KanbanPanel(),
    new NotesPanel(),
    new DecisionsPanel(),
    new PlansPanel(),
    new EventStreamPanel(),
    new ChartsPanel(),
    new MapPanel(),
  ];
}

const SIZES: Array<[number, number]> = [
  [60, 15],
  [80, 24],
  [100, 24],
  [120, 30],
];

function expectFits(lines: string[], columns: number, rows: number): void {
  expect(lines.length).toBeLessThanOrEqual(rows);
  for (const line of lines) expect(stringWidth(line)).toBeLessThanOrEqual(columns);
}

describe('dashboard frames', () => {
  for (const [columns, rows] of SIZES) {
    it(`fits a ${columns}x${rows} terminal with the side list at its configured width`, async () => {
      const panels = allPanels();
      const lines = await renderFrame(
        <Dashboard panels={panels} metrics={seededMetrics()} staticData={staticData} />,
        columns,
        rows,
      );
      expectFits(lines, columns, rows);
      expect(lines.length).toBe(rows);

      const sideWidth = columns < 80 ? 22 : 26;
      // Row 1: the focused side list's top border, then the detail tab bar.
      expect(lines[1].indexOf('╔')).toBe(0);
      expect(lines[1].indexOf('╗')).toBe(sideWidth - 1);
      expect(lines[1]).toContain('Summary');

      // Row 0: the active panel is marked without relying on colour.
      expect(lines[0]).toContain('▸1 Sessions');

      // The last row is the status bar, and help/quit always fit.
      expect(lines[rows - 1]).toContain('? help');
      expect(lines[rows - 1]).toContain('q quit');
    });
  }

  it('renders every panel as the active one at 80x24 without overflow', async () => {
    const panels = allPanels();
    for (let i = 0; i < panels.length; i++) {
      const rotated = [...panels.slice(i), ...panels.slice(0, i)];
      const lines = await renderFrame(
        <Dashboard panels={rotated} metrics={seededMetrics()} staticData={staticData} />,
        80,
        24,
      );
      expectFits(lines, 80, 24);
    }
  });

  it('keeps braces in event summaries visible', async () => {
    const state = new DashboardState();
    state.processEvent({
      providerId: 'claude-code',
      type: 'tool_use',
      timestamp: '2026-11-15T10:00:00.000Z',
      summary: 'Bash: echo ${HOME} && cat {"a": 1}',
      toolName: 'Bash',
    });
    const lines = await renderFrame(
      <Dashboard
        panels={[new EventStreamPanel()]}
        metrics={state.getMetrics()}
        staticData={staticData}
      />,
      120,
      30,
    );
    const text = lines.join('\n');
    expect(text).toContain('echo ${HOME}');
    expect(text).toContain('{"a": 1}');
  });
});

describe('overlay frames', () => {
  for (const [columns, rows] of SIZES) {
    it(`help fits a ${columns}x${rows} terminal with one row per key`, async () => {
      const panels = allPanels();
      const lines = await renderFrame(
        <Box flexDirection="column" height={rows} width={columns}>
          <HelpOverlay panels={panels} activePanelIndex={0} scrollOffset={0} />
          <Box height={1} />
        </Box>,
        columns,
        rows,
      );
      expectFits(lines, columns, rows);
      const text = lines.join('\n');
      // A key and its description share a row.
      expect(text).toMatch(/1\s+·+ Sessions/);
      // The frame's top border is on screen.
      expect(lines.some((line) => line.includes('┌'))).toBe(true);
    });

    it(`changelog fits a ${columns}x${rows} terminal with its close hint`, async () => {
      const entries = [
        {
          version: '0.33.2',
          date: '2026-11-15',
          sections: [
            {
              heading: 'Fixed',
              items: Array.from(
                { length: 12 },
                (_, i) =>
                  `Item ${i}: a long changelog line that is wider than the overlay box at eighty columns`,
              ),
            },
          ],
        },
      ];
      const lines = await renderFrame(
        <Box flexDirection="column" height={rows} width={columns}>
          <ChangelogOverlay entries={entries} scrollOffset={0} />
          <Box height={1} />
        </Box>,
        columns,
        rows,
      );
      expectFits(lines, columns, rows);
      const text = lines.join('\n');
      expect(text).toContain('to close');
      expect(text).toContain('W H A T');
    });
  }
});

describe('status bar budget', () => {
  it('keeps help and quit and drops hints before badges at 80 columns', async () => {
    const lines = await renderFrame(
      <StatusBar
        columns={80}
        eventCount={1234}
        providerName="Claude Code"
        permissionMode="bypassPermissions"
        focusTarget="side"
        panelHints={[
          { key: 'v', label: 'cycle view' },
          { key: 'F', label: 'filter nodes' },
        ]}
        sessionFilter="● active session"
        filterString=""
        mouseEnabled={false}
        isPinned
        hasPendingSession
      />,
      80,
      3,
    );
    expect(stringWidth(lines[0])).toBeLessThanOrEqual(80);
    expect(lines[0]).toContain('SIDEKICK');
    expect(lines[0]).toContain('? help');
    expect(lines[0]).toContain('q quit');
    expect(lines[0]).toContain('1234 events');
    expect(lines[0]).toContain('s new session');
  });

  it('shows the whole bar on a wide terminal', async () => {
    const lines = await renderFrame(
      <StatusBar
        columns={200}
        eventCount={5}
        providerName="Codex"
        focusTarget="side"
        panelHints={[]}
        sessionFilter={null}
        filterString=""
      />,
      200,
      3,
    );
    expect(lines[0]).toContain('nav');
    expect(lines[0]).toContain('/ filter');
    expect(lines[0]).toMatch(/v0\.0\.0-test/);
  });
});

describe('timeline renderer width', () => {
  it('never emits a row wider than the pane', () => {
    const panel = new SessionsPanel();
    const metrics = seededMetrics();
    const item = panel.getItems(metrics, staticData)[0];
    for (let w = 40; w <= 120; w += 7) {
      const out = panel.detailTabs[1].render(item, metrics, staticData, { width: w });
      for (const line of out.split('\n')) expect(visibleLength(line)).toBeLessThanOrEqual(w);
    }
  });
});
