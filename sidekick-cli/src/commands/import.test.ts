import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import chalk from 'chalk';

const { mockImport, mockReadHistory, mockUpdateStore, mockDetected, mockResolveProvider } =
  vi.hoisted(() => ({
    mockImport: vi.fn(),
    mockReadHistory: vi.fn(),
    mockUpdateStore: vi.fn(),
    mockDetected: vi.fn(),
    mockResolveProvider: vi.fn(),
  }));

vi.mock('sidekick-shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('sidekick-shared')>()),
  importSessionHistory: (...args: unknown[]) => mockImport(...args),
  readHistory: () => mockReadHistory(),
  updateJsonStoreAtomic: (...args: unknown[]) => mockUpdateStore(...args),
  getAllDetectedProviders: () => mockDetected(),
  createSessionProviders: (options: { providerIds: string[] }) => ({
    providers: options.providerIds.map((id) => ({ id, dispose: vi.fn() })),
    diagnostics: [],
  }),
  getGlobalDataPath: (name: string) => `/config/${name}`,
}));

vi.mock('../cli', () => ({
  resolveProvider: (...args: unknown[]) => mockResolveProvider(...args),
}));

import { createEmptyDataStore } from 'sidekick-shared';
import type { HistoricalDataStore, SessionSummary } from 'sidekick-shared';
import { applyPendingImports, importAction } from './import';

function summary(sessionId: string): SessionSummary {
  return {
    sessionId,
    startTime: '2026-09-04T12:00:00.000Z',
    endTime: '2026-09-04T12:05:00.000Z',
    tokens: { inputTokens: 100, outputTokens: 10, cacheWriteTokens: 0, cacheReadTokens: 40 },
    totalCost: 0.05,
    messageCount: 3,
    modelUsage: [{ model: 'claude-sonnet-4-5', calls: 1, tokens: 150, cost: 0.05, priced: true }],
    toolUsage: [],
    provider: 'claude-code',
    project: '/work',
  };
}

describe('applyPendingImports', () => {
  it('credits new sessions once and marks every file, skipping sessions persisted meanwhile', () => {
    const store = createEmptyDataStore();
    store.sessions = [
      {
        ...summary('meanwhile'),
        provider: 'claude-code',
        project: '/work',
        qualityScore: 0,
        qualityFactors: [],
        additions: 0,
        deletions: 0,
        costPerChangedLine: null,
      },
    ];
    const outcome = applyPendingImports(
      store,
      [
        { summary: summary('fresh'), filePath: '/s/fresh.jsonl' },
        { summary: summary('meanwhile'), filePath: '/s/meanwhile.jsonl' },
        { summary: null, filePath: '/s/empty.jsonl' },
      ],
      new Date('2026-09-04T13:00:00Z'),
    );
    expect(outcome).toEqual({ applied: 1, alreadyPresent: 1 });
    expect(store.allTime.sessionCount).toBe(1);
    expect(store.sessions?.map((session) => session.sessionId)).toEqual(['meanwhile', 'fresh']);
    expect(store.importedFiles).toEqual(['/s/fresh.jsonl', '/s/meanwhile.jsonl', '/s/empty.jsonl']);
    expect(store.lastSaved).toBe('2026-09-04T13:00:00.000Z');
  });
});

describe('importAction', () => {
  let stdoutData = '';
  let stderrData = '';
  let written: HistoricalDataStore | null = null;

  const makeCmd = (json = false, localOpts: Record<string, unknown> = {}) =>
    ({
      parent: { opts: () => ({ json, project: undefined }) },
      opts: () => localOpts,
    }) as unknown as import('commander').Command;

  beforeEach(() => {
    stdoutData = '';
    stderrData = '';
    written = null;
    chalk.level = 0;
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stdoutData += String(chunk);
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stderrData += String(chunk);
      return true;
    });
    process.exitCode = undefined;
    mockDetected.mockReset();
    mockDetected.mockReturnValue(['claude-code', 'codex']);
    mockResolveProvider.mockReset();
    mockReadHistory.mockReset();
    mockReadHistory.mockResolvedValue({
      ...createEmptyDataStore(),
      importedFiles: ['/s/old.jsonl'],
      sessions: [],
    });
    mockUpdateStore.mockReset();
    mockUpdateStore.mockImplementation(
      async (
        _path: string,
        empty: () => HistoricalDataStore,
        update: (s: HistoricalDataStore) => HistoricalDataStore,
      ) => {
        written = update(empty());
        return written;
      },
    );
    mockImport.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it('reads logs unlocked, then applies summaries in one locked write', async () => {
    mockImport.mockImplementation(
      async (options: {
        isImported: (id: string, path: string) => boolean;
        applySummary: (s: SessionSummary, path: string) => void;
        markImported: (path: string) => void;
      }) => {
        expect(options.isImported('x', '/s/old.jsonl')).toBe(true);
        options.applySummary(summary('fresh'), '/s/fresh.jsonl');
        options.markImported('/s/fresh.jsonl');
        options.markImported('/s/empty.jsonl');
        return {
          filesFound: 3,
          filesProcessed: 2,
          filesSkipped: 1,
          filesUnavailable: 1,
          sessionsImported: 1,
          messagesImported: 3,
          diagnostics: [],
        };
      },
    );

    await importAction({}, makeCmd());

    expect(mockImport).toHaveBeenCalledWith(
      expect.objectContaining({
        providers: [
          expect.objectContaining({ id: 'claude-code' }),
          expect.objectContaining({ id: 'codex' }),
        ],
      }),
    );
    expect(mockUpdateStore).toHaveBeenCalledWith(
      '/config/historical-data.json',
      expect.any(Function),
      expect.any(Function),
    );
    expect(written?.allTime.sessionCount).toBe(1);
    expect(written?.importedFiles).toEqual(['/s/fresh.jsonl', '/s/empty.jsonl']);
    expect(stdoutData).toContain('Imported 1 session (3 messages) from claude-code, codex');
    expect(stdoutData).toContain('1 already imported or still active');
    expect(stdoutData).toContain('1 without usage or unreadable');
    expect(stdoutData).toContain('Run "sidekick stats"');
  });

  it('prints JSON and skips the write when nothing is pending', async () => {
    mockImport.mockResolvedValue({
      filesFound: 2,
      filesProcessed: 0,
      filesSkipped: 2,
      filesUnavailable: 0,
      sessionsImported: 0,
      messagesImported: 0,
      diagnostics: [],
    });

    await importAction({}, makeCmd(true, { since: '7d' }));

    const parsed = JSON.parse(stdoutData);
    expect(parsed).toMatchObject({
      storePath: '/config/historical-data.json',
      providers: ['claude-code', 'codex'],
      filesSkipped: 2,
      sessionsImported: 0,
    });
    expect(parsed.since).toBeTruthy();
    expect(mockUpdateStore).not.toHaveBeenCalled();
  });

  it('rejects an unparseable --since before touching anything', async () => {
    await importAction({}, makeCmd(false, { since: 'lately' }));
    expect(stderrData).toContain('Invalid time');
    expect(process.exitCode).toBe(1);
    expect(mockImport).not.toHaveBeenCalled();
  });
});
