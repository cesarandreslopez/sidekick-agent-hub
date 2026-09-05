import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let tmpDir: string;

vi.mock('../paths', () => ({
  getConfigDir: () => path.join(tmpDir, 'config'),
}));

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return { ...actual, homedir: () => tmpDir };
});

import { applySessionSummary, isFileImported, markFileImported } from '../historicalStore';
import { ClaudeCodeProvider } from '../providers/claudeCode';
import { createEmptyDataStore } from '../types/historicalData';
import type { HistoricalDataStore, SessionSummary } from '../types/historicalData';
import { importSessionHistory } from './importSessionHistory';

const MODEL = 'claude-sonnet-4-5-20250929';

function rows(prompt: string) {
  return [
    {
      type: 'user',
      timestamp: '2026-09-04T12:00:00.000Z',
      cwd: '/work/project',
      message: { role: 'user', content: prompt },
    },
    {
      type: 'assistant',
      timestamp: '2026-09-04T12:00:05.000Z',
      message: {
        id: 'msg-1',
        role: 'assistant',
        model: MODEL,
        usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 40 },
        content: [
          { type: 'text', text: 'ok' },
          { type: 'tool_use', id: 't1', name: 'Read', input: {} },
        ],
      },
    },
    {
      type: 'user',
      timestamp: '2026-09-04T12:00:08.000Z',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 't1', content: 'done' }],
      },
    },
  ];
}

function writeSession(name: string, content: unknown[], ageMs = 120_000): string {
  const dir = path.join(tmpDir, '.claude', 'projects', '-work-project');
  fs.mkdirSync(dir, { recursive: true });
  const sessionPath = path.join(dir, `${name}.jsonl`);
  fs.writeFileSync(sessionPath, content.map((row) => JSON.stringify(row)).join('\n') + '\n');
  const old = new Date(Date.now() - ageMs);
  fs.utimesSync(sessionPath, old, old);
  return sessionPath;
}

/** A caller that applies summaries to an in-memory store, the way both hosts do. */
function storeCallbacks(store: HistoricalDataStore) {
  const applied: SessionSummary[] = [];
  return {
    applied,
    isImported: (sessionId: string, filePath: string) =>
      isFileImported(store, filePath) ||
      (store.sessions ?? []).some((session) => session.sessionId === sessionId),
    applySummary: (summary: SessionSummary) => {
      applied.push(summary);
      applySessionSummary(store, summary);
    },
    markImported: (filePath: string) => {
      markFileImported(store, filePath);
    },
  };
}

describe('importSessionHistory', () => {
  let provider: ClaudeCodeProvider;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-import-history-'));
    provider = new ClaudeCodeProvider();
  });

  afterEach(() => {
    provider.dispose();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('imports finished sessions with provider, project, cost, and tool usage', async () => {
    writeSession('done-1', rows('Fix the parser'));
    const store = createEmptyDataStore();
    const callbacks = storeCallbacks(store);
    const progress: Array<[number, number]> = [];

    const result = await importSessionHistory({
      providers: [provider],
      ...callbacks,
      onProgress: (loaded, total) => progress.push([loaded, total]),
    });

    expect(result).toMatchObject({
      filesFound: 1,
      filesProcessed: 1,
      filesSkipped: 0,
      filesUnavailable: 0,
      sessionsImported: 1,
      messagesImported: 3,
    });
    expect(progress).toEqual([[1, 1]]);
    expect(callbacks.applied[0]).toMatchObject({
      sessionId: 'done-1',
      provider: 'claude-code',
      project: '/work/project',
      messageCount: 3,
      tokens: { inputTokens: 100, outputTokens: 10, cacheWriteTokens: 0, cacheReadTokens: 40 },
      toolUsage: [{ tool: 'Read', calls: 1, successCount: 1, failureCount: 0 }],
    });
    expect(callbacks.applied[0].totalCost).toBeGreaterThan(0);
    expect(callbacks.applied[0].modelUsage[0]).toMatchObject({
      model: MODEL,
      calls: 1,
      priced: true,
    });
    expect(store.allTime.sessionCount).toBe(1);
    expect(store.importedFiles).toHaveLength(1);
  });

  it('skips files already imported, sessions already saved, and files still being written', async () => {
    const imported = writeSession('imported', rows('a'));
    writeSession('saved', rows('b'));
    writeSession('live', rows('c'), 5_000);
    const store = createEmptyDataStore();
    markFileImported(store, imported);
    applySessionSummary(store, {
      sessionId: 'saved',
      startTime: '2026-09-04T12:00:00.000Z',
      endTime: '2026-09-04T12:00:05.000Z',
      tokens: { inputTokens: 1, outputTokens: 1, cacheWriteTokens: 0, cacheReadTokens: 0 },
      totalCost: 0,
      messageCount: 1,
      modelUsage: [],
      toolUsage: [],
    });
    const callbacks = storeCallbacks(store);

    const result = await importSessionHistory({ providers: [provider], ...callbacks });

    expect(result).toMatchObject({ filesFound: 3, filesProcessed: 0, filesSkipped: 3 });
    expect(callbacks.applied).toHaveLength(0);

    // Once the live file settles it is imported on the next run.
    const settled = new Date(Date.now() - 120_000);
    fs.utimesSync(
      path.join(tmpDir, '.claude', 'projects', '-work-project', 'live.jsonl'),
      settled,
      settled,
    );
    const second = await importSessionHistory({ providers: [provider], ...callbacks });
    expect(second).toMatchObject({ filesProcessed: 1, filesSkipped: 2, sessionsImported: 1 });
    expect(callbacks.applied.map((summary) => summary.sessionId)).toEqual(['live']);
  });

  it('is idempotent across runs', async () => {
    writeSession('done-2', rows('x'));
    const store = createEmptyDataStore();
    const callbacks = storeCallbacks(store);
    await importSessionHistory({ providers: [provider], ...callbacks });
    const again = await importSessionHistory({ providers: [provider], ...callbacks });
    expect(again).toMatchObject({ filesProcessed: 0, filesSkipped: 1, sessionsImported: 0 });
    expect(store.allTime.sessionCount).toBe(1);
  });

  it('marks a usage-free file as imported without crediting a session', async () => {
    writeSession('empty', [rows('y')[0]]);
    const store = createEmptyDataStore();
    const callbacks = storeCallbacks(store);
    const result = await importSessionHistory({ providers: [provider], ...callbacks });
    expect(result).toMatchObject({ filesProcessed: 1, filesUnavailable: 1, sessionsImported: 0 });
    expect(store.importedFiles).toHaveLength(1);
    expect(store.allTime.sessionCount).toBe(0);
    expect(callbacks.applied).toHaveLength(0);
  });
});
