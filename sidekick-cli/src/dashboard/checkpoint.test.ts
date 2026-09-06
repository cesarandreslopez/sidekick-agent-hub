import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
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
  setConfigDir(undefined);
  fs.rmSync(directory, { recursive: true, force: true });
});
function event(text: string, input: number): Buffer {
  return Buffer.from(
    JSON.stringify({
      type: 'assistant',
      timestamp: `2026-09-06T12:00:0${input}Z`,
      message: {
        role: 'assistant',
        model: 'claude-sonnet-4-20250514',
        content: [{ type: 'text', text }],
        usage: { input_tokens: input, output_tokens: 1 },
      },
    }) + '\n',
  );
}
function attach(file: string, state: DashboardState, offset = 0) {
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
      onBatchComplete: () => state.persistSnapshot(watcher.getPosition!(), fs.statSync(file).size),
    },
  });
  watchers.push(watcher);
  watcher.seekTo!(offset);
  watcher.start(true);
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

it('rejects older CLI checkpoints that may have skipped unprocessed events', () => {
  const state = new DashboardState();
  state.setSessionId('session');
  state.persistSnapshot(10, 10);
  const snapshot = loadSnapshot('session')!;
  delete snapshot.consumer.checkpointRevision;
  saveSnapshot(snapshot);
  expect(new DashboardState().tryRestoreFromSnapshot('session', 'claude-code', 10)).toBeNull();
});

it('replays instead of restoring another dashboard consumer format', () => {
  const state = new DashboardState();
  state.setSessionId('session');
  state.persistSnapshot(10, 10);
  const snapshot = loadSnapshot('session')!;
  snapshot.consumer.consumerType = 'vscode';
  saveSnapshot(snapshot);
  expect(new DashboardState().tryRestoreFromSnapshot('session', 'claude-code', 10)).toBeNull();
});
