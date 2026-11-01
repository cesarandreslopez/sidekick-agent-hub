import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CodexProvider,
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
/** A Claude Code watcher feeding `state` and checkpointing as the dashboard does; not started. */
function watch(file: string, state: DashboardState) {
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
      onBatchComplete: () =>
        state.persistSnapshot(watcher.getPosition!(), file, watcher.getResumeState?.()),
    },
  });
  watchers.push(watcher);
  return watcher;
}
function attach(file: string, state: DashboardState, offset = 0, replay = true) {
  const watcher = watch(file, state);
  watcher.seekTo!(offset);
  watcher.start(replay);
  if (replay) state.markHistoryReplayed('claude-code');
  state.persistSnapshot(watcher.getPosition!(), file, watcher.getResumeState?.());
  return watcher;
}
/** One line of a Claude response; every line of `msg_split` repeats its usage. */
function block(output: number, text: string): Buffer {
  return Buffer.from(
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-09-06T12:00:00.000Z',
      message: {
        id: 'msg_split',
        role: 'assistant',
        model: 'claude-sonnet-4-20250514',
        content: [{ type: 'text', text }],
        usage: { input_tokens: 10, output_tokens: output, cache_read_input_tokens: 500 },
      },
    }) + '\n',
  );
}

/** A session file with two complete events, and a CLI snapshot taken at its end. */
function checkpointedSession(): { filename: string; size: number } {
  const filename = path.join(directory, 'session.jsonl');
  fs.writeFileSync(filename, Buffer.concat([event('one', 1), event('two', 2)]));
  const state = new DashboardState();
  state.setSessionId('session');
  state.markHistoryReplayed('claude-code');
  const size = fs.statSync(filename).size;
  state.persistSnapshot(size, filename);
  return { filename, size };
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
  const offset = restored.tryRestoreFromSnapshot('session', 'claude-code', filename);
  expect(offset).toBe(first.length);
  attach(filename, restored, offset!);
  const complete = new DashboardState();
  attach(filename, complete);
  expect(restored.getMetrics().tokens).toEqual(complete.getMetrics().tokens);
  expect(restored.getMetrics().tokens.input).toBe(3);
  expect(loadSnapshot('session')?.readerPosition).toBe(first.length + second.length);
});

describe('a checkpoint that splits one Claude response', () => {
  /** Session file holding the first line of `msg_split`, checkpointed there, then the rest. */
  function splitSession(): { filename: string; offset: number } {
    const filename = path.join(directory, 'session.jsonl');
    const head = block(4, 'thinking');
    fs.writeFileSync(filename, head);
    const initial = new DashboardState();
    initial.setSessionId('session');
    attach(filename, initial).stop();
    fs.appendFileSync(
      filename,
      Buffer.concat([block(4, 'more'), block(323, 'done'), event('after', 2)]),
    );
    return { filename, offset: head.length };
  }

  function fullReplay(filename: string) {
    const complete = new DashboardState();
    attach(filename, complete);
    return complete.getMetrics().tokens;
  }

  it('resumes with the same totals as a full replay', () => {
    const { filename, offset } = splitSession();
    const checkpoint = loadSnapshot('session')!;
    expect(checkpoint.readerState).toMatchObject({
      version: 1,
      entries: [['msg_split', { output: 4 }]],
    });
    const restored = new DashboardState();
    restored.setSessionId('session');
    const watcher = watch(filename, restored);
    expect(restored.tryRestoreFromSnapshot('session', 'claude-code', filename, watcher)).toBe(
      offset,
    );
    expect(watcher.getPosition!()).toBe(offset);
    watcher.start(true);
    const complete = fullReplay(filename);
    expect(restored.getMetrics().tokens).toEqual(complete);
    expect(complete.output).toBe(323 + 1);

    // Seeking without the reader state counts the response's first line twice.
    saveSnapshot(checkpoint);
    const unaware = new DashboardState();
    unaware.setSessionId('session');
    attach(filename, unaware, unaware.tryRestoreFromSnapshot('session', 'claude-code', filename)!);
    expect(unaware.getMetrics().tokens.output).toBe(complete.output + 4);
  });

  it.each([
    ['missing', undefined],
    ['invalid', { version: 1, entries: [['msg_split', { output: 'four' }]] }],
  ])('replays from the start when the reader state is %s', (_label, readerState) => {
    const { filename } = splitSession();
    const snapshot = loadSnapshot('session')!;
    if (readerState === undefined) delete snapshot.readerState;
    else snapshot.readerState = readerState;
    saveSnapshot(snapshot);

    const replayed = new DashboardState();
    replayed.setSessionId('session');
    const watcher = watch(filename, replayed);
    expect(replayed.tryRestoreFromSnapshot('session', 'claude-code', filename, watcher)).toBeNull();
    expect(loadSnapshot('session')).toBeNull();
    expect(watcher.getPosition!()).toBe(0);
    watcher.start(true);
    expect(replayed.getMetrics().tokens).toEqual(fullReplay(filename));
  });
});

