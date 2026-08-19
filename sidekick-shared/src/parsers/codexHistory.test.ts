import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let tmpDir: string;

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return {
    ...actual,
    homedir: () => tmpDir,
  };
});

vi.mock('../paths', () => ({
  getConfigDir: () => tmpDir,
}));

import { readCodexHistory } from './codexHistory';

function historyPath(): string {
  return path.join(tmpDir, '.codex', 'history.jsonl');
}

function writeHistory(lines: string[]): void {
  fs.mkdirSync(path.dirname(historyPath()), { recursive: true });
  fs.writeFileSync(historyPath(), lines.join('\n') + '\n');
}

function entryLine(sessionId: string, ts: number, text: string): string {
  return JSON.stringify({ session_id: sessionId, ts, text });
}

describe('readCodexHistory', () => {
  let previousCodexHome: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-codex-history-'));
    previousCodexHome = process.env.CODEX_HOME;
    delete process.env.CODEX_HOME;
  });

  afterEach(() => {
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns entries newest first', () => {
    writeHistory([
      entryLine('session-a', 1_700_000_001, 'first prompt'),
      entryLine('session-b', 1_700_000_002, 'second prompt'),
      entryLine('session-c', 1_700_000_003, 'third prompt'),
    ]);

    expect(readCodexHistory()).toEqual([
      { sessionId: 'session-c', ts: 1_700_000_003, tsMs: 1_700_000_003_000, text: 'third prompt' },
      { sessionId: 'session-b', ts: 1_700_000_002, tsMs: 1_700_000_002_000, text: 'second prompt' },
      { sessionId: 'session-a', ts: 1_700_000_001, tsMs: 1_700_000_001_000, text: 'first prompt' },
    ]);
  });

  it('honors the limit', () => {
    writeHistory([
      entryLine('session-a', 1, 'one'),
      entryLine('session-b', 2, 'two'),
      entryLine('session-c', 3, 'three'),
    ]);

    expect(readCodexHistory({ limit: 1 })).toEqual([
      { sessionId: 'session-c', ts: 3, tsMs: 3000, text: 'three' },
    ]);
    expect(readCodexHistory({ limit: 0 })).toEqual([]);
  });

  it('returns an empty list when the file is missing', () => {
    expect(readCodexHistory()).toEqual([]);
    expect(readCodexHistory({ codexHome: path.join(tmpDir, 'nowhere') })).toEqual([]);
  });

  it('honors a codexHome override', () => {
    const otherHome = path.join(tmpDir, 'other-home');
    fs.mkdirSync(otherHome, { recursive: true });
    fs.writeFileSync(path.join(otherHome, 'history.jsonl'), entryLine('other', 9, 'hi') + '\n');

    expect(readCodexHistory({ codexHome: otherHome })).toEqual([
      { sessionId: 'other', ts: 9, tsMs: 9000, text: 'hi' },
    ]);
  });

  it('skips malformed and wrong-shape lines', () => {
    writeHistory([
      'not json at all',
      '{"session_id": 42, "ts": 1, "text": "wrong id type"}',
      '{"session_id": "no-ts", "text": "missing ts"}',
      '{"session_id": "inf-ts", "ts": 1e400, "text": "non-finite ts"}',
      entryLine('session-ok', 5, 'valid'),
      '{"truncated": ',
    ]);

    expect(readCodexHistory()).toEqual([
      { sessionId: 'session-ok', ts: 5, tsMs: 5000, text: 'valid' },
    ]);
  });

  it('drops the partial first line of a bounded tail', () => {
    const lines = [
      entryLine('session-a', 1, 'oldest, will be cut mid-line'),
      entryLine('session-b', 2, 'kept'),
      entryLine('session-c', 3, 'kept too'),
    ];
    writeHistory(lines);
    const totalBytes = fs.statSync(historyPath()).size;
    // A tail that starts inside the first line: it must be discarded, not
    // parsed as garbage.
    const tailBytes = totalBytes - Math.floor(lines[0].length / 2);

    expect(readCodexHistory({ maxTailBytes: tailBytes })).toEqual([
      { sessionId: 'session-c', ts: 3, tsMs: 3000, text: 'kept too' },
      { sessionId: 'session-b', ts: 2, tsMs: 2000, text: 'kept' },
    ]);
  });

  it('survives a multibyte character straddling the tail boundary', () => {
    const emojiText = '🚀🚀🚀🚀🚀🚀🚀🚀';
    const lines = [
      entryLine('session-emoji', 1, emojiText),
      entryLine('session-b', 2, 'ascii entry'),
    ];
    writeHistory(lines);
    const totalBytes = fs.statSync(historyPath()).size;
    // Position the tail start inside one of the 4-byte emoji sequences.
    const firstLineBytes = Buffer.byteLength(lines[0], 'utf8');
    const tailBytes = totalBytes - Math.floor(firstLineBytes / 2) - 1;

    const entries = readCodexHistory({ maxTailBytes: tailBytes });

    expect(entries).toEqual([{ sessionId: 'session-b', ts: 2, tsMs: 2000, text: 'ascii entry' }]);
  });

  it('sizes the default tail from a large limit', () => {
    const longText = 'x'.repeat(3000);
    writeHistory(
      Array.from({ length: 220 }, (_, index) => entryLine(`session-${index}`, index, longText)),
    );

    expect(readCodexHistory({ limit: 200 })).toHaveLength(200);
  });
});
