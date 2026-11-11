/**
 * The monitor's activity log: filled by replays (silently) and live growth,
 * rebuilt when the reader starts over, kept out of every other consumer for
 * hook and memory signals, and checkpointed so a resumed session keeps its
 * history.
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

import { ClaudeCodeProvider, loadSnapshot, saveSnapshot, setConfigDir } from 'sidekick-shared';
import { DEFAULT_ACTIVITY_MAP_SETTINGS, toRecorderOptions } from '../utils/activityMapSettings';
import { ActivityStore } from './ActivityStore';
import { SessionMonitor } from './SessionMonitor';

interface MonitorInternals {
  sessionId: string | null;
  sessionPath: string | null;
  reader: ReturnType<ClaudeCodeProvider['createReader']> | null;
  readInitialContent(): Promise<void>;
  processFileChange(): void;
  tryRestoreFromSnapshot(sessionPath: string): boolean;
  persistSnapshot(): void;
  timeline: unknown[];
}

let dir: string;
let file: string;
const disposables: Array<{ dispose(): void }> = [];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-vscode-activity-'));
  setConfigDir(path.join(dir, 'config'));
  file = path.join(dir, 'session.jsonl');
});

afterEach(() => {
  for (const disposable of disposables.splice(0)) disposable.dispose();
  setConfigDir(undefined);
  fs.rmSync(dir, { recursive: true, force: true });
});

const at = (seconds: number) => new Date(Date.UTC(2026, 10, 1, 12, 0, seconds)).toISOString();
const line = (value: unknown) => JSON.stringify(value) + '\n';

const user = (seconds: number, text: string) =>
  line({ type: 'user', timestamp: at(seconds), message: { role: 'user', content: text } });
const toolUse = (seconds: number, id: string, name: string, input: Record<string, unknown>) =>
  line({
    type: 'assistant',
    timestamp: at(seconds),
    message: {
      id: `msg_${id}`,
      role: 'assistant',
      model: 'claude-opus-5-5',
      content: [{ type: 'tool_use', id, name, input }],
      usage: {
        input_tokens: 100,
        output_tokens: 20,
        cache_read_input_tokens: 1000,
        cache_creation_input_tokens: 0,
      },
    },
  });
const toolResult = (seconds: number, id: string, content: string, isError = false) =>
  line({
    type: 'user',
    timestamp: at(seconds),
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }],
    },
  });
const hook = (seconds: number, toolUseId: string) =>
  line({
    type: 'attachment',
    timestamp: at(seconds),
    attachment: {
      type: 'hook_success',
      hookName: 'PreToolUse:Bash',
      toolUseID: toolUseId,
      hookEvent: 'PreToolUse',
      content: '',
      stdout: 'secret hook output',
      stderr: '',
      exitCode: 0,
      command: 'bash guard.sh',
      durationMs: 650,
    },
  });

const SESSION =
  user(0, 'go') +
  toolUse(1, 't1', 'Read', { file_path: '/repo/src/index.ts' }) +
  toolResult(2, 't1', 'export {}') +
  toolUse(3, 't2', 'Bash', { command: 'npm test', description: 'Run the tests' }) +
  hook(3, 't2') +
  toolResult(6, 't2', 'FAIL', true);

/**
 * A monitor following `target` with a Claude reader that keeps activity
 * signals; `maxRecords` swaps in an activity log with that cap.
 */
function monitorOn(target: string, sessionId = 'session', maxRecords?: number) {
  const provider = new ClaudeCodeProvider();
  const monitor = new SessionMonitor(provider as never);
  const internals = monitor as unknown as MonitorInternals;
  if (maxRecords !== undefined) {
    (monitor as unknown as { activity: ActivityStore }).activity = new ActivityStore({
      recorder: toRecorderOptions(DEFAULT_ACTIVITY_MAP_SETTINGS, 'claude-code'),
      maxRecords,
    });
  }
  internals.sessionId = sessionId;
  internals.sessionPath = target;
  internals.reader = provider.createReader(target, { includeActivitySignals: true });
  monitor.getActivityStore().reset({ providerId: 'claude-code', sessionId });
  disposables.push(monitor);
  return { monitor, internals };
}

function touchLater(target: string): void {
  fs.utimesSync(target, new Date(), new Date(Date.now() + 5_000));
}

const station = (monitor: SessionMonitor, id: string) =>
  monitor
    .getActivityStore()
    .snapshot()
    .stations.find((s) => s.id === id);

