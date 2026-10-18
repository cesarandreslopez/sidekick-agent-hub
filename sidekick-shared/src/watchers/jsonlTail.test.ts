import {
  mkdtempSync,
  renameSync,
  rmSync,
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
  createJsonlTail,
  type JsonlTailBatch,
  type JsonlTailLine,
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
