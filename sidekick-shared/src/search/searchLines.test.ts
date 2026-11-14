import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { forEachLineAsync, searchSnippet } from './searchLines';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-search-lines-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const CONTENT = 'first line\nsecond — ünïcödé 🚀\n\r\nthird\nno newline at end ✓';

async function collect(source: string | Buffer, chunkBytes?: number): Promise<string[]> {
  const lines: string[] = [];
  const done = await forEachLineAsync(source, (line) => void lines.push(line), { chunkBytes });
  expect(done).toBe(true);
  return lines;
}

describe('forEachLineAsync', () => {
  it.each([1, 2, 3, 5, 64, undefined])(
    'lists the lines split() lists, %s bytes per chunk',
    async (size) => {
      const file = path.join(dir, 'a.txt');
      fs.writeFileSync(file, CONTENT);
      expect(await collect(file, size)).toEqual(CONTENT.split('\n'));
      expect(await collect(Buffer.from(CONTENT), size)).toEqual(CONTENT.split('\n'));
    },
  );

  it('lists a trailing empty segment and an empty file as split() does', async () => {
    const file = path.join(dir, 'b.txt');
    fs.writeFileSync(file, 'a\nb\n');
    expect(await collect(file, 1)).toEqual(['a', 'b', '']);
    fs.writeFileSync(file, '');
    expect(await collect(file)).toEqual(['']);
  });

  it('stops when onLine returns false', async () => {
    const file = path.join(dir, 'c.txt');
    fs.writeFileSync(file, CONTENT);
    const lines: string[] = [];
    const done = await forEachLineAsync(
      file,
      (line) => {
        lines.push(line);
        return lines.length < 2;
      },
      { chunkBytes: 4 },
    );
    expect(done).toBe(false);
    expect(lines).toEqual(CONTENT.split('\n').slice(0, 2));
  });

  it('ends quietly on abort, between chunks', async () => {
    const file = path.join(dir, 'd.txt');
    fs.writeFileSync(file, Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n'));
    const controller = new AbortController();
    const lines: string[] = [];
    const done = await forEachLineAsync(
      file,
      (line) => {
        lines.push(line);
        if (lines.length === 3) controller.abort();
      },
      { chunkBytes: 16, signal: controller.signal },
    );
    expect(done).toBe(false);
    expect(lines.length).toBeLessThan(200);
  });

  it('rejects for a missing file', async () => {
    await expect(forEachLineAsync(path.join(dir, 'missing'), () => {})).rejects.toThrow();
  });
});

describe('searchSnippet', () => {
  it('cuts 40 characters either side and marks the cuts', () => {
    const text = `${'a'.repeat(50)}NEEDLE${'b'.repeat(50)}`;
    expect(searchSnippet(text, 'needle', 'needle')).toBe(
      `...${'a'.repeat(40)}NEEDLE${'b'.repeat(40)}...`,
    );
    expect(searchSnippet('short\nneedle here', 'needle', 'needle')).toBe('short needle here');
    expect(searchSnippet('nothing', 'needle', 'needle')).toBeNull();
  });
});
