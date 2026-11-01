import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventAggregator } from '../aggregation/EventAggregator';
import { setConfigDir } from '../paths';
import { CodexProvider } from '../providers/codex';
import { ProviderReaderSessionWatcher } from './providerReaderWatcher';

let dir: string;
let file: string;
const watchers: ProviderReaderSessionWatcher[] = [];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-reader-watcher-'));
  setConfigDir(path.join(dir, 'config'));
  file = path.join(dir, 'rollout.jsonl');
});

afterEach(() => {
  for (const watcher of watchers.splice(0)) watcher.stop();
  setConfigDir(undefined);
  fs.rmSync(dir, { recursive: true, force: true });
});

const line = (row: unknown) => JSON.stringify(row) + '\n';
const tokens = (input: number, output: number, second: number) =>
  line({
    type: 'event_msg',
    timestamp: `2026-11-01T12:00:0${second}Z`,
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
const assistant = (text: string, second: number) =>
  line({
    type: 'response_item',
    timestamp: `2026-11-01T12:00:0${second}Z`,
    payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] },
  });
const SESSION =
  line({ type: 'session_meta', payload: { id: 'session', cwd: '/workspace' } }) +
  line({ type: 'turn_context', payload: { model: 'gpt-5-codex', cwd: '/workspace' } }) +
  assistant('first', 1) +
  tokens(1000, 100, 2) +
  assistant('second', 3) +
  tokens(1500, 150, 4);

/**
 * A started Codex watcher feeding an aggregator the way the CLI dashboard
 * does (onReset discards it), logging the callback order.
 */
function follow() {
  const provider = new CodexProvider();
  const log: string[] = [];
  let aggregator = new EventAggregator({ providerId: 'codex' });
  const watcher = new ProviderReaderSessionWatcher(provider, file, {
    onEvent: (event) => {
      log.push(`event:${event.type}`);
      aggregator.processFollowEvent(event);
    },
    onReset: () => {
      log.push('reset');
      aggregator = new EventAggregator({ providerId: 'codex' });
    },
    onBatchComplete: () => log.push('batch'),
  });
  watchers.push(watcher);
  watcher.start(true);
  return {
    log,
    tokens: () => aggregator.getMetrics().tokens,
    /** One read, as the fs.watch debounce or the catch-up poll would run it. */
    read: () => (watcher as unknown as { readNewEvents(): void }).readNewEvents(),
  };
}

/** Totals of a fresh replay of the file now at `file`. */
function freshTokens() {
  return follow().tokens();
}

describe('ProviderReaderSessionWatcher resets', () => {
  it.each([
    [
      'truncated',
      () => {
        const kept = SESSION.slice(0, SESSION.indexOf(assistant('second', 3)));
        fs.truncateSync(file, Buffer.byteLength(kept));
      },
    ],
    [
      'rewritten',
      () => {
        fs.writeFileSync(file, SESSION.replace('first', 'FIRST'));
        fs.utimesSync(file, new Date(), new Date(Date.now() + 5_000));
      },
    ],
    [
      'replaced',
      () => {
        fs.writeFileSync(`${file}.next`, SESSION + tokens(2000, 300, 5));
        fs.renameSync(`${file}.next`, file);
      },
    ],
  ])('fires onReset before the replayed events of the same read (%s)', (_reason, change) => {
    fs.writeFileSync(file, SESSION);
    const watched = follow();
    expect(watched.tokens().outputTokens).toBe(150);
    watched.log.length = 0;

    change();
    watched.read();
    expect(watched.log[0]).toBe('reset');
    expect(watched.log.at(-1)).toBe('batch');
    expect(watched.log.filter((entry) => entry === 'reset')).toHaveLength(1);
    expect(watched.log.filter((entry) => entry.startsWith('event:')).length).toBeGreaterThan(0);
    // Counted once: equal to a fresh replay of the new file.
    expect(watched.tokens()).toEqual(freshTokens());

    // The next read neither resets nor replays again.
    watched.log.length = 0;
    watched.read();
    expect(watched.log).toEqual(['batch']);
    expect(watched.tokens()).toEqual(freshTokens());
  });
});
