import {
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
  appendFileSync,
  truncateSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  captureJsonlCheckpoint,
  createJsonlTail,
  JsonlTailSymlinkError,
  verifyJsonlCheckpoint,
  type JsonlTailBatch,
  type JsonlTailCheckpoint,
  type JsonlTailGap,
  type JsonlTailLine,
  type JsonlTailOptions,
  type JsonlTailReset,
} from './jsonlTail';

const tempDirs: string[] = [];

function makeJsonlFile(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'sidekick-jsonl-tail-'));
  tempDirs.push(dir);
  const file = path.join(dir, 'session.jsonl');
  writeFileSync(file, '');
  return file;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('createJsonlTail', () => {
  it('reads appended JSONL events and tracks offsets', () => {
    const file = makeJsonlFile();
    const events: Array<{ type: string }> = [];
    const batches: JsonlTailBatch[] = [];
    const tail = createJsonlTail<{ type: string }>({
      path: file,
      onEvent: (event) => events.push(event),
      onBatchComplete: (batch) => batches.push(batch),
    });

    appendFileSync(file, '{"type":"one"}\n{"type":"two"}\n');
    tail.readNow();

    expect(events.map((e) => e.type)).toEqual(['one', 'two']);
    expect(tail.getOffset()).toBe(Buffer.byteLength('{"type":"one"}\n{"type":"two"}\n'));
    expect(batches).toHaveLength(1);
    expect(batches[0]).toMatchObject({ eventsRead: 2, offset: tail.getOffset() });
  });

  it('buffers partial lines until a complete JSONL line arrives', () => {
    const file = makeJsonlFile();
    const events: Array<{ type: string }> = [];
    const batches: JsonlTailBatch[] = [];
    const tail = createJsonlTail<{ type: string }>({
      path: file,
      onEvent: (event) => events.push(event),
      onBatchComplete: (batch) => batches.push(batch),
    });

    appendFileSync(file, '{"type":"one"');
    tail.readNow();
    appendFileSync(file, '}\n');
    tail.readNow();

    expect(events.map((e) => e.type)).toEqual(['one']);
    expect(batches.map((b) => b.eventsRead)).toEqual([0, 1]);
  });

  it('reports a resume-safe offset before a partial line', () => {
    const file = makeJsonlFile();
    const firstBatches: JsonlTailBatch[] = [];
    const first = createJsonlTail<{ type: string }>({
      path: file,
      onEvent: () => {},
      onBatchComplete: (batch) => firstBatches.push(batch),
    });
    appendFileSync(file, '{"type":"one"');
    first.readNow();

    expect(first.getOffset()).toBe(0);
    expect(firstBatches[0].offset).toBe(0);

    appendFileSync(file, '}\n');
    const resumedEvents: Array<{ type: string }> = [];
    const resumed = createJsonlTail<{ type: string }>({
      path: file,
      startOffset: first.getOffset(),
      onEvent: (event) => resumedEvents.push(event),
    });
    resumed.readNow();

    expect(resumedEvents).toEqual([{ type: 'one' }]);
    expect(resumed.getOffset()).toBe(Buffer.byteLength('{"type":"one"}\n'));
  });

  it('reports invalid JSON and keeps parsing later lines', () => {
    const file = makeJsonlFile();
    const events: Array<{ type: string }> = [];
    const errors: Error[] = [];
    const tail = createJsonlTail<{ type: string }>({
      path: file,
      onEvent: (event) => events.push(event),
      onError: (error) => errors.push(error),
    });

    appendFileSync(file, '{"type":"one"}\n{"type":\n{"type":"two"}\n');
    tail.readNow();

    expect(events.map((e) => e.type)).toEqual(['one', 'two']);
    expect(errors).toHaveLength(1);
  });

  it('validates events when a schema is provided', () => {
    const file = makeJsonlFile();
    const events: Array<{ type: 'ok' }> = [];
    const errors: Error[] = [];
    const tail = createJsonlTail({
      path: file,
      schema: z.object({ type: z.literal('ok') }),
      onEvent: (event) => events.push(event),
      onError: (error) => errors.push(error),
    });

    appendFileSync(file, '{"type":"bad"}\n{"type":"ok"}\n');
    tail.readNow();

    expect(events).toEqual([{ type: 'ok' }]);
    expect(errors).toHaveLength(1);
  });

  it('resets offset and parser state when the file is truncated', () => {
    const file = makeJsonlFile();
    const events: Array<{ type: string }> = [];
    const tail = createJsonlTail<{ type: string }>({
      path: file,
      onEvent: (event) => events.push(event),
    });

    appendFileSync(file, '{"type":"one"}\n');
    tail.readNow();
    truncateSync(file, 0);
    appendFileSync(file, '{"type":"2"}\n');
    tail.readNow();

    expect(events.map((e) => e.type)).toEqual(['one', '2']);
    expect(tail.getOffset()).toBe(Buffer.byteLength('{"type":"2"}\n'));
  });

  it('reads a large backlog in bounded chunks and reports each line position', () => {
    const file = makeJsonlFile();
    const lines = Array.from({ length: 200 }, (_, index) => JSON.stringify({ type: `e${index}` }));
    writeFileSync(file, lines.join('\n') + '\n');
    const events: string[] = [];
    const positions: JsonlTailLine[] = [];
    const batches: JsonlTailBatch[] = [];
    const tail = createJsonlTail<{ type: string }>({
      path: file,
      maxReadBytes: 64,
      onEvent: (event, line) => {
        events.push(event.type);
        positions.push(line);
      },
      onBatchComplete: (batch) => batches.push(batch),
    });

    tail.readNow();

    expect(events).toEqual(lines.map((line) => JSON.parse(line).type));
    expect(batches).toHaveLength(1);
    let offset = 0;
    for (const [index, line] of lines.entries()) {
      expect(positions[index]).toEqual({ offset, length: Buffer.byteLength(line) });
      offset += Buffer.byteLength(line) + 1;
    }
    expect(tail.getOffset()).toBe(offset);
  });

  it('skips a line over maxLineBytes, even while it is still being written', () => {
    const file = makeJsonlFile();
    const events: string[] = [];
    const errors: string[] = [];
    const tail = createJsonlTail<{ type: string }>({
      path: file,
      maxReadBytes: 16,
      maxLineBytes: 40,
      onEvent: (event) => events.push(event.type),
      onError: (error) => errors.push(error.message),
    });

    const big = JSON.stringify({ type: 'big', pad: 'x'.repeat(100) });
    appendFileSync(file, '{"type":"a"}\n' + big.slice(0, 60));
    tail.readNow();
    expect(events).toEqual(['a']);
    expect(errors).toEqual([expect.stringContaining('JSONL line at byte 13')]);

    appendFileSync(file, big.slice(60) + '\n{"type":"b"}\n');
    tail.readNow();
    expect(events).toEqual(['a', 'b']);
    expect(errors).toHaveLength(1);
    expect(tail.getOffset()).toBe(13 + Buffer.byteLength(big) + 1 + 13);
  });

  it('resets and says why when the file is rewritten at the same size or replaced', () => {
    const file = makeJsonlFile();
    const events: string[] = [];
    const resets: JsonlTailReset[] = [];
    const tail = createJsonlTail<{ type: string }>({
      path: file,
      onEvent: (event) => events.push(event.type),
      onReset: (reset) => resets.push(reset),
    });

    appendFileSync(file, '{"type":"one"}\n');
    tail.readNow();
    writeFileSync(file, '{"type":"two"}\n');
    utimesSync(file, new Date(), new Date(Date.now() + 5_000));
    tail.readNow();
    expect(events).toEqual(['one', 'two']);
    expect(resets).toEqual([{ reason: 'rewritten', previousOffset: 15 }]);

    const replacement = `${file}.next`;
    writeFileSync(replacement, '{"type":"three"}\n{"type":"four"}\n');
    renameSync(replacement, file);
    tail.readNow();
    expect(events).toEqual(['one', 'two', 'three', 'four']);
    expect(resets[1]).toEqual({ reason: 'replaced', previousOffset: 15 });

    truncateSync(file, 0);
    tail.readNow();
    expect(resets[2]).toMatchObject({ reason: 'truncated' });
  });
});

