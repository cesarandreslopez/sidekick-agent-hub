import { EventEmitter } from 'node:events';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const watchMock = vi.hoisted(() => vi.fn());
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return { ...actual, watch: watchMock };
});

import { JsonlSessionWatcher } from './jsonlWatcher';
import type { FollowEvent } from './types';

const directories: string[] = [];
const watchers: JsonlSessionWatcher[] = [];
function file(content: string | Buffer = ''): string {
  const directory = mkdtempSync(path.join(tmpdir(), 'sidekick-watcher-'));
  directories.push(directory);
  const filename = path.join(directory, 'session.jsonl');
  writeFileSync(filename, content);
  return filename;
}
function event(text: string): Buffer {
  return Buffer.from(JSON.stringify({ type: 'user', message: { content: text } }) + '\n');
}
function create(filename: string, events: FollowEvent[], onBatchComplete?: () => void) {
  const watcher = new JsonlSessionWatcher('claude-code', filename, {
    onEvent: (event) => events.push(event),
    onBatchComplete,
  });
  watchers.push(watcher);
  return watcher;
}
afterEach(() => {
  for (const watcher of watchers.splice(0)) watcher.stop();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
  vi.useRealTimers();
  watchMock.mockReset();
});

describe('JsonlSessionWatcher', () => {
  it('reports fs.watch errors and keeps catch-up polling active', async () => {
    vi.useFakeTimers();
    const fsWatcher = Object.assign(new EventEmitter(), { close: vi.fn() });
    watchMock.mockReturnValue(fsWatcher);
    const onError = vi.fn();
    const onEvent = vi.fn();
    const filename = file();
    const watcher = new JsonlSessionWatcher('claude-code', filename, { onEvent, onError });
    watchers.push(watcher);
    watcher.start(false);
    const error = new Error('watch limit reached');
    fsWatcher.emit('error', error);
    expect(onError).toHaveBeenCalledWith(error);
    expect(fsWatcher.close).toHaveBeenCalledOnce();
    appendFileSync(filename, event('polling still works'));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({ summary: 'polling still works' }),
    );
    expect(watcher.isActive).toBe(true);
  });

  it('preserves UTF-8 split across reads and checkpoints only complete lines', async () => {
    vi.useFakeTimers();
    const bytes = event('café ☕');
    const split = bytes.indexOf(Buffer.from('é')) + 1;
    const filename = file(bytes.subarray(0, split));
    const events: FollowEvent[] = [];
    const checkpoints: Array<{ count: number; offset: number }> = [];
    const watcher = create(filename, events, () =>
      checkpoints.push({ count: events.length, offset: watcher.getPosition() }),
    );
    watcher.start(true);
    expect(watcher.getPosition()).toBe(0);
    appendFileSync(filename, bytes.subarray(split));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(events.map((event) => event.summary)).toEqual(['café ☕']);
    expect(checkpoints).toEqual([
      { count: 0, offset: 0 },
      { count: 1, offset: bytes.length },
    ]);
  });

  it('restores a partial line without losing or duplicating events', async () => {
    vi.useFakeTimers();
    const first = event('first');
    const second = event('second');
    const filename = file(Buffer.concat([first, second.subarray(0, 15)]));
    const seen: FollowEvent[] = [];
    const original = create(filename, seen);
    original.start(true);
    const offset = original.getPosition();
    original.stop();
    expect(offset).toBe(first.length);
    appendFileSync(filename, second.subarray(15));
    const resumed = create(filename, seen);
    resumed.seekTo(offset);
    resumed.start(true);
    const replayed: FollowEvent[] = [];
    create(filename, replayed).start(true);
    expect(seen.map((event) => event.summary)).toEqual(replayed.map((event) => event.summary));
    expect(seen).toHaveLength(2);
  });

  it('notifies checkpoint consumers after every event in a batch', () => {
    const bytes = Buffer.concat([event('one'), event('two')]);
    const filename = file(bytes);
    const events: FollowEvent[] = [];
    const checkpoints: number[] = [];
    const watcher = create(filename, events, () => {
      expect(watcher.getPosition()).toBe(bytes.length);
      checkpoints.push(events.length);
    });
    watcher.start(true);
    expect(checkpoints).toEqual([2]);
  });

  it('follows a partial final line when starting without replay', async () => {
    vi.useFakeTimers();
    const pending = event('new event');
    const filename = file(Buffer.concat([event('old event'), pending.subarray(0, 15)]));
    const events: FollowEvent[] = [];
    const watcher = create(filename, events);
    watcher.start(false);
    appendFileSync(filename, pending.subarray(15));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(events.map((event) => event.summary)).toEqual(['new event']);
  });

  it('counts each Claude response once across its split lines', () => {
    watchMock.mockReturnValue(Object.assign(new EventEmitter(), { close: vi.fn() }));
    const split = (output: number, text: string) =>
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-09-01T00:00:00.000Z',
        message: {
          id: 'msg_1',
          role: 'assistant',
          model: 'claude-opus-4-6',
          content: [{ type: 'text', text }],
          usage: { input_tokens: 10, output_tokens: output, cache_read_input_tokens: 100 },
        },
      }) + '\n';
    const events: FollowEvent[] = [];
    const watcher = create(file(split(1, 'a') + split(1, 'b') + split(40, 'c')), events);
    watcher.start(true);
    const withTokens = events.filter((e) => e.tokens);
    expect(withTokens).toHaveLength(2);
    expect(withTokens[0]).toMatchObject({
      tokens: { input: 10, output: 1 },
      cacheTokens: { read: 100 },
    });
    expect(withTokens[1]).toMatchObject({
      tokens: { input: 0, output: 39 },
      usageKind: 'correction',
    });
  });

  it('skips duplicate Codex token_count events and splits cached input', () => {
    watchMock.mockReturnValue(Object.assign(new EventEmitter(), { close: vi.fn() }));
    const usage = {
      input_tokens: 1000,
      cached_input_tokens: 800,
      output_tokens: 50,
      total_tokens: 1050,
    };
    const tokenCount =
      JSON.stringify({
        type: 'event_msg',
        timestamp: '2026-09-01T00:00:00.000Z',
        payload: {
          type: 'token_count',
          info: { last_token_usage: usage, total_token_usage: usage },
        },
      }) + '\n';
    const events: FollowEvent[] = [];
    const watcher = new JsonlSessionWatcher('codex', file(tokenCount + tokenCount), {
      onEvent: (event) => events.push(event),
    });
    watchers.push(watcher);
    watcher.start(true);
    const withTokens = events.filter((e) => e.tokens);
    expect(withTokens).toHaveLength(1);
    expect(withTokens[0]).toMatchObject({
      tokens: { input: 200, output: 50 },
      cacheTokens: { read: 800 },
    });
  });
});
