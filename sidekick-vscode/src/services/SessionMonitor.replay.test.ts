/**
 * The monitor reads a session in steps, yielding to the event loop between
 * them, so replaying (or catching up on) a long session never blocks the
 * extension host. The stepped result equals a one-pass read; file changes,
 * stops, session switches, and replaced files during a stepped read are
 * handled without double counting or a stale snapshot.
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

import {
  ClaudeCodeProvider,
  loadSnapshot,
  setConfigDir,
  type SessionReader,
} from 'sidekick-shared';
import { SessionMonitor, type SessionResetEvent } from './SessionMonitor';

/** The private surface these tests drive directly. */
interface MonitorInternals {
  sessionId: string | null;
  sessionPath: string | null;
  reader: SessionReader | null;
  lifecycleGeneration: number;
  activeDrain: number | null;
  readInitialContent(): Promise<void>;
  processFileChange(): void;
}

interface Totals {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheWriteTokens: number;
  totalCacheReadTokens: number;
  messageCount: number;
}

let dir: string;
let file: string;
const disposables: Array<{ dispose(): void }> = [];
const defaultChunk = SessionMonitor.INITIAL_REPLAY_CHUNK_BYTES;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-vscode-replay-'));
  setConfigDir(path.join(dir, 'config'));
  file = path.join(dir, 'session.jsonl');
  SessionMonitor.INITIAL_REPLAY_CHUNK_BYTES = 256;
});

afterEach(() => {
  SessionMonitor.INITIAL_REPLAY_CHUNK_BYTES = defaultChunk;
  for (const disposable of disposables.splice(0)) disposable.dispose();
  setConfigDir(undefined);
  fs.rmSync(dir, { recursive: true, force: true });
});

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

/** A session of `turns` prompts, each answered by a split response (usage repeated). */
function session(turns: number, prefix = 'msg'): string {
  let text = '';
  for (let i = 0; i < turns; i++) {
    text += user(`prompt ${i} ü🚀`) + block(`${prefix}_${i}`, 3, 'thinking');
    text += block(`${prefix}_${i}`, 10 + i, 'done');
  }
  return text;
}

function monitorOn(target: string, reader?: SessionReader) {
  const provider = new ClaudeCodeProvider();
  const monitor = new SessionMonitor(provider as never);
  const internals = monitor as unknown as MonitorInternals;
  internals.sessionId = 'session';
  internals.sessionPath = target;
  internals.reader = reader ?? provider.createReader(target);
  disposables.push(monitor);
  return { monitor, internals, provider };
}

const totals = (monitor: SessionMonitor): Totals => {
  const stats = monitor.getStats();
  return {
    totalInputTokens: stats.totalInputTokens,
    totalOutputTokens: stats.totalOutputTokens,
    totalCacheWriteTokens: stats.totalCacheWriteTokens,
    totalCacheReadTokens: stats.totalCacheReadTokens,
    messageCount: stats.messageCount,
  };
};

/** Totals of a monitor reading the file now at `target` in one pass. */
async function onePassTotals(target = file): Promise<Totals> {
  const chunk = SessionMonitor.INITIAL_REPLAY_CHUNK_BYTES;
  SessionMonitor.INITIAL_REPLAY_CHUNK_BYTES = 1 << 30;
  try {
    const { monitor, internals } = monitorOn(target);
    await internals.readInitialContent();
    return totals(monitor);
  } finally {
    SessionMonitor.INITIAL_REPLAY_CHUNK_BYTES = chunk;
  }
}

const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Waits for a stepped read in progress to end. */
async function settled(internals: MonitorInternals): Promise<void> {
  for (let i = 0; i < 100_000 && internals.activeDrain !== null; i++) await nextTurn();
  expect(internals.activeDrain).toBeNull();
}

