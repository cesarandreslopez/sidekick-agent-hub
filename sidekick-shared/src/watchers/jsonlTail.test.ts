import { mkdtempSync, rmSync, writeFileSync, appendFileSync, truncateSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createJsonlTail, type JsonlTailBatch } from './jsonlTail';

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

    expect(events.map(e => e.type)).toEqual(['one', 'two']);
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

    expect(events.map(e => e.type)).toEqual(['one']);
    expect(batches.map(b => b.eventsRead)).toEqual([0, 1]);
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

    expect(events.map(e => e.type)).toEqual(['one', 'two']);
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

    expect(events.map(e => e.type)).toEqual(['one', '2']);
    expect(tail.getOffset()).toBe(Buffer.byteLength('{"type":"2"}\n'));
  });
});