it('records a source checkpoint at the reader position and revision 5', () => {
  const { filename, size } = checkpointedSession();
  const snapshot = loadSnapshot('session')!;
  expect(snapshot.consumer.checkpointRevision).toBe(5);
  expect(snapshot.sourceSize).toBe(size);
  expect(snapshot.sourceCheckpoint).toMatchObject({ version: 1, offset: size });
  fs.appendFileSync(filename, event('three', 3));
  expect(new DashboardState().tryRestoreFromSnapshot('session', 'claude-code', filename)).toBe(
    size,
  );
});

it.each([undefined, 2, 3, 4])('rejects unsafe CLI checkpoint revision %s', (revision) => {
  const { filename } = checkpointedSession();
  const snapshot = loadSnapshot('session')!;
  snapshot.consumer.checkpointRevision = revision;
  saveSnapshot(snapshot);
  expect(
    new DashboardState().tryRestoreFromSnapshot('session', 'claude-code', filename),
  ).toBeNull();
});

it('replays instead of restoring another dashboard consumer format', () => {
  const { filename } = checkpointedSession();
  const snapshot = loadSnapshot('session')!;
  snapshot.consumer.consumerType = 'vscode';
  saveSnapshot(snapshot);
  expect(
    new DashboardState().tryRestoreFromSnapshot('session', 'claude-code', filename),
  ).toBeNull();
});

it('replays a session file rewritten to the same size', () => {
  const { filename, size } = checkpointedSession();
  fs.writeFileSync(filename, Buffer.concat([event('ONE', 1), event('TWO', 2)]));
  expect(fs.statSync(filename).size).toBe(size);
  expect(
    new DashboardState().tryRestoreFromSnapshot('session', 'claude-code', filename),
  ).toBeNull();
  expect(loadSnapshot('session')).toBeNull();
});

it('replays a session file replaced by another file with the same content', () => {
  const { filename } = checkpointedSession();
  fs.writeFileSync(`${filename}.next`, fs.readFileSync(filename));
  fs.renameSync(`${filename}.next`, filename);
  expect(
    new DashboardState().tryRestoreFromSnapshot('session', 'claude-code', filename),
  ).toBeNull();
});

it('replays a snapshot written without a source checkpoint', () => {
  const { filename } = checkpointedSession();
  const snapshot = loadSnapshot('session')!;
  delete snapshot.sourceCheckpoint;
  saveSnapshot(snapshot);
  expect(
    new DashboardState().tryRestoreFromSnapshot('session', 'claude-code', filename),
  ).toBeNull();
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
    live.persistSnapshot(watcher.getPosition!(), filename);
    expect(loadSnapshot('session')).toEqual(before);

    const reopened = new DashboardState();
    reopened.setSessionId('session');
    const offset = reopened.tryRestoreFromSnapshot('session', 'claude-code', filename);
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
  state.persistSnapshot(10, undefined);
  expect(loadSnapshot('next')).toBeNull();
});

