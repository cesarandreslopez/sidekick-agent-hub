/**
 * A session file rewritten or replaced while monitored: the monitor replays
 * it silently and announces the reset, so the dashboard and event stream
 * end up with the totals of a fresh replay instead of adding the replay on
 * top of what they already counted.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
  default: {},
  EventEmitter: class<T> {
    private listeners = new Set<(value: T) => void>();

    event = (listener: (value: T) => void) => {
      this.listeners.add(listener);
      return { dispose: () => this.listeners.delete(listener) };
    };

    fire(value: T): void {
      for (const listener of this.listeners) listener(value);
    }

    dispose(): void {
      this.listeners.clear();
    }
  },
  ThemeIcon: class {
    constructor(
      readonly id: string,
      readonly color?: unknown,
    ) {}
  },
  ThemeColor: class {
    constructor(readonly id: string) {}
  },
  Uri: {
    joinPath: (base: { fsPath: string }, ...segments: string[]) => ({
      fsPath: path.join(base.fsPath, ...segments),
    }),
  },
  commands: { executeCommand: vi.fn() },
  extensions: { getExtension: () => ({ packageJSON: { version: '0.0.0-test' } }) },
  workspace: {
    workspaceFolders: [{ uri: { fsPath: '/workspace' } }],
    getConfiguration: () => ({ inspect: () => undefined, get: () => undefined }),
  },
  window: {
    showErrorMessage: vi.fn(),
    createWebviewPanel: vi.fn(),
    onDidChangeActiveColorTheme: vi.fn(() => ({ dispose: vi.fn() })),
  },
}));

vi.mock('./Logger', () => ({
  log: vi.fn(),
  logError: vi.fn(),
}));

import { ClaudeCodeProvider, loadSnapshot, setConfigDir } from 'sidekick-shared';
import { SessionMonitor, type SessionResetEvent } from './SessionMonitor';
import { DashboardViewProvider } from '../providers/DashboardViewProvider';
import { EventStreamTreeProvider } from '../providers/EventStreamTreeProvider';

/** The private surface these tests drive directly. */
interface MonitorInternals {
  sessionId: string | null;
  sessionPath: string | null;
  reader: unknown;
  _onSessionStart: { fire(path: string): void };
  readInitialContent(): Promise<void>;
  processFileChange(): void;
  tryRestoreFromSnapshot(sessionPath: string): boolean;
  persistSnapshot(): void;
}

interface DashboardTotals {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheWriteTokens: number;
  totalCacheReadTokens: number;
}

let dir: string;
let file: string;
const disposables: Array<{ dispose(): void }> = [];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-vscode-reset-'));
  setConfigDir(path.join(dir, 'config'));
  file = path.join(dir, 'session.jsonl');
});

afterEach(() => {
  for (const disposable of disposables.splice(0)) disposable.dispose();
  setConfigDir(undefined);
  fs.rmSync(dir, { recursive: true, force: true });
});

/** One line of a Claude response; split responses repeat their usage on every line. */
const block = (id: string, output: number, text: string) =>
  JSON.stringify({
    type: 'assistant',
    timestamp: '2026-11-01T12:00:00Z',
    message: {
      id,
      role: 'assistant',
      model: 'claude-sonnet-4-20250514',
      content: [{ type: 'text', text }],
      usage: {
        input_tokens: 10,
        output_tokens: output,
        cache_read_input_tokens: 500,
        cache_creation_input_tokens: 20,
      },
    },
  }) + '\n';
const user = (text: string) =>
  JSON.stringify({
    type: 'user',
    timestamp: '2026-11-01T12:00:00Z',
    message: { role: 'user', content: text },
  }) + '\n';

const SESSION =
  user('go') + block('msg_1', 4, 'thinking') + block('msg_1', 323, 'done') + user('next');

/** Moves the mtime forward, as a later write on a coarse-clock filesystem would. */
function touchLater(target: string): void {
  fs.utimesSync(target, new Date(), new Date(Date.now() + 5_000));
}

/** A monitor following `file` with a real Claude Code reader. */
function monitorOn(target: string) {
  const provider = new ClaudeCodeProvider();
  const monitor = new SessionMonitor(provider as never);
  const internals = monitor as unknown as MonitorInternals;
  internals.sessionId = 'session';
  internals.sessionPath = target;
  internals.reader = provider.createReader(target);
  disposables.push(monitor);
  return { monitor, internals };
}

const monitorTotals = (monitor: SessionMonitor): DashboardTotals => {
  const stats = monitor.getStats();
  return {
    totalInputTokens: stats.totalInputTokens,
    totalOutputTokens: stats.totalOutputTokens,
    totalCacheWriteTokens: stats.totalCacheWriteTokens,
    totalCacheReadTokens: stats.totalCacheReadTokens,
  };
};