/** Moves the file's mtime forward so a same-size rewrite is noticed. */
function touchLater(file: string, ms = 5_000): void {
  utimesSync(file, new Date(), new Date(Date.now() + ms));
}

function recordingTail(file: string, options: Partial<JsonlTailOptions<{ type: string }>> = {}) {
  const events: string[] = [];
  const lines: JsonlTailLine[] = [];
  const resets: JsonlTailReset[] = [];
  const errors: Error[] = [];
  const batches: JsonlTailBatch[] = [];
  const tail = createJsonlTail<{ type: string }>({
    path: file,
    onEvent: (event, line) => {
      events.push(event.type);
      lines.push(line);
    },
    onReset: (reset) => resets.push(reset),
    onError: (error) => errors.push(error),
    onBatchComplete: (batch) => batches.push(batch),
    ...options,
  });
  return { tail, events, lines, resets, errors, batches };
}

describe('createJsonlTail onRewrite', () => {
  it("continues from the rewritten file's end with 'end'", () => {
    const file = makeJsonlFile();
    const { tail, events, resets } = recordingTail(file, { onRewrite: 'end' });

    appendFileSync(file, '{"type":"one"}\n');
    tail.readNow();
    writeFileSync(file, '{"type":"two"}\n{"type":"three"}\n');
    touchLater(file);
    tail.readNow();
    expect(events).toEqual(['one']);
    const rewrittenSize = Buffer.byteLength('{"type":"two"}\n{"type":"three"}\n');
    expect(resets).toEqual([{ reason: 'rewritten', previousOffset: 15, offset: rewrittenSize }]);
    expect(tail.getOffset()).toBe(rewrittenSize);

    appendFileSync(file, '{"type":"four"}\n');
    tail.readNow();
    expect(events).toEqual(['one', 'four']);
    expect(resets).toHaveLength(1);
  });

  it("keeps an unfinished final line and handles truncation and replacement with 'end'", () => {
    const file = makeJsonlFile();
    const { tail, events, resets } = recordingTail(file, { onRewrite: 'end' });

    appendFileSync(file, '{"type":"one"}\n{"type":"two"}\n');
    tail.readNow();
    // Shrinks to a complete line plus a line still being written.
    writeFileSync(file, '{"type":"x"}\n{"type":"par');
    tail.readNow();
    expect(resets[0]).toEqual({
      reason: 'truncated',
      previousOffset: 30,
      offset: Buffer.byteLength('{"type":"x"}\n'),
    });
    appendFileSync(file, 'tial"}\n');
    tail.readNow();
    expect(events).toEqual(['one', 'two', 'partial']);

    const replacement = `${file}.next`;
    writeFileSync(replacement, '{"type":"old-1"}\n{"type":"old-2"}\n');
    renameSync(replacement, file);
    tail.readNow();
    expect(resets[1]).toMatchObject({ reason: 'replaced' });
    appendFileSync(file, '{"type":"new"}\n');
    tail.readNow();
    expect(events).toEqual(['one', 'two', 'partial', 'new']);
  });

  it("defaults to 'restart' and keeps the reset payload unchanged", () => {
    const file = makeJsonlFile();
    const { tail, events, resets } = recordingTail(file);
    appendFileSync(file, '{"type":"one"}\n');
    tail.readNow();
    writeFileSync(file, '{"type":"two"}\n');
    touchLater(file);
    tail.readNow();
    expect(events).toEqual(['one', 'two']);
    expect(resets).toStrictEqual([{ reason: 'rewritten', previousOffset: 15 }]);
  });
});

