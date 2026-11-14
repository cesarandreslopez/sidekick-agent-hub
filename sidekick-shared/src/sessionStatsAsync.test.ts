/**
 * `readSessionFileStatsAsync()` reads a session in bounded steps and must
 * give the stats `readSessionFileStats()` gives, for both JSONL providers,
 * any step size, and the unavailable cases; `importSessionHistory()` uses it
 * and honours an abort.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let tmpDir: string;

vi.mock('./paths', async () => {
  const actual = await vi.importActual<typeof import('./paths')>('./paths');
  return { ...actual, getConfigDir: () => path.join(tmpDir, 'config') };
});

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return { ...actual, homedir: () => tmpDir };
});

import { ClaudeCodeProvider } from './providers/claudeCode';
import { CodexProvider } from './providers/codex';
import type { SessionProviderBase } from './providers/types';
import {
  computeSessionFileStats,
  readSessionFileStats,
  readSessionFileStatsAsync,
  SessionFileStatsAccumulator,
} from './sessionStats';
import { importSessionHistory } from './usage/importSessionHistory';

const MODEL = 'claude-sonnet-4-5-20250929';

const claudeRows = (prompt: string, n: number) => {
  const rows: unknown[] = [];
  for (let i = 0; i < n; i++) {
    const at = (s: number) => `2026-09-04T12:${String(i).padStart(2, '0')}:${s}0.000Z`;
    rows.push(
      {
        type: 'user',
        timestamp: at(0),
        cwd: '/work/p',
        message: { role: 'user', content: `${prompt} ${i} — ünï 🚀` },
      },
      {
        type: 'assistant',
        timestamp: at(1),
        message: {
          id: `msg-${i}`,
          role: 'assistant',
          model: MODEL,
          usage: { input_tokens: 100 + i, output_tokens: 10, cache_read_input_tokens: 40 },
          content: [
            { type: 'text', text: 'ok' },
            { type: 'tool_use', id: `t${i}`, name: i % 2 ? 'Read' : 'Bash', input: {} },
          ],
        },
      },
      {
        type: 'user',
        timestamp: at(2),
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: `t${i}`, content: 'done', is_error: i % 3 === 0 },
          ],
        },
      },
    );
  }
  return rows;
};

const codexRows = (n: number) => {
  const rows: unknown[] = [
    {
      type: 'session_meta',
      timestamp: '2026-09-04T12:00:00.000Z',
      payload: { id: 'cx', cwd: '/work/p' },
    },
    {
      type: 'turn_context',
      timestamp: '2026-09-04T12:00:00.000Z',
      payload: { model: 'gpt-5-codex', cwd: '/work/p' },
    },
  ];
  for (let i = 0; i < n; i++) {
    const at = `2026-09-04T12:${String(i + 1).padStart(2, '0')}:00.000Z`;
    rows.push(
      {
        type: 'response_item',
        timestamp: at,
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: `do ${i} é` }],
        },
      },
      {
        type: 'event_msg',
        timestamp: at,
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: {
              input_tokens: 1000 * (i + 1),
              cached_input_tokens: 100 * i,
              output_tokens: 50 * (i + 1),
              total_tokens: 1050 * (i + 1),
            },
          },
        },
      },
    );
  }
  return rows;
};

function writeFile(name: string, rows: unknown[], trailing = ''): string {
  const file = path.join(tmpDir, 'sessions', name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, rows.map((row) => JSON.stringify(row)).join('\n') + '\n' + trailing);
  return file;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-stats-async-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('SessionFileStatsAccumulator', () => {
  it('gives computeSessionFileStats for the events added in batches', () => {
    const provider = new ClaudeCodeProvider();
    const file = writeFile('acc.jsonl', claudeRows('go', 5));
    const reader = provider.createReader(file);
    const events = reader.readAll();
    const options = { providerId: provider.id, sessionId: 'acc', filePath: file };
    const accumulator = new SessionFileStatsAccumulator(options);
    for (let i = 0; i < events.length; i += 2) accumulator.add(events.slice(i, i + 2));
    expect(accumulator.eventCount).toBe(events.length);
    expect(accumulator.finish(options)).toEqual(computeSessionFileStats(events, options));
  });
});

describe('readSessionFileStatsAsync', () => {
  const cases: Array<[string, () => SessionProviderBase, () => string]> = [
    [
      'Claude Code',
      () => new ClaudeCodeProvider(),
      () =>
        writeFile(
          'claude.jsonl',
          claudeRows('Refactor', 12),
          // A last line with no newline still counts.
          JSON.stringify({
            type: 'user',
            timestamp: '2026-09-04T13:00:00Z',
            message: { role: 'user', content: 'tail' },
          }),
        ),
    ],
    ['Codex', () => new CodexProvider(), () => writeFile('rollout-cx.jsonl', codexRows(10))],
  ];

  it.each(cases)(
    '%s: same stats as the synchronous read at any step size',
    async (_name, make, write) => {
      const provider = make();
      const file = write();
      const expected = readSessionFileStats(provider, file);
      expect(expected.messageCount).toBeGreaterThan(5);
      for (const chunkBytes of [1, 16, 100, 4096, undefined]) {
        expect(await readSessionFileStatsAsync(provider, file, { chunkBytes })).toEqual(expected);
      }
    },
  );

  it('reports a missing file as unavailable, like the synchronous read', async () => {
    const provider = new ClaudeCodeProvider();
    const file = path.join(tmpDir, 'missing.jsonl');
    const expected = readSessionFileStats(provider, file);
    expect(expected.availability).toBe('unavailable');
    expect(await readSessionFileStatsAsync(provider, file)).toEqual(expected);
  });

  it('reports a reader that throws as unavailable with its message', async () => {
    const provider = new ClaudeCodeProvider();
    vi.spyOn(provider, 'createReader').mockImplementation(() => {
      throw new Error('boom');
    });
    const stats = await readSessionFileStatsAsync(provider, path.join(tmpDir, 'x.jsonl'));
    expect(stats.availability).toBe('unavailable');
    expect(stats.unavailableReason).toBe('boom');
  });

  it('counts a file replaced mid-read from its start and reports it partial', async () => {
    const provider = new ClaudeCodeProvider();
    const file = writeFile('replaced.jsonl', claudeRows('first', 10));
    const replacement = path.join(tmpDir, 'sessions', 'next.jsonl');
    fs.writeFileSync(
      replacement,
      claudeRows('second', 2)
        .map((row) => JSON.stringify(row))
        .join('\n') + '\n',
    );
    const createReader = provider.createReader.bind(provider);
    vi.spyOn(provider, 'createReader').mockImplementation((p: string) => {
      const reader = createReader(p);
      const step = reader.readNewBounded!.bind(reader);
      let steps = 0;
      reader.readNewBounded = (maxBytes: number) => {
        const result = step(maxBytes);
        // Replace the file after the first step.
        if (++steps === 1) fs.renameSync(replacement, file);
        return result;
      };
      return reader;
    });
    const stats = await readSessionFileStatsAsync(provider, file, { chunkBytes: 200 });
    expect(stats.availability).toBe('partial');
    const fresh = readSessionFileStats(new ClaudeCodeProvider(), file);
    expect({ ...stats, availability: 'full' }).toEqual(fresh);
  });

  it('rejects on abort instead of reporting unavailable', async () => {
    const provider = new ClaudeCodeProvider();
    const file = writeFile('abort.jsonl', claudeRows('go', 20));
    const controller = new AbortController();
    setImmediate(() => controller.abort());
    await expect(
      readSessionFileStatsAsync(provider, file, { chunkBytes: 64, signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('importSessionHistory with a signal', () => {
  function writeProjectSession(name: string, rows: unknown[]): string {
    const dir = path.join(tmpDir, '.claude', 'projects', '-work-project');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${name}.jsonl`);
    fs.writeFileSync(file, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
    const old = new Date(Date.now() - 120_000);
    fs.utimesSync(file, old, old);
    return file;
  }

  it('resolves with what it imported, leaving the session it was reading unmarked', async () => {
    writeProjectSession('a', claudeRows('first', 3));
    writeProjectSession('b', claudeRows('second', 3));
    const controller = new AbortController();
    const applied: string[] = [];
    const marked: string[] = [];
    const result = await importSessionHistory({
      providers: [new ClaudeCodeProvider()],
      isImported: () => false,
      applySummary: (summary) => {
        applied.push(summary.sessionId);
        // Abort while the next session is being read.
        controller.abort();
      },
      markImported: (filePath) => marked.push(filePath),
      signal: controller.signal,
    });
    expect(result.aborted).toBe(true);
    expect(result.filesFound).toBe(2);
    expect(applied).toHaveLength(1);
    expect(marked).toHaveLength(1);
    expect(result.sessionsImported).toBe(1);
    expect(result.filesProcessed).toBe(1);
  });

  it('does nothing when the signal is already aborted', async () => {
    writeProjectSession('a', claudeRows('first', 3));
    const result = await importSessionHistory({
      providers: [new ClaudeCodeProvider()],
      isImported: () => false,
      applySummary: () => {
        throw new Error('not expected');
      },
      markImported: () => {},
      signal: AbortSignal.abort(),
    });
    expect(result).toMatchObject({ aborted: true, filesFound: 0, filesProcessed: 0 });
  });

  it('leaves `aborted` unset when it finishes', async () => {
    writeProjectSession('a', claudeRows('first', 3));
    const result = await importSessionHistory({
      providers: [new ClaudeCodeProvider()],
      isImported: () => false,
      applySummary: () => {},
      markImported: () => {},
      signal: new AbortController().signal,
    });
    expect(result.sessionsImported).toBe(1);
    expect(result.aborted).toBeUndefined();
  });

  it('aborts mid-session: the half-read session is neither applied nor marked', async () => {
    // Large enough to take several 1 MiB steps.
    const big = claudeRows('big', 3).concat(
      Array.from({ length: 30 }, (_, i) => ({
        type: 'system',
        subtype: 'filler',
        timestamp: '2026-09-04T12:30:00.000Z',
        content: `${i}`.padEnd(100_000, 'f'),
      })),
    );
    writeProjectSession('big', big);
    const controller = new AbortController();
    const provider = new ClaudeCodeProvider();
    const createReader = provider.createReader.bind(provider);
    let steps = 0;
    vi.spyOn(provider, 'createReader').mockImplementation((p: string) => {
      const reader = createReader(p);
      const step = reader.readNewBounded!.bind(reader);
      reader.readNewBounded = (maxBytes: number) => {
        const result = step(maxBytes);
        // The first step is read; the abort lands before the second.
        if (++steps === 1) controller.abort();
        return result;
      };
      return reader;
    });
    const applied: string[] = [];
    const marked: string[] = [];
    const result = await importSessionHistory({
      providers: [provider],
      isImported: () => false,
      applySummary: (summary) => applied.push(summary.sessionId),
      markImported: (filePath) => marked.push(filePath),
      signal: controller.signal,
    });
    expect(steps).toBe(1);
    expect(result.aborted).toBe(true);
    expect(applied).toEqual([]);
    expect(marked).toEqual([]);
    expect(result.filesProcessed).toBe(0);
  });
});
