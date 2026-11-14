import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { setConfigDir } from '../paths';
import type { SessionEvent } from '../types/sessionEvent';
import { ClaudeCodeProvider } from './claudeCode';
import { drainReader } from './readerDrain';
import type { SessionReader, SessionReaderReset } from './types';

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-reader-drain-'));
  setConfigDir(path.join(dir, 'config'));
  file = path.join(dir, 'session.jsonl');
});

afterEach(() => {
  setConfigDir(undefined);
  fs.rmSync(dir, { recursive: true, force: true });
});

const claude = new ClaudeCodeProvider();
const userLine = (text: string, second: number) =>
  JSON.stringify({
    type: 'user',
    timestamp: `2026-11-01T12:00:${String(second).padStart(2, '0')}Z`,
    message: { role: 'user', content: text },
  }) + '\n';

const SESSION = Array.from({ length: 20 }, (_, i) => userLine(`prompt ${i}`, i)).join('');

/** Counts macrotask turns while `run` is pending. */
async function countTurns<T>(run: () => Promise<T>): Promise<{ result: T; turns: number }> {
  let turns = 0;
  let pending = true;
  const tick = () => {
    if (!pending) return;
    turns += 1;
    setImmediate(tick);
  };
  setImmediate(tick);
  const result = await run();
  pending = false;
  return { result, turns };
}

describe('drainReader', () => {
  it('reads the same events as readAll + flush, yielding between steps', async () => {
    fs.writeFileSync(file, SESSION + userLine('trailing', 30).trimEnd());
    const expected = claude.createReader(file).readAll();
    const reader = claude.createReader(file);
    reader.readAll(); // the drain starts over anyway
    const seen: SessionEvent[] = [];
    let batches = 0;
    const { result, turns } = await countTurns(() =>
      drainReader(reader, {
        chunkBytes: 64,
        fromStart: true,
        flush: true,
        onEvents: (events) => {
          batches += 1;
          seen.push(...events);
        },
      }),
    );
    const oneShot = claude.createReader(file);
    const all = oneShot.readAll();
    oneShot.flush();
    expect(result).toEqual({ done: true });
    expect(seen).toEqual(all);
    expect(seen.length).toBe(expected.length + 1);
    expect(batches).toBeGreaterThan(10);
    expect(turns).toBeGreaterThan(5);
  });

  it('takes no macrotask turn for a file read in one step', async () => {
    fs.writeFileSync(file, SESSION);
    const { turns } = await countTurns(() =>
      drainReader(claude.createReader(file), { onEvents: () => {} }),
    );
    expect(turns).toBe(0);
  });

  it('stops between steps when shouldStop says so', async () => {
    fs.writeFileSync(file, SESSION);
    let batches = 0;
    const result = await drainReader(claude.createReader(file), {
      chunkBytes: 64,
      shouldStop: () => batches >= 2,
      onEvents: () => {
        batches += 1;
      },
    });
    expect(result).toEqual({ done: false });
    expect(batches).toBe(2);
  });

  it('rejects with the abort reason between steps', async () => {
    fs.writeFileSync(file, SESSION);
    const controller = new AbortController();
    let batches = 0;
    await expect(
      drainReader(claude.createReader(file), {
        chunkBytes: 64,
        signal: controller.signal,
        onEvents: () => {
          batches += 1;
          if (batches === 3) controller.abort();
        },
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(batches).toBe(3);
  });

  it('reports a restart on the step that found it', async () => {
    fs.writeFileSync(file, SESSION);
    const resets: Array<SessionReaderReset | null> = [];
    let batches = 0;
    const seen: SessionEvent[] = [];
    await drainReader(claude.createReader(file), {
      chunkBytes: 200,
      onReset: (reset) => {
        resets.push(reset);
        seen.length = 0;
      },
      onEvents: (events) => {
        batches += 1;
        seen.push(...events);
        if (batches === 1) {
          fs.writeFileSync(`${file}.next`, userLine('replaced', 1));
          fs.renameSync(`${file}.next`, file);
        }
      },
    });
    expect(resets).toHaveLength(1);
    expect(resets[0]?.reason).toBe('replaced');
    expect(seen).toHaveLength(1);
  });

  it('reads a reader without readNewBounded with one readNew', async () => {
    const calls: string[] = [];
    const reader = {
      readNew: () => {
        calls.push('readNew');
        return [{ type: 'user', timestamp: 't', message: { role: 'user' } }] as SessionEvent[];
      },
      readAll: () => [],
      reset: () => calls.push('reset'),
      exists: () => true,
      flush: () => calls.push('flush'),
      getPosition: () => 0,
      seekTo: () => {},
      wasTruncated: () => false,
    } as unknown as SessionReader;
    const seen: SessionEvent[] = [];
    await drainReader(reader, {
      fromStart: true,
      flush: true,
      onEvents: (events) => seen.push(...events),
    });
    expect(calls).toEqual(['reset', 'readNew', 'flush']);
    expect(seen).toHaveLength(1);
  });
});
