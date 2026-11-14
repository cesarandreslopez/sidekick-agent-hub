import { describe, expect, it } from 'vitest';
import { JsonlParser } from './jsonl';
import { splitLines } from './lineSplitter';

function splitAll(chunks: string[]): { lines: string[]; carry: string } {
  const lines: string[] = [];
  let carry = '';
  for (const chunk of chunks) carry = splitLines(carry, chunk, (line) => lines.push(line));
  return { lines, carry };
}

/** Deterministic pseudo-random cut points. */
function chunkings(text: string, seed: number): string[] {
  const chunks: string[] = [];
  let state = seed;
  let at = 0;
  while (at < text.length) {
    state = (state * 1103515245 + 12345) % 2 ** 31;
    const size = 1 + (state % 17);
    chunks.push(text.slice(at, at + size));
    at += size;
  }
  return chunks;
}

describe('splitLines', () => {
  it('returns complete lines and carries the remainder', () => {
    expect(splitAll(['a\nb', 'c\n', '\nd'])).toEqual({ lines: ['a', 'bc', ''], carry: 'd' });
  });

  it('carries a chunk without a newline whole', () => {
    expect(splitAll(['abc', 'def'])).toEqual({ lines: [], carry: 'abcdef' });
  });

  it('matches split for any chunking', () => {
    const text = 'one\ntwo\r\n\nthree four\nfive';
    const expected = text.split('\n');
    const carry = expected.pop();
    for (let seed = 1; seed < 40; seed++) {
      expect(splitAll(chunkings(text, seed))).toEqual({ lines: expected, carry });
    }
  });
});

describe('JsonlParser.processChunk', () => {
  it('emits the same records for any chunking, including long lines', () => {
    const rows = [{ a: 1 }, { b: 'x'.repeat(500) }, { c: [1, 2, 3] }, { d: 'ü🚀' }];
    const text = rows.map((row) => JSON.stringify(row)).join('\n') + '\n{"partial":';
    for (let seed = 1; seed < 20; seed++) {
      const seen: unknown[] = [];
      const parser = new JsonlParser<unknown>({ onEvent: (event) => seen.push(event) });
      for (const chunk of chunkings(text, seed)) parser.processChunk(chunk);
      expect(seen).toEqual(rows);
      parser.processChunk('true}');
      parser.flush();
      expect(seen).toEqual([...rows, { partial: true }]);
    }
  });
});
