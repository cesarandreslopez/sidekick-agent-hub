/**
 * A compressed rollout read in bounded steps: `prepareBoundedRead()`
 * decompresses off the main thread, the steps parse the content in slices,
 * and the events equal one `readNew()`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as zlib from 'zlib';
import type { SessionEvent } from '../types/sessionEvent';
import { CompressedCodexRolloutReader } from './codexCompressedReader';
import {
  __compressedRolloutTesting,
  readRolloutBufferAsync,
  resetCompressedRolloutDiagnostics,
} from './compressedRollouts';
import type { SessionProviderDiagnostic } from './types';

type Compress = (input: Buffer) => Buffer;
const zstdCompressSync = (zlib as unknown as { zstdCompressSync?: Compress }).zstdCompressSync;
const hasZstd = typeof zstdCompressSync === 'function';

let dir: string;
let file: string;

const line = (row: unknown) => JSON.stringify(row) + '\n';
const total = (input: number, output: number) => ({
  input_tokens: input,
  cached_input_tokens: 0,
  output_tokens: output,
  total_tokens: input + output,
});
const CONTENT =
  line({ type: 'session_meta', payload: { id: 's', cwd: '/w' } }) +
  line({ type: 'turn_context', payload: { model: 'gpt-5-codex', cwd: '/w' } }) +
  line({
    type: 'response_item',
    timestamp: '2026-11-01T12:00:01Z',
    payload: {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'é🚀' }],
    },
  }) +
  line({
    type: 'event_msg',
    timestamp: '2026-11-01T12:00:02Z',
    payload: { type: 'token_count', info: { total_token_usage: total(1000, 100) } },
  }) +
  // The content's last line needs no newline.
  JSON.stringify({
    type: 'event_msg',
    timestamp: '2026-11-01T12:00:03Z',
    payload: { type: 'token_count', info: { total_token_usage: total(1500, 160) } },
  });

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-compressed-bounded-'));
  file = path.join(dir, 'rollout-2026-11-01T12-00-00-s.jsonl.zst');
});

afterEach(() => {
  __compressedRolloutTesting.setDecompress(undefined);
  resetCompressedRolloutDiagnostics();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function drain(reader: CompressedCodexRolloutReader, maxBytes: number) {
  await reader.prepareBoundedRead();
  const events: SessionEvent[] = [];
  let steps = 0;
  for (;;) {
    const step = reader.readNewBounded(maxBytes);
    steps += 1;
    events.push(...step.events);
    if (step.done) break;
  }
  events.push(...reader.finishBounded());
  return { events, steps };
}

describe('CompressedCodexRolloutReader.readNewBounded', () => {
  it.each([1, 5, 64, 1 << 20])('a drain at %i bytes per step equals readNew()', async (size) => {
    // An identity "decompressor" reads a plain file, on any Node version.
    __compressedRolloutTesting.setDecompress((input) => input);
    fs.writeFileSync(file, CONTENT);
    const expected = new CompressedCodexRolloutReader(file).readNew();
    expect(expected.some((event) => event.message?.usage)).toBe(true);
    const reader = new CompressedCodexRolloutReader(file);
    const { events, steps } = await drain(reader, size);
    expect(events).toEqual(expected);
    expect(reader.getPosition()).toBe(Buffer.byteLength(CONTENT));
    if (size === 1) expect(steps).toBe(Buffer.byteLength(CONTENT));
    // Read whole and unchanged: the next drain is empty.
    expect(reader.readNewBounded(size)).toEqual({ events: [], done: true });
  });

  it('starts over when another file takes the path mid-drain', async () => {
    __compressedRolloutTesting.setDecompress((input) => input);
    fs.writeFileSync(file, CONTENT);
    const reader = new CompressedCodexRolloutReader(file);
    await reader.prepareBoundedRead();
    expect(reader.readNewBounded(50).done).toBe(false);
    const replacement = CONTENT.split('\n').slice(0, 3).join('\n') + '\n';
    fs.writeFileSync(`${file}.next`, replacement);
    fs.renameSync(`${file}.next`, file);
    const step = reader.readNewBounded(1 << 20);
    expect(reader.lastReset?.()?.reason).toBe('replaced');
    expect(step.done).toBe(true);
    expect(step.events).toEqual(new CompressedCodexRolloutReader(file).readNew());
  });

  it('decompresses without prepareBoundedRead too', () => {
    __compressedRolloutTesting.setDecompress((input) => input);
    fs.writeFileSync(file, CONTENT);
    const reader = new CompressedCodexRolloutReader(file);
    const step = reader.readNewBounded(1 << 20);
    expect(step.done).toBe(true);
    expect(step.events).toEqual(new CompressedCodexRolloutReader(file).readNew());
  });

  it('reads a missing file as done', () => {
    expect(new CompressedCodexRolloutReader(file).readNewBounded(10)).toEqual({
      events: [],
      done: true,
    });
  });
});

describe('readRolloutBufferAsync', () => {
  it.skipIf(!hasZstd)('decompresses on the runtime’s asynchronous zstdDecompress', async () => {
    fs.writeFileSync(file, zstdCompressSync!(Buffer.from(CONTENT)));
    const before = __compressedRolloutTesting.asyncDecompressions();
    const content = await readRolloutBufferAsync(file);
    expect(content?.toString('utf8')).toBe(CONTENT);
    expect(__compressedRolloutTesting.asyncDecompressions()).toBe(before + 1);
  });

  it.skipIf(!hasZstd)('reports a corrupt frame and resolves null', async () => {
    fs.writeFileSync(file, Buffer.from('not a zstd frame'));
    const diagnostics: SessionProviderDiagnostic[] = [];
    const content = await readRolloutBufferAsync(file, {
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });
    expect(content).toBeNull();
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].severity).toBe('warning');
  });

  it('reports a runtime without Zstandard once and resolves null', async () => {
    __compressedRolloutTesting.setDecompress(null);
    fs.writeFileSync(file, CONTENT);
    const diagnostics: SessionProviderDiagnostic[] = [];
    const onDiagnostic = (diagnostic: SessionProviderDiagnostic) => diagnostics.push(diagnostic);
    expect(await readRolloutBufferAsync(file, { onDiagnostic })).toBeNull();
    expect(await readRolloutBufferAsync(file, { onDiagnostic })).toBeNull();
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].severity).toBe('info');
  });

  it.skipIf(!hasZstd)('a real compressed rollout drains to the same events', async () => {
    fs.writeFileSync(file, zstdCompressSync!(Buffer.from(CONTENT)));
    const expected = new CompressedCodexRolloutReader(file).readNew();
    const { events } = await drain(new CompressedCodexRolloutReader(file), 16);
    expect(events).toEqual(expected);
  });
});