describe('createJsonlTail checkpoints', () => {
  it('resumes in a new instance from a serialized checkpoint and reads only new lines', () => {
    const file = makeJsonlFile();
    appendFileSync(file, '{"type":"one"}\n{"type":"two"}\n{"type":"thr');
    const first = recordingTail(file);
    first.tail.readNow();
    expect(first.events).toEqual(['one', 'two']);

    const saved = JSON.stringify(first.tail.checkpoint());
    first.tail.dispose();
    const checkpoint = JSON.parse(saved) as JsonlTailCheckpoint;
    expect(checkpoint).toMatchObject({
      version: 1,
      offset: Buffer.byteLength('{"type":"one"}\n{"type":"two"}\n'),
      identity: { dev: expect.any(Number), ino: expect.any(Number) },
      prefixDigest: { bytes: expect.any(Number), hash: expect.any(String) },
    });

    appendFileSync(file, 'ee"}\n{"type":"four"}\n');
    // startAtEnd would skip "three"; the resumed position wins.
    const second = recordingTail(file, { startAtEnd: true, catchupIntervalMs: 0 });
    expect(second.tail.resumeFrom(checkpoint)).toBe(true);
    second.tail.start();
    second.tail.stop();
    expect(second.events).toEqual(['three', 'four']);
    expect(second.lines[0].offset).toBe(checkpoint.offset);
    expect(second.resets).toEqual([]);
  });

  it('rejects a checkpoint for another, rewritten, or replaced file and applies onRewrite', () => {
    const file = makeJsonlFile();
    const content = '{"type":"one"}\n{"type":"two"}\n';
    appendFileSync(file, content);
    const first = recordingTail(file);
    first.tail.readNow();
    const checkpoint = first.tail.checkpoint();

    // A different file with identical content.
    const other = makeJsonlFile();
    writeFileSync(other, content);
    const onOther = recordingTail(other);
    expect(onOther.tail.resumeFrom(checkpoint)).toBe(false);
    onOther.tail.readNow();
    expect(onOther.events).toEqual(['one', 'two']);
    expect(onOther.resets).toEqual([]);

    const onOtherAtEnd = recordingTail(other, { onRewrite: 'end' });
    expect(onOtherAtEnd.tail.resumeFrom(checkpoint)).toBe(false);
    expect(onOtherAtEnd.tail.getOffset()).toBe(Buffer.byteLength(content));
    onOtherAtEnd.tail.readNow();
    expect(onOtherAtEnd.events).toEqual([]);

    // The same file rewritten in place.
    writeFileSync(file, '{"type":"ONE"}\n{"type":"TWO"}\n{"type":"three"}\n');
    const rewritten = recordingTail(file);
    expect(rewritten.tail.resumeFrom(checkpoint)).toBe(false);
    rewritten.tail.readNow();
    expect(rewritten.events).toEqual(['ONE', 'TWO', 'three']);

    // Replaced by a new file with the original content.
    const fresh = recordingTail(file);
    fresh.tail.readNow();
    const freshCheckpoint = fresh.tail.checkpoint();
    const replacement = `${file}.next`;
    writeFileSync(replacement, '{"type":"ONE"}\n{"type":"TWO"}\n{"type":"three"}\n');
    renameSync(replacement, file);
    expect(recordingTail(file).tail.resumeFrom(freshCheckpoint)).toBe(false);

    // Truncated below the checkpoint.
    const shrinking = recordingTail(file);
    shrinking.tail.readNow();
    const shrinkingCheckpoint = shrinking.tail.checkpoint();
    truncateSync(file, 15);
    expect(recordingTail(file).tail.resumeFrom(shrinkingCheckpoint)).toBe(false);
  });

  it('rejects malformed checkpoints and offsets that do not follow a newline', () => {
    const file = makeJsonlFile();
    appendFileSync(file, '{"type":"one"}\n{"type":"two"}\n');
    const source = recordingTail(file);
    source.tail.readNow();
    const good = source.tail.checkpoint();

    const malformed: unknown[] = [
      undefined,
      null,
      'checkpoint',
      {},
      { ...good, version: 2 },
      { ...good, offset: -1 },
      { ...good, offset: 1.5 },
      { ...good, identity: undefined },
      { ...good, identity: { dev: 'x', ino: 1 } },
      { ...good, prefixDigest: { bytes: 99_999, hash: 'abc' } },
      { ...good, prefixDigest: { bytes: 4, hash: '' } },
      { ...good, offset: 5 },
    ];
    for (const value of malformed) {
      const tail = recordingTail(file);
      expect(tail.tail.resumeFrom(value)).toBe(false);
      expect(tail.tail.getOffset()).toBe(0);
    }
    expect(recordingTail(file).tail.resumeFrom(good)).toBe(true);
  });

  it('accepts a checkpoint taken before the first read only at offset 0', () => {
    const file = makeJsonlFile();
    appendFileSync(file, '{"type":"one"}\n');
    const unread = recordingTail(file).tail.checkpoint();
    expect(unread).toEqual({ version: 1, offset: 0, identity: null, prefixDigest: null });
    const resumed = recordingTail(file);
    expect(resumed.tail.resumeFrom(unread)).toBe(true);
    resumed.tail.readNow();
    expect(resumed.events).toEqual(['one']);

    const positioned = recordingTail(file, { startOffset: 15 }).tail.checkpoint();
    expect(recordingTail(file).tail.resumeFrom(positioned)).toBe(false);
  });

  it('reports an unreadable file from resumeFrom and starts at 0', () => {
    const dir = path.dirname(makeJsonlFile());
    const { tail, errors } = recordingTail(path.join(dir, 'missing.jsonl'));
    expect(tail.resumeFrom({ version: 1, offset: 0, identity: null, prefixDigest: null })).toBe(
      false,
    );
    expect(tail.getOffset()).toBe(0);
    expect(errors).toHaveLength(1);
  });
});

