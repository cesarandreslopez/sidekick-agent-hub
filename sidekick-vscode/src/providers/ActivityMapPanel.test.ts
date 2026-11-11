/**
 * The pop-out panel's source switching: one live title listener at most.
 */
import * as path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { createWebviewPanel, withProgress, replayActivity } = vi.hoisted(() => ({
  createWebviewPanel: vi.fn(),
  withProgress: vi.fn(),
  replayActivity: vi.fn(),
}));

vi.mock('vscode', () => ({
  Uri: class {},
  ViewColumn: { One: 1 },
  ProgressLocation: { Notification: 15 },
  commands: { executeCommand: vi.fn() },
  workspace: { workspaceFolders: [] },
  window: {
    createWebviewPanel,
    withProgress,
    showErrorMessage: vi.fn(),
    showInformationMessage: vi.fn(),
    showQuickPick: vi.fn(),
  },
}));

vi.mock('./activityMapHost', () => ({
  activityMapWebviewOptions: () => ({}),
  buildActivityMapDocument: () => '<!doctype html>',
  exportActivityMapFile: vi.fn(),
  readActivityMapViewOptions: () => ({
    motion: 'none',
    reduceMotion: 'auto',
    layout: 'you-top',
    coreName: '',
  }),
  readActivitySettingsFromConfig: () => ({
    motion: 'auto',
    layout: 'you-top',
    coreName: '',
    labels: 'names',
    memory: { paths: [], mcpServers: [], commands: [] },
    stationOverrides: {},
  }),
}));

vi.mock('sidekick-shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('sidekick-shared')>()),
  replayActivity,
}));

import { createActivityTimeline } from 'sidekick-shared';
import { ActivityStore } from '../services/ActivityStore';
import { ActivityMapPanel } from './ActivityMapPanel';

const LIVE = '/sessions/live.jsonl';
const OLD = '/sessions/old.jsonl';

function fakePanel() {
  const onDispose = new Set<() => void>();
  return {
    title: '',
    visible: true,
    webview: {
      html: '',
      postMessage: () => Promise.resolve(true),
      onDidReceiveMessage: () => ({ dispose: () => undefined }),
    },
    reveal: vi.fn(),
    onDidDispose: (listener: () => void) => {
      onDispose.add(listener);
      return { dispose: () => onDispose.delete(listener) };
    },
    onDidChangeViewState: () => ({ dispose: () => undefined }),
    dispose: () => {
      for (const listener of [...onDispose]) listener();
    },
  };
}

/** The monitor surface the panel and its live source use, counting listeners. */
function fakeMonitor() {
  const sessionStart = new Set<() => void>();
  const subscribe = (set: Set<() => void>) => (listener: () => void) => {
    set.add(listener);
    return { dispose: () => set.delete(listener) };
  };
  const store = new ActivityStore({
    recorder: { providerId: 'claude-code', sessionId: 'live', deriveContext: false },
  });
  return {
    sessionStart,
    getActivityStore: () => store,
    isActive: () => true,
    getSessionPath: () => LIVE,
    getWorkspacePath: () => '/workspace',
    getProvider: () => ({
      id: 'claude-code' as const,
      displayName: 'Claude Code',
      getSessionId: (sessionPath: string) => path.basename(sessionPath, '.jsonl'),
      findAllSessions: () => [],
    }),
    onSessionStart: subscribe(sessionStart),
    onSessionEnd: subscribe(new Set()),
    onSessionReset: subscribe(new Set()),
  };
}

const replayed = () => ({
  providerId: 'claude-code',
  sessionId: 'old',
  timeline: createActivityTimeline(),
});

beforeEach(() => {
  createWebviewPanel.mockReset().mockImplementation(() => fakePanel());
  withProgress
    .mockReset()
    .mockImplementation((_options: unknown, task: (...args: unknown[]) => unknown) =>
      task({ report: () => undefined }, { isCancellationRequested: false }),
    );
  replayActivity.mockReset().mockImplementation(replayed);
});

describe('ActivityMapPanel', () => {
  it('keeps at most one live title listener however often the source changes', async () => {
    const monitor = fakeMonitor();
    const panel = new ActivityMapPanel({ fsPath: '/ext' } as never, () => monitor as never);
    await panel.open();
    // The connection's live source listens too.
    const live = monitor.sessionStart.size;
    expect(live).toBe(2);
    for (let round = 0; round < 3; round++) {
      await panel.open({ sessionPath: OLD });
      expect(monitor.sessionStart.size).toBe(0);
      await panel.open();
      expect(monitor.sessionStart.size).toBe(live);
    }
    expect(createWebviewPanel).toHaveBeenCalledTimes(1);
    panel.dispose();
    expect(monitor.sessionStart.size).toBe(0);
  });
});
