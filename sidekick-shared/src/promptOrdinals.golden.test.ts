/**
 * Golden test for the prompt-ordinal scheme (`PROMPT_ORDINAL_SCHEME_VERSION`).
 *
 * Every surface that publishes or joins on prompt ordinals must number the
 * fixture sessions in `src/fixtures/prompt-ordinals/` exactly as
 * `expected.json` says: prompt history (default and in small resumed
 * chunks), session prompt history, `readPromptOrdinalMarks`, usage events'
 * `promptOrdinal`, and tool-call origins' `afterOrdinal`.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
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

vi.mock('./providers/codexDatabase', async () => {
  const actual = await vi.importActual<typeof import('./providers/codexDatabase')>(
    './providers/codexDatabase',
  );
  return {
    ...actual,
    CodexDatabase: class {
      isAvailable(): boolean {
        return false;
      }
      open(): boolean {
        return false;
      }
      close(): void {}
    },
  };
});

import { encodeWorkspacePath } from './parsers/sessionPathResolver';
import {
  __promptHistoryTesting,
  collectPromptHistory,
  PROMPT_HISTORY_ORDINAL_MAX_RECORD_BYTES,
  readPromptOrdinalMarks,
  type PromptHistoryBounds,
  type PromptHistoryCursor,
  type PromptHistoryEntry,
  type PromptHistoryProvider,
  type PromptHistoryResult,
} from './promptHistory';
import { PROMPT_ORDINAL_SCHEME_VERSION } from './promptOrdinalScheme';
import { ClaudeCodeProvider } from './providers/claudeCode';
import { CodexProvider } from './providers/codex';
import { collectSessionPromptHistory } from './sessionPromptHistory';
import { findToolCallOrigins } from './toolCallOrigins';
import { collectUsageEvents, USAGE_CACHE_VERSION } from './usage/usageEvents';

const FIXTURES = path.join(__dirname, 'fixtures', 'prompt-ordinals');

const CHANGED =
  'Prompt ordinals changed. If this is intended, bump PROMPT_ORDINAL_SCHEME_VERSION ' +
  '(src/promptOrdinalScheme.ts), update src/fixtures/prompt-ordinals/expected.json, ' +
  'and add a CHANGELOG entry: consumers key stored data on these ordinals.';

interface ExpectedPrompt {
  ordinal: number;
  timestamp: string;
  text: string;
}

interface ExpectedFile {
  provider: PromptHistoryProvider;
  sessionId: string;
  /** Ordinals assigned, including prompts that are not returned. */
  promptCount: number;
  /** Prompts `collectPromptHistory()` returns: in scope, with a timestamp. */
  prompts: ExpectedPrompt[];
  /** Ordinals with a usable timestamp, whatever their scope. */
  marks: number[];
  /** `promptOrdinal` of each usage event, oldest first. */
  usageOrdinals: Array<number | null>;
  /** `afterOrdinal` per tool-call id (`sessionId` when it is another session's). */
  toolCalls: Record<string, number | { sessionId: string; afterOrdinal: number | null }>;
  /** Tool calls issued from an out-of-scope working directory: never located. */
  outOfScopeToolCalls?: string[];
}

interface Expected {
  scheme: number;
  maxRecordBytes: number;
  usageCacheVersion: number;
  files: Record<string, ExpectedFile>;
}

const expected = JSON.parse(
  fs.readFileSync(path.join(FIXTURES, 'expected.json'), 'utf8'),
) as Expected;

let repo: string;
let outside: string;
let savedCodexHome: string | undefined;
/** Fixture name → installed session file. */
const installed = new Map<string, string>();

function jsonString(value: string): string {
  return JSON.stringify(value).slice(1, -1);
}

/** Fixture text with its placeholders filled and oversized markers expanded. */
function materialize(text: string): string {
  const lines = text.split('\n').map((line) => {
    if (!line.includes('"__fixture__"')) return line;
    const marker = JSON.parse(line) as { __fixture__: string; record: unknown };
    expect(marker.__fixture__).toBe('oversized');
    const padding = 'x'.repeat(expected.maxRecordBytes + 1);
    return JSON.stringify(marker.record).replace('"__PAD__"', JSON.stringify(padding));
  });
  return lines
    .join('\n')
    .replaceAll('__REPO__', jsonString(repo))
    .replaceAll('__OUTSIDE__', jsonString(outside));
}