describe.skipIf(process.platform === 'win32')('createJsonlTail noFollow', () => {
  it('refuses a symlinked path with a typed error and still follows links by default', async () => {
    const target = makeJsonlFile();
    appendFileSync(target, '{"type":"one"}\n');
    const link = path.join(path.dirname(target), 'link.jsonl');
    symlinkSync(target, link);

    const refused = recordingTail(link, { noFollow: true, catchupIntervalMs: 0 });
    refused.tail.start();
    refused.tail.stop();
    expect(refused.events).toEqual([]);
    expect(refused.errors[0]).toBeInstanceOf(JsonlTailSymlinkError);
    expect(refused.errors[0]).toMatchObject({ code: 'JSONL_TAIL_SYMLINK', path: link });

    const result = await refused.tail.read();
    expect(result.events).toEqual([]);
    expect(refused.errors.at(-1)).toBeInstanceOf(JsonlTailSymlinkError);
    expect(refused.tail.resumeFrom(refused.tail.checkpoint())).toBe(false);
    expect(refused.errors.at(-1)).toBeInstanceOf(JsonlTailSymlinkError);

    const followed = recordingTail(link);
    followed.tail.readNow();
    expect(followed.events).toEqual(['one']);

    const direct = recordingTail(target, { noFollow: true });
    direct.tail.readNow();
    expect(direct.events).toEqual(['one']);
    expect(direct.errors).toEqual([]);
  });
});

