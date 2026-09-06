import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  createWatcher,
  loadSnapshot,
  saveSnapshot,
  setConfigDir,
  type SessionProviderBase,
  type SessionWatcher,
} from 'sidekick-shared';
import { DashboardState } from './DashboardState';

let directory: string;
const watchers: SessionWatcher[] = [];
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-checkpoint-'));
  setConfigDir(path.join(directory, 'config'));
});
afterEach(() => {
  for (const watcher of watchers.splice(0)) watcher.stop();
  vi.useRealTimers();
  setConfigDir(undefined);
  fs.rmSync(directory, { recursive: true, force: true });
});
function event(text: string, input: number): Buffer {
  return Buffer.from(
    JSON.stringify({
      type: 'assistant',
      timestamp: new Date(Date.UTC(2026, 8, 6, 12, 0, input)).toISOString(),
      message: {
        role: 'assistant',
        model: 'claude-sonnet-4-20250514',
        content: [{ type: 'text', text }],
        usage: { input_tokens: input, output_tokens: 1 },
      },
    }) + '\n',
  );
}
function attach(file: string, state: DashboardState, offset = 0, replay = true) {
  const provider = {
    id: 'claude-code',
    findAllSessions: () => [file],
    getSessionId: () => 'session',
  } as unknown as SessionProviderBase;
  const { watcher } = createWatcher({
    provider,
    workspacePath: directory,
    callbacks: {
      onEvent: (event) => state.processEvent(event),
      onError: (error) => {
        throw error;
      },
      onBatchComplete: () => state.persistSnapshot(watcher.getPosition!(), fs.statSync(file).size),
    },
  });
  watchers.push(watcher);
  watcher.seekTo!(offset);
  watcher.start(replay);
  if (replay) state.markHistoryReplayed(provider.id);
  state.persistSnapshot(watcher.getPosition!(), fs.statSync(file).size);
  return watcher;
}

it('restores complete metrics and Unicode after a partial-line checkpoint', () => {
  const filename = path.join(directory, 'session.jsonl');
  const first = event('first', 1);
  const second = event('café ☕', 2);
  const split = second.indexOf(Buffer.from('é')) + 1;
  fs.writeFileSync(filename, Buffer.concat([first, second.subarray(0, split)]));
  const initial = new DashboardState();
  initial.setSessionId('session');
  const watcher = attach(filename, initial);
  expect(loadSnapshot('session')?.readerPosition).toBe(first.length);
  watcher.stop();
  fs.appendFileSync(filename, second.subarray(split));

  const restored = new DashboardState();
  restored.setSessionId('session');
  const offset = restored.tryRestoreFromSnapshot(
    'session',
    'claude-code',
    fs.statSync(filename).size,
  );
  expect(offset).toBe(first.length);
  attach(filename, restored, offset!);
  const complete = new DashboardState();
  attach(filename, complete);
  expect(restored.getMetrics().tokens).toEqual(complete.getMetrics().tokens);
  expect(restored.getMetrics().tokens.input).toBe(3);
  expect(loadSnapshot('session')?.readerPosition).toBe(first.length + second.length);
});

it.each([undefined, 2])('rejects unsafe CLI checkpoint revision %s', (revision) => {
  const state = new DashboardState();
  state.setSessionId('session');
  state.markHistoryReplayed('claude-code');
  state.persistSnapshot(10, 10);
  const snapshot = loadSnapshot('session')!;
  snapshot.consumer.checkpointRevision = revision;
  saveSnapshot(snapshot);
  expect(new DashboardState().tryRestoreFromSnapshot('session', 'claude-code', 10)).toBeNull();
});

it('replays instead of restoring another dashboard consumer format', () => {
  const state = new DashboardState();
  state.setSessionId('session');
  state.markHistoryReplayed('claude-code');
  state.persistSnapshot(10, 10);
  const snapshot = loadSnapshot('session')!;
  snapshot.consumer.consumerType = 'vscode';
  saveSnapshot(snapshot);
  expect(new DashboardState().tryRestoreFromSnapshot('session', 'claude-code', 10)).toBeNull();
});

it.each([false, true])(
  'keeps full history after a live-only run (existing cache: %s)',
  (cached) => {
    vi.useFakeTimers();
    const filename = path.join(directory, 'session.jsonl');
    fs.writeFileSync(filename, event('history', 100));
    if (cached) {
      const complete = new DashboardState();
      complete.setSessionId('session');
      attach(filename, complete).stop();
    }
    const before = loadSnapshot('session');
    const live = new DashboardState();
    live.setSessionId('session');
    const watcher = attach(filename, live, 0, false);
    fs.appendFileSync(filename, event('live', 10));
    vi.advanceTimersByTime(30_000);
    expect(live.getMetrics().tokens.input).toBe(10);
    watcher.stop();
    // This is also the save attempted before a dashboard session switch.
    live.persistSnapshot(watcher.getPosition!(), fs.statSync(filename).size);
    expect(loadSnapshot('session')).toEqual(before);

    const reopened = new DashboardState();
    reopened.setSessionId('session');
    const offset = reopened.tryRestoreFromSnapshot(
      'session',
      'claude-code',
      fs.statSync(filename).size,
    );
    attach(filename, reopened, offset ?? 0).stop();
    expect(reopened.getMetrics().tokens.input).toBe(110);
  },
  30_000,
);

it.each(['reset', 'setSessionId'] as const)('clears checkpoint eligibility on %s', (operation) => {
  const state = new DashboardState();
  state.setSessionId('session');
  state.markHistoryReplayed('claude-code');
  if (operation === 'reset') state.reset();
  state.setSessionId('next');
  state.persistSnapshot(10, 10);
  expect(loadSnapshot('next')).toBeNull();
});

it('does not restore or replace OpenCode snapshots with timestamp-only cursors', () => {
  const state = new DashboardState();
  state.setSessionId('session');
  state.markHistoryReplayed('claude-code');
  state.persistSnapshot(100, 0);
  const snapshot = loadSnapshot('session')!;
  snapshot.providerId = 'opencode';
  saveSnapshot(snapshot);

  const reopened = new DashboardState();
  reopened.setSessionId('session');
  expect(reopened.tryRestoreFromSnapshot('session', 'opencode', 0)).toBeNull();
  reopened.markHistoryReplayed('opencode');
  reopened.persistSnapshot(200, 0);
  expect(loadSnapshot('session')).toEqual(snapshot);
});