function installPath(file: ExpectedFile): string {
  if (file.provider === 'claude-code') {
    return path.join(
      tmpDir,
      '.claude',
      'projects',
      encodeWorkspacePath(repo),
      `${file.sessionId}.jsonl`,
    );
  }
  return path.join(
    tmpDir,
    '.codex',
    'sessions',
    '2026',
    '09',
    '01',
    `rollout-2026-09-01T10-00-00-${file.sessionId}.jsonl`,
  );
}

function fileFor(provider: string, sessionId: string): string | undefined {
  return Object.entries(expected.files).find(
    ([, file]) => file.provider === provider && file.sessionId === sessionId,
  )?.[0];
}

function promptsByFile(entries: PromptHistoryEntry[]): Record<string, ExpectedPrompt[]> {
  const result: Record<string, ExpectedPrompt[]> = {};
  for (const name of Object.keys(expected.files)) result[name] = [];
  for (const entry of entries) {
    const name = fileFor(entry.provider, entry.sessionId);
    expect(name, `${entry.provider}:${entry.sessionId}`).toBeDefined();
    result[name!].push({ ordinal: entry.ordinal, timestamp: entry.timestamp, text: entry.text });
  }
  for (const list of Object.values(result)) list.sort((a, b) => a.ordinal - b.ordinal);
  return result;
}

function expectedPrompts(): Record<string, ExpectedPrompt[]> {
  return Object.fromEntries(
    Object.entries(expected.files).map(([name, file]) => [name, file.prompts]),
  );
}

/** Calls `collectPromptHistory` with the returned cursor until nothing is left. */
async function drain(bounds?: PromptHistoryBounds): Promise<{
  rows: PromptHistoryEntry[];
  calls: number;
  last: PromptHistoryResult;
}> {
  const rows = new Map<string, PromptHistoryEntry>();
  let cursor: PromptHistoryCursor | undefined;
  for (let calls = 1; calls <= 200; calls++) {
    const last = await collectPromptHistory({
      workspacePaths: [repo],
      includeWorktrees: false,
      cursor,
      bounds,
    });
    for (const entry of last.entries) {
      rows.set(`${entry.provider}:${entry.sessionId}:${entry.ordinal}`, entry);
    }
    cursor = JSON.parse(JSON.stringify(last.cursor)) as PromptHistoryCursor;
    if (!last.hasMore) return { rows: [...rows.values()], calls, last };
  }
  throw new Error('prompt history did not finish in 200 calls');
}

beforeAll(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-ordinals-golden-')));
  repo = path.join(tmpDir, 'work', 'repo');
  outside = path.join(tmpDir, 'work', 'elsewhere');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  savedCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = path.join(tmpDir, '.codex');
  for (const [name, file] of Object.entries(expected.files)) {
    const target = installPath(file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, materialize(fs.readFileSync(path.join(FIXTURES, name), 'utf8')));
    installed.set(name, target);
  }
});