describe('createJsonlTail read()', () => {
  const backlog = [
    '{"type":"a"}',
    '{"type":',
    JSON.stringify({ type: 'big', pad: 'x'.repeat(80) }),
    '{"type":"b"}',
    '',
    '{"type":"c"}',
  ].join('\n');

  function syncRun(file: string) {
    const run = recordingTail(file, { maxReadBytes: 16, maxLineBytes: 60 });
    const offsets: number[] = [];
    for (const append of [backlog + '\n{"type":"d', '"}\n']) {
      appendFileSync(file, append);
      run.tail.readNow();
      offsets.push(run.tail.getOffset());
    }
    return { ...run, offsets };
  }

  it('matches readNow() event for event, line for line, and batch for batch', async () => {
    const syncFile = makeJsonlFile();
    const expected = syncRun(syncFile);

    const asyncFile = makeJsonlFile();
    const actual = recordingTail(asyncFile, { maxReadBytes: 16, maxLineBytes: 60 });
    const results: Array<Awaited<ReturnType<typeof actual.tail.read>>> = [];
    const offsets: number[] = [];
    for (const append of [backlog + '\n{"type":"d', '"}\n']) {
      appendFileSync(asyncFile, append);
      results.push(await actual.tail.read());
      offsets.push(actual.tail.getOffset());
    }

    expect(actual.events).toEqual(['a', 'b', 'c', 'd']);
    expect(actual.events).toEqual(expected.events);
    expect(actual.lines).toEqual(expected.lines);
    expect(actual.batches).toEqual(expected.batches);
    expect(actual.errors.map((e) => e.message)).toEqual(expected.errors.map((e) => e.message));
    expect(offsets).toEqual(expected.offsets);
    expect(results.flatMap((r) => r.events.map((entry) => entry.event.type))).toEqual(
      expected.events,
    );
    expect(results.flatMap((r) => r.events.map((entry) => entry.line))).toEqual(expected.lines);
    expect(
      results.map(({ bytesRead, eventsRead, offset }) => ({ bytesRead, eventsRead, offset })),
    ).toEqual(expected.batches);
  });

  it('resolves an empty result when nothing is new and carries resets', async () => {
    const file = makeJsonlFile();
    const { tail, resets } = recordingTail(file, { onRewrite: 'end' });
    appendFileSync(file, '{"type":"one"}\n');
    expect((await tail.read()).events).toHaveLength(1);
    expect(await tail.read()).toEqual({
      bytesRead: 0,
      eventsRead: 0,
      offset: 15,
      events: [],
      checkpoint: tail.checkpoint(),
    });

    writeFileSync(file, '{"type":"two"}\n{"type":"x"}\n');
    touchLater(file);
    const result = await tail.read();
    expect(result.events).toEqual([]);
    expect(result.reset).toEqual(resets[0]);
    expect(result.reset).toMatchObject({ reason: 'rewritten', offset: 28 });
  });

  it('serializes concurrent reads and defers readNow() until a read settles', async () => {
    const file = makeJsonlFile();
    const { tail, events } = recordingTail(file, { maxReadBytes: 8 });
    appendFileSync(file, '{"type":"one"}\n{"type":"two"}\n');
    const first = tail.read();
    const second = tail.read();
    tail.readNow();
    const [a, b] = await Promise.all([first, second]);
    expect(a.events.map((entry) => entry.event.type)).toEqual(['one', 'two']);
    expect(b.events).toEqual([]);
    expect(events).toEqual(['one', 'two']);

    appendFileSync(file, '{"type":"three"}\n');
    const pending = tail.read();
    await new Promise((resolve) => setImmediate(resolve));
    // Arrives mid-read; runs after it without delivering anything twice.
    appendFileSync(file, '{"type":"four"}\n');
    tail.readNow();
    const result = await pending;
    expect(result.events.map((entry) => entry.event.type)[0]).toBe('three');
    expect(events).toEqual(['one', 'two', 'three', 'four']);
  });

  it('stops an in-flight read when the position is moved', async () => {
    const file = makeJsonlFile();
    const lines = Array.from({ length: 500 }, (_, i) => JSON.stringify({ type: `e${i}` }));
    writeFileSync(file, lines.join('\n') + '\n');
    // Hundreds of sequential reads cannot all settle before one setImmediate.
    const { tail, events } = recordingTail(file, { maxReadBytes: 16 });
    const pending = tail.read();
    await new Promise((resolve) => setImmediate(resolve));
    tail.seekTo(0);
    await pending;
    expect(events.length).toBeLessThan(lines.length);
    events.length = 0;
    await tail.read();
    expect(events).toEqual(lines.map((line) => JSON.parse(line).type));
  });
});

