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
  window: { showErrorMessage: vi.fn() },
}));

vi.mock('./Logger', () => ({
  log: vi.fn(),
  logError: vi.fn(),
}));

import { ClaudeCodeProvider, loadSnapshot, saveSnapshot, setConfigDir } from 'sidekick-shared';
import { SessionMonitor } from './SessionMonitor';

/** The private snapshot surface these tests drive directly. */
interface SnapshotInternals {
  sessionId: string | null;
  sessionPath: string | null;
  reader: unknown;
  persistSnapshot(): void;
  tryRestoreFromSnapshot(sessionPath: string): boolean;
  readInitialContent(): Promise<void>;
}

const LINES = ['{"type":"user","n":1}\n', '{"type":"assistant","n":2}\n'];
const CONTENT = LINES.join('');

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-vscode-snapshot-'));
  setConfigDir(path.join(dir, 'config'));
  file = path.join(dir, 'session.jsonl');
  fs.writeFileSync(file, CONTENT);
});

afterEach(() => {
  setConfigDir(undefined);
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A claude-code monitor on `file` whose reader sits at `position`. */
function monitorAt(position: number) {
  const seekTo = vi.fn();
  const reader = {
    readNew: () => [],
    readAll: () => [],
    reset: () => {},
    exists: () => true,
    flush: () => {},
    getPosition: () => position,
    seekTo,
    wasTruncated: () => false,
  };
  const provider = {
    id: 'claude-code',
    displayName: 'Claude Code',
    getSessionId: () => 'session',
    createReader: () => reader,
    dispose: vi.fn(),
  };
  const monitor = new SessionMonitor(provider as never);
  const internals = monitor as unknown as SnapshotInternals;
  internals.sessionId = 'session';
  internals.sessionPath = file;
  internals.reader = reader;
  return { monitor, internals, seekTo };
}

describe('SessionMonitor snapshots', () => {
  it('records a source checkpoint and resumes after the file only grew', () => {
    const position = Buffer.byteLength(CONTENT);
    monitorAt(position).internals.persistSnapshot();
    const saved = loadSnapshot('session')!;
    expect(saved.consumer.checkpointRevision).toBe(5);
    expect(saved.readerPosition).toBe(position);
    expect(saved.sourceCheckpoint).toMatchObject({ version: 1, offset: position });

    fs.appendFileSync(file, '{"type":"assistant","n":3}\n');
    const { internals, seekTo } = monitorAt(0);
    expect(internals.tryRestoreFromSnapshot(file)).toBe(true);
    expect(seekTo).toHaveBeenCalledWith(position);
  });

  it('replays when the file was rewritten to the same size', () => {
    monitorAt(Buffer.byteLength(CONTENT)).internals.persistSnapshot();
    fs.writeFileSync(file, CONTENT.replace('user', 'USER'));
    const { internals, seekTo } = monitorAt(0);
    expect(internals.tryRestoreFromSnapshot(file)).toBe(false);
    expect(seekTo).not.toHaveBeenCalled();
    expect(loadSnapshot('session')).toBeNull();
  });

  it('replays when the file was replaced by another one', () => {
    monitorAt(Buffer.byteLength(CONTENT)).internals.persistSnapshot();
    fs.writeFileSync(`${file}.next`, CONTENT);
    fs.renameSync(`${file}.next`, file);
    expect(monitorAt(0).internals.tryRestoreFromSnapshot(file)).toBe(false);
  });

  it('omits the checkpoint for a position that is not resume-safe, and replays', () => {
    monitorAt(Buffer.byteLength(LINES[0]) - 1).internals.persistSnapshot();
    expect(loadSnapshot('session')?.sourceCheckpoint).toBeUndefined();
    expect(monitorAt(0).internals.tryRestoreFromSnapshot(file)).toBe(false);
  });

  it.each([
    [
      'revision 3',
      (snapshot: Record<string, unknown>) => {
        (snapshot.consumer as Record<string, unknown>).checkpointRevision = 3;
      },
    ],
    [
      'revision 4',
      (snapshot: Record<string, unknown>) => {
        (snapshot.consumer as Record<string, unknown>).checkpointRevision = 4;
      },
    ],
    [
      'no source checkpoint',
      (snapshot: Record<string, unknown>) => {
        delete snapshot.sourceCheckpoint;
      },
    ],
  ])('replays an older snapshot (%s) once', (_label, downgrade) => {
    monitorAt(Buffer.byteLength(CONTENT)).internals.persistSnapshot();
    const snapshot = loadSnapshot('session')!;
    downgrade(snapshot as unknown as Record<string, unknown>);
    saveSnapshot(snapshot);
    expect(monitorAt(0).internals.tryRestoreFromSnapshot(file)).toBe(false);
    expect(loadSnapshot('session')).toBeNull();
  });

  describe('with a real Claude Code reader', () => {
    const claude = new ClaudeCodeProvider();
    /** One API response written as content-block lines that each repeat its usage. */
    const block = (id: string, output: number, text: string) =>
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-09-06T12:00:00Z',
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
        timestamp: '2026-09-06T12:00:00Z',
        message: { role: 'user', content: text },
      }) + '\n';
    const head = user('go') + block('msg_1', 4, 'thinking');
    // The snapshot is taken after the first block of msg_1: its other blocks follow.
    const tail =
      block('msg_1', 4, 'more') +
      block('msg_1', 323, 'done') +
      user('next') +
      block('msg_2', 7, 'ok');

    function attached(withResumeState = true): SessionMonitor & { internals: SnapshotInternals } {
      const provider = {
        id: 'claude-code',
        displayName: 'Claude Code',
        getSessionId: () => 'session',
        createReader: (sessionPath: string) => {
          const reader = claude.createReader(sessionPath);
          // A reader from before resume state existed.
          if (!withResumeState) Object.assign(reader, { restoreResumeState: undefined });
          return reader;
        },
        dispose: vi.fn(),
      };
      const monitor = new SessionMonitor(provider as never);
      const internals = monitor as unknown as SnapshotInternals;
      internals.sessionId = 'session';
      internals.sessionPath = file;
      internals.reader = provider.createReader(file);
      return Object.assign(monitor, { internals });
    }

    const totals = (monitor: SessionMonitor) => {
      const stats = monitor.getStats();
      return {
        input: stats.totalInputTokens,
        output: stats.totalOutputTokens,
        cacheRead: stats.totalCacheReadTokens,
        cacheWrite: stats.totalCacheWriteTokens,
        tokens: monitor.getAggregatedMetrics().tokens,
      };
    };

    it('resumes mid-response with the same totals as a full replay', async () => {
      fs.writeFileSync(file, head);
      const first = attached();
      await first.internals.readInitialContent();
      first.internals.persistSnapshot();
      expect(loadSnapshot('session')?.readerState).toMatchObject({
        version: 1,
        entries: [['msg_1', { output: 4 }]],
      });
      fs.appendFileSync(file, tail);

      const resumed = attached();
      expect(resumed.internals.tryRestoreFromSnapshot(file)).toBe(true);
      await resumed.internals.readInitialContent();

      const full = attached();
      await full.internals.readInitialContent();
      expect(totals(resumed)).toEqual(totals(full));
      expect(totals(full).output).toBe(323 + 7);

      // Without its reader state the resumed monitor counts msg_1's first block twice.
      const unaware = attached(false);
      expect(unaware.internals.tryRestoreFromSnapshot(file)).toBe(true);
      await unaware.internals.readInitialContent();
      expect(totals(unaware).output).toBe(totals(full).output + 4);
    });

    it('replays from the start when the reader rejects the snapshot state', async () => {
      fs.writeFileSync(file, head);
      const first = attached();
      await first.internals.readInitialContent();
      first.internals.persistSnapshot();
      const snapshot = loadSnapshot('session')!;
      snapshot.readerState = { version: 1, entries: [['msg_1', { output: -1 }]] };
      saveSnapshot(snapshot);
      fs.appendFileSync(file, tail);

      const replayed = attached();
      expect(replayed.internals.tryRestoreFromSnapshot(file)).toBe(false);
      expect(loadSnapshot('session')).toBeNull();
      await replayed.internals.readInitialContent();
      const full = attached();
      await full.internals.readInitialContent();
      expect(totals(replayed)).toEqual(totals(full));
    });
  });
});