afterAll(() => {
  __promptHistoryTesting.setReadChunkBytes(null);
  if (savedCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = savedCodexHome;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('prompt-ordinal scheme golden fixtures', { timeout: 60_000 }, () => {
  it('describes the current scheme and the bounds it depends on', () => {
    expect(expected.scheme, CHANGED).toBe(PROMPT_ORDINAL_SCHEME_VERSION);
    expect(expected.maxRecordBytes, CHANGED).toBe(PROMPT_HISTORY_ORDINAL_MAX_RECORD_BYTES);
    expect(expected.usageCacheVersion, CHANGED).toBe(USAGE_CACHE_VERSION);
    // Each oversized marker became one record just over the bound.
    for (const name of ['claude-code/oversized.jsonl', 'codex/oversized.jsonl']) {
      const longest = Math.max(
        ...fs
          .readFileSync(installed.get(name)!, 'utf8')
          .split('\n')
          .map((line) => Buffer.byteLength(line)),
      );
      expect(longest).toBeGreaterThan(expected.maxRecordBytes);
      expect(longest).toBeLessThan(expected.maxRecordBytes + 1024);
    }
  });

  it('collectPromptHistory numbers every fixture prompt as expected', async () => {
    // Default bounds: an oversized record over the 16 MiB file budget takes a second call.
    const { rows, calls, last } = await drain();
    expect(last.ordinalScheme).toBe(PROMPT_ORDINAL_SCHEME_VERSION);
    expect(last.cursor.ordinalScheme).toBe(PROMPT_ORDINAL_SCHEME_VERSION);
    expect(calls).toBeLessThanOrEqual(3);
    expect(promptsByFile(rows), CHANGED).toEqual(expectedPrompts());
  });

  it('a cursor drain in small chunks returns the same ordinals', async () => {
    __promptHistoryTesting.setReadChunkBytes(4093);
    try {
      const { rows, calls } = await drain({ maxEntries: 1, maxFileBytes: 3 * 1024 * 1024 });
      expect(calls).toBeGreaterThan(10);
      expect(promptsByFile(rows), CHANGED).toEqual(expectedPrompts());
    } finally {
      __promptHistoryTesting.setReadChunkBytes(null);
    }
  });

  it('collectSessionPromptHistory agrees, counting the prompts it leaves out', async () => {
    const result = await collectSessionPromptHistory({
      workspacePaths: [repo],
      includeWorktrees: false,
    });
    expect(result.ordinalScheme).toBe(PROMPT_ORDINAL_SCHEME_VERSION);
    const sessions = new Map(
      result.sessions.map((session) => [fileFor(session.provider, session.sessionId)!, session]),
    );
    for (const [name, file] of Object.entries(expected.files)) {
      const session = sessions.get(name);
      if (file.prompts.length === 0) {
        expect(session, name).toBeUndefined();
        continue;
      }
      expect(
        session?.prompts.map(({ ordinal, timestamp, text }) => ({ ordinal, timestamp, text })),
        `${name}: ${CHANGED}`,
      ).toEqual(file.prompts);
      expect(session?.droppedPrompts, `${name}: ${CHANGED}`).toBe(
        file.promptCount - file.prompts.length,
      );
    }
  });

  it('readPromptOrdinalMarks lists every timestamped prompt, in scope or not', async () => {
    for (const [name, file] of Object.entries(expected.files)) {
      const marks = await readPromptOrdinalMarks(
        file.provider,
        file.sessionId,
        installed.get(name)!,
      );
      expect(
        marks.map((mark) => mark.ordinal),
        `${name}: ${CHANGED}`,
      ).toEqual(file.marks);
      for (const prompt of file.prompts) {
        expect(marks.find((mark) => mark.ordinal === prompt.ordinal)?.timestampMs).toBe(
          Date.parse(prompt.timestamp),
        );
      }
    }
  });

  it('usage events carry the ordinal of the prompt each call followed', async () => {
    const providers = [new ClaudeCodeProvider(), new CodexProvider()];
    try {
      const result = await collectUsageEvents({ providers, noCache: true });
      const byFile: Record<string, Array<number | null | undefined>> = {};
      for (const name of Object.keys(expected.files)) byFile[name] = [];
      for (const event of result.events) {
        const name = fileFor(event.provider, event.sessionId);
        expect(name, `${event.provider}:${event.sessionId}`).toBeDefined();
        byFile[name!].push(event.promptOrdinal);
      }
      expect(byFile, CHANGED).toEqual(
        Object.fromEntries(
          Object.entries(expected.files).map(([name, file]) => [name, file.usageOrdinals]),
        ),
      );
    } finally {
      for (const provider of providers) provider.dispose();
    }
  });

  it('tool-call origins carry the ordinal of the prompt each call answered', async () => {
    const wanted = new Map<string, { sessionId: string; afterOrdinal: number | null }>();
    const absent: string[] = [];
    for (const file of Object.values(expected.files)) {
      for (const [id, value] of Object.entries(file.toolCalls)) {
        wanted.set(
          id,
          typeof value === 'number' ? { sessionId: file.sessionId, afterOrdinal: value } : value,
        );
      }
      absent.push(...(file.outOfScopeToolCalls ?? []));
    }
    const origins = await findToolCallOrigins({
      ids: [...wanted.keys(), ...absent],
      workspacePaths: [repo],
      includeWorktrees: false,
    });
    const actual = Object.fromEntries(
      [...origins].map(([id, origin]) => [
        id,
        { sessionId: origin.sessionId, afterOrdinal: origin.afterOrdinal },
      ]),
    );
    expect(actual, CHANGED).toEqual(Object.fromEntries(wanted));
  });
});