describe('captureJsonlCheckpoint / verifyJsonlCheckpoint', () => {
  const content = '{"type":"one"}\n{"type":"two"}\n';
  const firstLine = Buffer.byteLength('{"type":"one"}\n');

  it('captures what a tail checkpoints at the same offset, and verifies it', () => {
    const file = makeJsonlFile();
    appendFileSync(file, content);
    const { tail } = recordingTail(file);
    tail.readNow();

    const captured = captureJsonlCheckpoint(file, tail.getOffset());
    expect(captured).toEqual(tail.checkpoint());
    expect(verifyJsonlCheckpoint(file, captured)).toBe(true);
    // Survives JSON, and a tail accepts it too.
    const serialized = JSON.parse(JSON.stringify(captured)) as unknown;
    expect(verifyJsonlCheckpoint(file, serialized)).toBe(true);
    expect(recordingTail(file).tail.resumeFrom(serialized)).toBe(true);
    expect(captureJsonlCheckpoint(file, 0)).toMatchObject({ offset: 0 });
    expect(captureJsonlCheckpoint(file, firstLine)).toMatchObject({ offset: firstLine });
  });

  it('stays valid while the file only grows, including past a short head', () => {
    const file = makeJsonlFile();
    appendFileSync(file, content);
    const checkpoint = captureJsonlCheckpoint(file, Buffer.byteLength(content));
    expect(checkpoint?.prefixDigest?.bytes).toBe(Buffer.byteLength(content));
    appendFileSync(file, `${JSON.stringify({ type: 'big', pad: 'x'.repeat(8192) })}\n`);
    appendFileSync(file, '{"type":"partial');
    expect(verifyJsonlCheckpoint(file, checkpoint)).toBe(true);
  });

  it.skipIf(process.platform === 'win32')(
    'refuses a symlinked path with noFollow and follows it by default',
    () => {
      const target = makeJsonlFile();
      appendFileSync(target, content);
      const link = path.join(path.dirname(target), 'link.jsonl');
      symlinkSync(target, link);
      const end = Buffer.byteLength(content);

      const followed = captureJsonlCheckpoint(link, end);
      expect(followed).toEqual(captureJsonlCheckpoint(target, end));
      expect(verifyJsonlCheckpoint(link, followed)).toBe(true);

      expect(captureJsonlCheckpoint(link, end, { noFollow: true })).toBeNull();
      expect(verifyJsonlCheckpoint(link, followed, { noFollow: true })).toBe(false);
      // A plain file is unaffected by noFollow.
      const direct = captureJsonlCheckpoint(target, end, { noFollow: true });
      expect(direct).toEqual(followed);
      expect(verifyJsonlCheckpoint(target, direct, { noFollow: true })).toBe(true);
    },
  );

  it('rolls back a refused batch by resuming from the checkpoint taken before it', async () => {
    const file = makeJsonlFile();
    appendFileSync(file, '{"type":"one"}\n');
    const { tail, events } = recordingTail(file);
    const first = await tail.read();
    const beforeBatch = first.checkpoint;

    appendFileSync(file, '{"type":"two"}\n{"type":"three"}\n');
    await tail.read();
    expect(events).toEqual(['one', 'two', 'three']);

    // The caller could not take the batch: rewind and read it again.
    events.length = 0;
    expect(tail.resumeFrom(beforeBatch)).toBe(true);
    await tail.read();
    expect(events).toEqual(['two', 'three']);
  });

  it('returns null for a missing file or an offset that is not resume-safe', () => {
    const file = makeJsonlFile();
    appendFileSync(file, content);
    expect(captureJsonlCheckpoint(`${file}.missing`, 0)).toBeNull();
    expect(captureJsonlCheckpoint(file, firstLine - 1)).toBeNull();
    expect(captureJsonlCheckpoint(file, Buffer.byteLength(content) + 1)).toBeNull();
    expect(captureJsonlCheckpoint(file, -1)).toBeNull();
    expect(captureJsonlCheckpoint(file, 1.5)).toBeNull();
    expect(captureJsonlCheckpoint(file, Number.NaN)).toBeNull();
    expect(captureJsonlCheckpoint(path.dirname(file), 0)).toBeNull();
  });

  it('rejects a same-size rewrite, a replacement with identical content, and truncation', () => {
    const file = makeJsonlFile();
    appendFileSync(file, content);
    const checkpoint = captureJsonlCheckpoint(file, Buffer.byteLength(content));

    // Same size, different first bytes.
    writeFileSync(file, content.replace('one', 'ONE'));
    expect(verifyJsonlCheckpoint(file, checkpoint)).toBe(false);

    // A new inode with byte-identical content.
    writeFileSync(file, content);
    const before = captureJsonlCheckpoint(file, Buffer.byteLength(content));
    expect(verifyJsonlCheckpoint(file, before)).toBe(true);
    const replacement = `${file}.next`;
    writeFileSync(replacement, content);
    renameSync(replacement, file);
    expect(verifyJsonlCheckpoint(file, before)).toBe(false);

    // Shrunk below the offset.
    const full = captureJsonlCheckpoint(file, Buffer.byteLength(content));
    truncateSync(file, firstLine);
    expect(verifyJsonlCheckpoint(file, full)).toBe(false);
  });

  it('rejects an offset that no longer follows a newline', () => {
    const file = makeJsonlFile();
    // A first line longer than the digested head, so only the newline check can fail.
    const pad = `${JSON.stringify({ type: 'pad', pad: 'x'.repeat(5000) })}\n`;
    writeFileSync(file, `${pad}{"type":"two"}\n`);
    const offset = Buffer.byteLength(`${pad}{"type":"two"}\n`);
    const checkpoint = captureJsonlCheckpoint(file, offset);
    expect(checkpoint?.prefixDigest?.bytes).toBe(4096);
    expect(verifyJsonlCheckpoint(file, checkpoint)).toBe(true);
    expect(verifyJsonlCheckpoint(file, { ...checkpoint!, offset: offset - 1 })).toBe(false);

    // Rewritten in place (same inode, same head): the byte before the offset is no longer '\n'.
    writeFileSync(file, `${pad}{"type":"two"}x{"type":"three"}\n`);
    expect(verifyJsonlCheckpoint(file, checkpoint)).toBe(false);
  });

  it('is false for malformed checkpoints and missing files, never throwing', () => {
    const file = makeJsonlFile();
    appendFileSync(file, content);
    const good = captureJsonlCheckpoint(file, firstLine)!;
    for (const bad of [
      undefined,
      null,
      'checkpoint',
      42,
      {},
      { ...good, version: 2 },
      { ...good, offset: -1 },
      { ...good, identity: 'x' },
      { ...good, prefixDigest: { bytes: 99999, hash: 'x' } },
      { ...good, identity: null },
    ]) {
      expect(verifyJsonlCheckpoint(file, bad)).toBe(false);
    }
    expect(verifyJsonlCheckpoint(`${file}.missing`, good)).toBe(false);
  });
});