/** Totals of a fresh monitor replaying the file now at `file`. */
async function freshTotals(): Promise<DashboardTotals> {
  const { monitor, internals } = monitorOn(file);
  await internals.readInitialContent();
  return monitorTotals(monitor);
}

function dashboardTotals(dashboard: DashboardViewProvider): DashboardTotals {
  const state = (dashboard as unknown as { _state: DashboardTotals })._state;
  return {
    totalInputTokens: state.totalInputTokens,
    totalOutputTokens: state.totalOutputTokens,
    totalCacheWriteTokens: state.totalCacheWriteTokens,
    totalCacheReadTokens: state.totalCacheReadTokens,
  };
}

/** A monitor attached to `file` (replayed, session start fired) with both views listening. */
async function attachedWithViews() {
  const { monitor, internals } = monitorOn(file);
  const dashboard = new DashboardViewProvider({ fsPath: dir } as never, monitor);
  const stream = new EventStreamTreeProvider(monitor);
  disposables.push(dashboard, stream);
  const resets: SessionResetEvent[] = [];
  const replayStates: boolean[] = [];
  const usage: number[] = [];
  disposables.push(
    monitor.onSessionReset((event) => resets.push(event)),
    monitor.onReplayStateChange((replaying) => replayStates.push(replaying)),
    monitor.onTokenUsage((event) => usage.push(event.outputTokens)),
  );
  await internals.readInitialContent();
  internals._onSessionStart.fire(file);
  replayStates.length = 0;
  return { monitor, internals, dashboard, stream, resets, replayStates, usage };
}

describe('SessionMonitor reader resets', () => {
  it('replays a rewritten file silently and the dashboard does not count it twice', async () => {
    fs.writeFileSync(file, SESSION);
    const { monitor, internals, dashboard, stream, resets, replayStates, usage } =
      await attachedWithViews();
    expect(dashboardTotals(dashboard).totalOutputTokens).toBe(323);

    // Live growth reaches the dashboard through onTokenUsage.
    fs.appendFileSync(file, block('msg_2', 7, 'ok'));
    touchLater(file);
    internals.processFileChange();
    expect(usage).toEqual([7]);
    expect(dashboardTotals(dashboard)).toEqual(monitorTotals(monitor));
    expect(stream.getChildren().length).toBeGreaterThan(0);

    // Same-size rewrite: the reader starts over and the monitor rebuilds silently.
    const content = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(file, content.replace('thinking', 'THINKING'));
    touchLater(file);
    internals.processFileChange();

    expect(resets).toEqual([{ sessionPath: file, reason: 'rewritten' }]);
    expect(replayStates).toEqual([true, false]);
    expect(usage).toEqual([7]);
    expect(monitor.isReplaying).toBe(false);
    const expected = await freshTotals();
    expect(monitorTotals(monitor)).toEqual(expected);
    expect(dashboardTotals(dashboard)).toEqual(expected);
    expect(expected.totalOutputTokens).toBe(323 + 7);
    expect(stream.getChildren()).toEqual([]);

    // The rebuilt state was checkpointed at once, replacing the stale snapshot.
    const snapshot = loadSnapshot('session');
    expect(snapshot?.readerPosition).toBe(fs.statSync(file).size);
    expect((snapshot?.consumer.stats as DashboardTotals).totalOutputTokens).toBe(323 + 7);
  });

  it('rebuilds after a rename-replace with new content', async () => {
    fs.writeFileSync(file, SESSION);
    const { monitor, internals, dashboard, resets } = await attachedWithViews();
    fs.writeFileSync(`${file}.next`, SESSION + block('msg_2', 7, 'ok') + block('msg_3', 9, 'x'));
    fs.renameSync(`${file}.next`, file);
    internals.processFileChange();

    expect(resets.map((event) => event.reason)).toEqual(['replaced']);
    const expected = await freshTotals();
    expect(dashboardTotals(dashboard)).toEqual(expected);
    expect(monitorTotals(monitor)).toEqual(expected);
    expect(expected.totalOutputTokens).toBe(323 + 7 + 9);
  });

  it('drops restored snapshot state when the file shrank before the first read', async () => {
    fs.writeFileSync(file, SESSION + block('msg_2', 7, 'ok'));
    const first = monitorOn(file);
    await first.internals.readInitialContent();
    first.internals.persistSnapshot();

    const resumed = monitorOn(file);
    expect(resumed.internals.tryRestoreFromSnapshot(file)).toBe(true);
    // The file shrinks between the snapshot check and the read.
    fs.truncateSync(file, Buffer.byteLength(user('go') + block('msg_1', 4, 'thinking')));
    await resumed.internals.readInitialContent();

    const expected = await freshTotals();
    expect(monitorTotals(resumed.monitor)).toEqual(expected);
    expect(expected.totalOutputTokens).toBe(4);
  });
});