describe('SessionMonitor activity log', () => {
  it('fills from the initial replay, without notifying until it ends', async () => {
    fs.writeFileSync(file, SESSION);
    const { monitor, internals } = monitorOn(file);
    const store = monitor.getActivityStore();
    const replayingAppends: boolean[] = [];
    disposables.push(store.onDidAppend(() => replayingAppends.push(monitor.isReplaying)));

    await internals.readInitialContent();

    expect(station(monitor, 'files')?.count).toBe(1);
    expect(station(monitor, 'shell')?.count).toBe(1);
    expect(station(monitor, 'shell')?.faults).toBe(1);
    expect(station(monitor, 'hooks')?.count).toBe(1);
    expect(store.snapshot().context?.window).toBeGreaterThan(0);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(replayingAppends).toEqual([false]);
  });

  it('keeps hook signals out of the message count, timeline and audit', async () => {
    fs.writeFileSync(file, SESSION);
    const withHooks = monitorOn(file, 'with-hooks');
    await withHooks.internals.readInitialContent();

    const plainFile = path.join(dir, 'plain.jsonl');
    fs.writeFileSync(
      plainFile,
      SESSION.split('\n')
        .filter((l) => !l.includes('hook_success'))
        .join('\n'),
    );
    const plain = monitorOn(plainFile, 'plain');
    await plain.internals.readInitialContent();

    expect(withHooks.monitor.getStats().messageCount).toBe(plain.monitor.getStats().messageCount);
    expect(withHooks.internals.timeline.length).toBe(plain.internals.timeline.length);
    expect(station(plain.monitor, 'hooks')?.count ?? 0).toBe(0);
    // Labels never carry the hook's output or command line.
    const json = JSON.stringify(withHooks.monitor.getActivityStore().records());
    expect(json).not.toContain('secret hook output');
    expect(json).not.toContain('guard.sh');
  });

  it('appends live growth and notifies', async () => {
    fs.writeFileSync(file, SESSION);
    const { monitor, internals } = monitorOn(file);
    await internals.readInitialContent();
    const store = monitor.getActivityStore();
    const before = store.nextSeq;
    const heard: number[] = [];
    disposables.push(store.onDidAppend((event) => heard.push(event.nextSeq)));

    fs.appendFileSync(file, toolUse(10, 't3', 'Grep', { pattern: 'TODO' }));
    touchLater(file);
    internals.processFileChange();

    expect(store.nextSeq).toBeGreaterThan(before);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(heard.at(-1)).toBe(store.nextSeq);
  });

  it('rebuilds the log in a new epoch when the reader starts over', async () => {
    fs.writeFileSync(file, SESSION);
    const { monitor, internals } = monitorOn(file);
    await internals.readInitialContent();
    const store = monitor.getActivityStore();
    const epoch = store.epoch;

    fs.writeFileSync(file, SESSION.replace('npm test', 'npm  test'));
    touchLater(file);
    internals.processFileChange();

    expect(store.epoch).toBeGreaterThan(epoch);
    expect(station(monitor, 'shell')?.count).toBe(1);
    expect(station(monitor, 'files')?.count).toBe(1);
  });

  it('checkpoints the log and restores it at the same reader position', async () => {
    fs.writeFileSync(file, SESSION);
    const first = monitorOn(file);
    await first.internals.readInitialContent();
    first.internals.persistSnapshot();
    const snapshot = loadSnapshot('session');
    expect(snapshot?.consumer.checkpointRevision).toBe(6);
    expect(snapshot?.consumer.activity).toMatchObject({
      base: { kind: 'sidekick-activity-state' },
    });

    const second = monitorOn(file);
    expect(second.internals.tryRestoreFromSnapshot(file)).toBe(true);
    await second.internals.readInitialContent();
    expect(second.monitor.getActivityStore().snapshot()).toEqual(
      first.monitor.getActivityStore().snapshot(),
    );
    expect(second.monitor.getActivityStore().records()).toEqual(
      first.monitor.getActivityStore().records(),
    );
  });

  it('resumes a log that dropped old records from its checkpoint', async () => {
    let long = user(0, 'go');
    for (let i = 0; i < 300; i++) {
      long += toolUse(1 + i * 2, `r${i}`, 'Read', { file_path: `/repo/src/f${i}.ts` });
      long += toolResult(2 + i * 2, `r${i}`, i % 11 === 0 ? 'boom' : 'ok', i % 11 === 0);
    }
    fs.writeFileSync(file, long);
    // A tiny cap (the timeline keeps at least two checkpoint intervals, 512).
    const first = monitorOn(file, 'session', 40);
    await first.internals.readInitialContent();
    const firstStore = first.monitor.getActivityStore();
    expect(firstStore.baseSeq).toBeGreaterThan(0);
    first.internals.persistSnapshot();
    const saved = loadSnapshot('session');
    expect(saved).not.toBeNull();

    const second = monitorOn(file, 'session', 40);
    expect(second.internals.tryRestoreFromSnapshot(file)).toBe(true);
    // Resumed where the checkpoint left off, and the snapshot is still there.
    expect(second.internals.reader?.getPosition()).toBe(saved!.readerPosition);
    expect(loadSnapshot('session')).not.toBeNull();
    await second.internals.readInitialContent();
    const secondStore = second.monitor.getActivityStore();
    expect(secondStore.snapshot()).toEqual(firstStore.snapshot());
    expect(secondStore.insights()).toEqual(firstStore.insights());
    expect(secondStore.records()).toEqual(firstStore.records());
    expect(station(second.monitor, 'files')?.count).toBe(300);
    expect(second.monitor.getStats().messageCount).toBe(first.monitor.getStats().messageCount);
  });

  it('rejects a revision-5 checkpoint, and one whose activity log cannot be restored', async () => {
    fs.writeFileSync(file, SESSION);
    const first = monitorOn(file);
    await first.internals.readInitialContent();
    first.internals.persistSnapshot();
    const snapshot = loadSnapshot('session')!;

    saveSnapshot({ ...snapshot, consumer: { ...snapshot.consumer, checkpointRevision: 5 } });
    const old = monitorOn(file);
    expect(old.internals.tryRestoreFromSnapshot(file)).toBe(false);
    expect(loadSnapshot('session')).toBeNull();

    saveSnapshot({
      ...snapshot,
      consumer: {
        ...snapshot.consumer,
        activity: { ...(snapshot.consumer.activity as object), base: { kind: 'garbage' } },
      },
    });
    const malformed = monitorOn(file);
    expect(malformed.internals.tryRestoreFromSnapshot(file)).toBe(false);
    expect(loadSnapshot('session')).toBeNull();
    // The reader starts over, so the replay that follows rebuilds everything.
    expect(malformed.internals.reader?.getPosition()).toBe(0);
    await malformed.internals.readInitialContent();
    expect(station(malformed.monitor, 'shell')?.count).toBe(1);
  });
});