describe('createJsonlTail gaps', () => {
  /** A tail that records events and gaps in the order the callbacks saw them. */
  function gapTail(file: string, options: Partial<JsonlTailOptions<{ type: string }>> = {}) {
    const order: string[] = [];
    const gaps: JsonlTailGap[] = [];
    const tail = createJsonlTail<{ type: string }>({
      path: file,
      onEvent: (event) => order.push(event.type),
      onGap: (gap) => {
        gaps.push(gap);
        order.push(`gap:${gap.reason}`);
      },
      onError: () => {},
      ...options,
    });
    return { tail, order, gaps };
  }

  it('reports skipped lines in order with the events, without breaking continuity', async () => {
    const file = makeJsonlFile();
    const lines = [
      '{"type":"a"}',
      'not json',
      '{"type":',
      JSON.stringify({ type: 'big', pad: 'x'.repeat(80) }),
      '',
      '﻿{"type":"bom"}',
      '{"type":"b"}',
    ];
    appendFileSync(file, lines.join('\n') + '\n');
    const { tail, order, gaps } = gapTail(file, { maxLineBytes: 60 });
    const result = await tail.read();

    expect(order).toEqual([
      'a',
      'gap:malformed-line',
      'gap:malformed-line',
      'gap:oversized-line',
      'bom',
      'b',
    ]);
    expect(result.gaps).toEqual(gaps);
    const starts = lines.map((_line, index) =>
      Buffer.byteLength(lines.slice(0, index).join('\n') + (index > 0 ? '\n' : '')),
    );
    expect(gaps.map(({ fromOffset, toOffset }) => [fromOffset, toOffset])).toEqual([
      [starts[1], starts[2]],
      [starts[2], starts[3]],
      [starts[3], starts[4]],
    ]);
    expect(gaps.every((gap) => !gap.discontinuity && typeof gap.error === 'string')).toBe(true);
    expect(gaps[0].error).toBe('Line is not a JSON object.');
  });

  it('reports a schema rejection as a malformed line', async () => {
    const file = makeJsonlFile();
    appendFileSync(file, '{"type":"ok"}\n{"type":3}\n');
    const { tail, gaps } = gapTail(file, { schema: z.object({ type: z.string() }) });
    const result = await tail.read();
    expect(result.events.map((entry) => entry.event.type)).toEqual(['ok']);
    expect(gaps).toEqual([
      expect.objectContaining({ reason: 'malformed-line', fromOffset: 14, toOffset: 25 }),
    ]);
    expect(gaps[0].error).toMatch(/Schema validation failed/);
  });

  it('fires an oversized-line gap when the skip ends, across reads', async () => {
    const file = makeJsonlFile();
    appendFileSync(file, `{"type":"a"}\n{"type":"long","pad":"${'x'.repeat(100)}`);
    const { tail, gaps } = gapTail(file, { maxLineBytes: 40, maxReadBytes: 16 });
    const first = await tail.read();
    expect(first.events).toHaveLength(1);
    expect(first.gaps).toBeUndefined();
    expect(gaps).toEqual([]);

    appendFileSync(file, '"}\n{"type":"b"}\n');
    const second = await tail.read();
    expect(second.events.map((entry) => entry.event.type)).toEqual(['b']);
    const end = Buffer.byteLength(`{"type":"a"}\n{"type":"long","pad":"${'x'.repeat(100)}"}\n`);
    expect(second.gaps).toEqual([
      {
        reason: 'oversized-line',
        fromOffset: 13,
        toOffset: end,
        discontinuity: false,
        error: expect.stringContaining('over 40 bytes'),
      },
    ]);
  });

  it('reports resets and rejected checkpoints as discontinuities', async () => {
    const file = makeJsonlFile();
    appendFileSync(file, '{"type":"one"}\n{"type":"two"}\n');
    const { tail, order } = gapTail(file);
    const first = await tail.read();
    const saved = first.checkpoint!;
    expect(saved).toEqual(tail.checkpoint());

    truncateSync(file, 0);
    appendFileSync(file, '{"type":"new"}\n');
    const after = await tail.read();
    expect(after.gaps).toEqual([
      { reason: 'truncated', fromOffset: 30, toOffset: 0, discontinuity: true },
    ]);
    expect(order).toEqual(['one', 'two', 'gap:truncated', 'new']);

    // A new tail cannot resume from the old checkpoint: the file was rewritten.
    const resumed = gapTail(file);
    expect(resumed.tail.resumeFrom(saved)).toBe(false);
    expect(resumed.gaps).toEqual([
      {
        reason: 'checkpoint-rejected',
        fromOffset: 30,
        toOffset: 0,
        discontinuity: true,
        error: 'The file no longer matches the checkpoint.',
      },
    ]);
    const replay = await resumed.tail.read();
    expect(replay.gaps).toEqual(resumed.gaps);
    expect(replay.events.map((entry) => entry.event.type)).toEqual(['new']);
    expect((await resumed.tail.read()).gaps).toBeUndefined();

    const garbage = gapTail(file);
    expect(garbage.tail.resumeFrom({ version: 99 })).toBe(false);
    expect(garbage.gaps[0]).toMatchObject({
      reason: 'checkpoint-rejected',
      fromOffset: 0,
      error: 'Not a valid checkpoint.',
    });
  });

  it('returns a checkpoint tied to exactly the events of each read', async () => {
    const file = makeJsonlFile();
    appendFileSync(file, '{"type":"one"}\n{"type":"tw');
    const { tail } = gapTail(file);
    const first = await tail.read();
    expect(first.events).toHaveLength(1);
    expect(first.checkpoint?.offset).toBe(15);

    appendFileSync(file, 'o"}\n');
    const second = await tail.read();
    expect(second.checkpoint?.offset).toBe(Buffer.byteLength('{"type":"one"}\n{"type":"two"}\n'));

    // Resuming from the first read's checkpoint replays exactly what came after it.
    const resumed = gapTail(file);
    expect(resumed.tail.resumeFrom(first.checkpoint)).toBe(true);
    expect((await resumed.tail.read()).events.map((entry) => entry.event.type)).toEqual(['two']);
  });
});