describe('SessionMonitor stepped replay', () => {
  it('replays in yielding steps to the same totals as one pass', async () => {
    fs.writeFileSync(file, session(40));
    const expected = await onePassTotals();
    expect(expected.totalOutputTokens).toBe(40 * 10 + (39 * 40) / 2);

    const { monitor, internals } = monitorOn(file);
    const replayStates: boolean[] = [];
    const usage: number[] = [];
    disposables.push(
      monitor.onReplayStateChange((replaying) => replayStates.push(replaying)),
      monitor.onTokenUsage((event) => usage.push(event.outputTokens)),
    );
    let turns = 0;
    let replaying = true;
    const tick = () => {
      if (!replaying) return;
      turns += 1;
      setImmediate(tick);
    };
    setImmediate(tick);
    await internals.readInitialContent();
    replaying = false;

    expect(totals(monitor)).toEqual(expected);
    expect(turns).toBeGreaterThan(20);
    expect(replayStates).toEqual([true, false]);
    expect(usage).toEqual([]);
    expect(monitor.isReplaying).toBe(false);
    expect(internals.reader?.getPosition()).toBe(fs.statSync(file).size);
  });

  it('defers a file change that arrives mid-replay and handles it once afterwards', async () => {
    fs.writeFileSync(file, session(20));
    const { monitor, internals } = monitorOn(file);
    const usage: number[] = [];
    disposables.push(monitor.onTokenUsage((event) => usage.push(event.outputTokens)));
    const readNew = vi.spyOn(internals.reader!, 'readNew');

    const replay = internals.readInitialContent();
    await nextTurn();
    expect(monitor.isReplaying).toBe(true);
    fs.appendFileSync(file, user('later') + block('msg_late', 77, 'late'));
    internals.processFileChange();
    // Nothing read out of turn: the change waits for the replay.
    expect(readNew).not.toHaveBeenCalled();
    await replay;
    expect(usage).toEqual([]);
    // The replay read up to the size it began with; the deferred change follows.
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(usage).toEqual([77]);
    expect(totals(monitor)).toEqual(await onePassTotals());
  });

  it('stops mid-replay without writing a snapshot', async () => {
    fs.writeFileSync(file, session(30));
    const { monitor, internals } = monitorOn(file);
    const replayStates: boolean[] = [];
    disposables.push(monitor.onReplayStateChange((replaying) => replayStates.push(replaying)));
    const replay = internals.readInitialContent();
    await nextTurn();
    await nextTurn();
    monitor.stop();
    await replay;
    expect(loadSnapshot('session')).toBeNull();
    expect(monitor.isReplaying).toBe(false);
    expect(replayStates).toEqual([true, false]);
    expect(internals.activeDrain).toBeNull();
  });

  it('abandons a replay when another session takes over mid-way', async () => {
    const other = path.join(dir, 'other.jsonl');
    fs.writeFileSync(file, session(30, 'old'));
    fs.writeFileSync(other, session(5, 'new'));
    const { monitor, internals, provider } = monitorOn(file);
    const replayStates: boolean[] = [];
    disposables.push(monitor.onReplayStateChange((replaying) => replayStates.push(replaying)));

    const first = internals.readInitialContent();
    await nextTurn();
    // What attachToSession does: a new generation with a new reader, replayed at once.
    internals.lifecycleGeneration += 1;
    internals.sessionPath = other;
    internals.reader = provider.createReader(other);
    (monitor as unknown as { resetSessionProcessingState(): void }).resetSessionProcessingState();
    const second = internals.readInitialContent();
    await Promise.all([first, second]);

    expect(totals(monitor)).toEqual(await onePassTotals(other));
    expect(monitor.isReplaying).toBe(false);
    // The replays overlapped: one transition each way.
    expect(replayStates).toEqual([true, false]);
  });

  it('starts over on the step after the file is replaced mid-replay', async () => {
    fs.writeFileSync(file, session(30, 'old'));
    const { monitor, internals } = monitorOn(file);
    const replay = internals.readInitialContent();
    await nextTurn();
    fs.writeFileSync(`${file}.next`, session(8, 'new'));
    fs.renameSync(`${file}.next`, file);
    await replay;
    const expected = await onePassTotals();
    expect(expected.totalOutputTokens).toBe(8 * 10 + 28);
    expect(totals(monitor)).toEqual(expected);
  });

  it('reads a reader without readNewBounded in one step', async () => {
    fs.writeFileSync(file, session(12));
    const real = new ClaudeCodeProvider().createReader(file);
    const plain: SessionReader = {
      readNew: () => real.readNew(),
      readAll: () => real.readAll(),
      reset: () => real.reset(),
      exists: () => real.exists(),
      flush: () => real.flush(),
      getPosition: () => real.getPosition(),
      seekTo: (position) => real.seekTo(position),
      wasTruncated: () => real.wasTruncated(),
    };
    const readNew = vi.spyOn(plain, 'readNew');
    const { monitor, internals } = monitorOn(file, plain);
    await internals.readInitialContent();
    expect(readNew).toHaveBeenCalledTimes(1);
    expect(totals(monitor)).toEqual(await onePassTotals());
  });
});