it('does not restore or replace OpenCode snapshots with timestamp-only cursors', () => {
  const state = new DashboardState();
  state.setSessionId('session');
  state.markHistoryReplayed('claude-code');
  state.persistSnapshot(100, undefined);
  const snapshot = loadSnapshot('session')!;
  snapshot.providerId = 'opencode';
  saveSnapshot(snapshot);

  const reopened = new DashboardState();
  reopened.setSessionId('session');
  const database = path.join(directory, 'opencode.db');
  expect(reopened.tryRestoreFromSnapshot('session', 'opencode', database)).toBeNull();
  reopened.markHistoryReplayed('opencode');
  reopened.persistSnapshot(200, database);
  expect(loadSnapshot('session')).toEqual(snapshot);
});

describe('a session file that starts over while followed', () => {
  const codexLine = (row: unknown) => JSON.stringify(row) + '\n';
  const codexTokens = (input: number, output: number) =>
    codexLine({
      type: 'event_msg',
      timestamp: '2026-11-01T12:00:02Z',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: {
            input_tokens: input,
            cached_input_tokens: 0,
            output_tokens: output,
            total_tokens: input + output,
          },
        },
      },
    });
  const codexHead =
    codexLine({ type: 'session_meta', payload: { id: 'session', cwd: '/workspace' } }) +
    codexLine({ type: 'turn_context', payload: { model: 'gpt-5-codex', cwd: '/workspace' } });

  const cases = {
    'claude-code': {
      before: () => Buffer.concat([event('one', 1), event('two', 2)]),
      // Same size, other usage: only the rewrite's totals may remain.
      after: () => Buffer.concat([event('one', 5), event('two', 6)]),
      provider: (file: string) =>
        ({
          id: 'claude-code',
          findAllSessions: () => [file],
          getSessionId: () => 'session',
        }) as unknown as SessionProviderBase,
      expectedInput: 11,
    },
    codex: {
      before: () => Buffer.from(codexHead + codexTokens(1000, 100)),
      after: () => Buffer.from(codexHead + codexTokens(3000, 300)),
      provider: (file: string) =>
        new (class extends CodexProvider {
          findAllSessions(): string[] {
            return [file];
          }
          getSessionId(): string {
            return 'session';
          }
        })(),
      expectedInput: 3000,
    },
  } as const;

  it.each(Object.keys(cases) as Array<keyof typeof cases>)(
    'replaces the stale checkpoint once the replay batch completes (%s)',
    (providerId) => {
      vi.useFakeTimers();
      const scenario = cases[providerId];
      const filename = path.join(directory, 'session.jsonl');
      fs.writeFileSync(filename, scenario.before());
      const state = new DashboardState();
      state.setSessionId('session');
      // Wired as the dashboard wires it.
      const { watcher } = createWatcher({
        provider: scenario.provider(filename),
        workspacePath: directory,
        callbacks: {
          onEvent: (followed) => state.processEvent(followed),
          onError: (error) => {
            throw error;
          },
          onReset: () => state.beginResetReplay(),
          onBatchComplete: () => {
            if (state.completeResetReplay(providerId)) {
              state.persistSnapshot(watcher.getPosition!(), filename, watcher.getResumeState?.());
            }
          },
        },
      });
      watchers.push(watcher);
      watcher.start(true);
      state.markHistoryReplayed(providerId);
      state.persistSnapshot(watcher.getPosition!(), filename, watcher.getResumeState?.());
      const stale = loadSnapshot('session')!;

      const size = fs.statSync(filename).size;
      fs.writeFileSync(filename, scenario.after());
      expect(fs.statSync(filename).size).toBe(size);
      fs.utimesSync(filename, new Date(), new Date(Date.now() + 5_000));
      vi.advanceTimersByTime(30_000);

      expect(state.getMetrics().tokens.input).toBe(scenario.expectedInput);
      const fresh = loadSnapshot('session')!;
      expect(fresh.createdAt >= stale.createdAt).toBe(true);
      expect(fresh.sourceCheckpoint).not.toEqual(stale.sourceCheckpoint);
      // The new checkpoint describes the rewritten file, so it resumes.
      const reopened = new DashboardState();
      reopened.setSessionId('session');
      expect(reopened.tryRestoreFromSnapshot('session', providerId, filename)).toBe(size);
      expect(reopened.getMetrics().tokens.input).toBe(scenario.expectedInput);
    },
  );
});