describe('SessionMonitor stepped file changes', () => {
  async function attached(content: string) {
    fs.writeFileSync(file, content);
    const { monitor, internals } = monitorOn(file);
    const resets: SessionResetEvent[] = [];
    const replayStates: boolean[] = [];
    const usage: number[] = [];
    disposables.push(
      monitor.onSessionReset((event) => resets.push(event)),
      monitor.onReplayStateChange((replaying) => replayStates.push(replaying)),
      monitor.onTokenUsage((event) => usage.push(event.outputTokens)),
    );
    await internals.readInitialContent();
    replayStates.length = 0;
    return { monitor, internals, resets, replayStates, usage };
  }

  it('handles an append that fits one step in the same call', async () => {
    SessionMonitor.INITIAL_REPLAY_CHUNK_BYTES = 64 * 1024;
    const { monitor, internals, usage } = await attached(session(3));
    fs.appendFileSync(file, block('msg_x', 5, 'x'));
    internals.processFileChange();
    expect(usage).toEqual([5]);
    expect(internals.activeDrain).toBeNull();
    expect(totals(monitor)).toEqual(await onePassTotals());
  });

  it('catches up on a large append in steps with the notifications of one step', async () => {
    const appended = session(20, 'more');
    // Reference: the same append read in one step.
    SessionMonitor.INITIAL_REPLAY_CHUNK_BYTES = 1 << 30;
    const reference = await attached(session(3));
    fs.appendFileSync(file, appended);
    reference.internals.processFileChange();
    const expectedUsage = [...reference.usage];
    expect(expectedUsage.reduce((sum, value) => sum + value, 0)).toBe(20 * 10 + 190);

    SessionMonitor.INITIAL_REPLAY_CHUNK_BYTES = 256;
    const { monitor, internals, usage } = await attached(session(3));
    fs.appendFileSync(file, appended);
    internals.processFileChange();
    expect(internals.activeDrain).not.toBeNull();
    // A change arriving meanwhile is deferred, not read out of turn.
    internals.processFileChange();
    await settled(internals);
    expect(usage).toEqual(expectedUsage);
    expect(totals(monitor)).toEqual(totals(reference.monitor));
    expect(monitor.isReplaying).toBe(false);
  });

  it('rebuilds silently in steps when the reader starts over, then announces the reset', async () => {
    const { monitor, internals, resets, replayStates, usage } = await attached(session(3));
    fs.writeFileSync(`${file}.next`, session(25, 'new'));
    fs.renameSync(`${file}.next`, file);
    internals.processFileChange();
    expect(monitor.isReplaying).toBe(true);
    expect(resets).toEqual([]);
    await settled(internals);

    expect(resets).toEqual([{ sessionPath: file, reason: 'replaced' }]);
    expect(replayStates).toEqual([true, false]);
    expect(usage).toEqual([]);
    expect(totals(monitor)).toEqual(await onePassTotals());
    // The rebuilt state was checkpointed at the new end of the file.
    const snapshot = loadSnapshot('session');
    expect(snapshot?.readerPosition).toBe(fs.statSync(file).size);
  });

  it('a stop during a stepped catch-up leaves no snapshot behind', async () => {
    const { monitor, internals } = await attached(session(3));
    fs.writeFileSync(`${file}.next`, session(25, 'new'));
    fs.renameSync(`${file}.next`, file);
    internals.processFileChange();
    monitor.stop();
    for (let i = 0; i < 5; i++) await nextTurn();
    expect(loadSnapshot('session')).toBeNull();
    expect(monitor.isReplaying).toBe(false);
  });
});
