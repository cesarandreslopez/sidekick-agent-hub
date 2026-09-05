import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockImport, mockCreateProviders } = vi.hoisted(() => ({
  mockImport: vi.fn(),
  mockCreateProviders: vi.fn(),
}));

vi.mock('vscode', () => ({}));
vi.mock('./Logger', () => ({ log: vi.fn(), logError: vi.fn() }));
vi.mock('sidekick-shared', async () => {
  const actual = await vi.importActual<typeof import('sidekick-shared')>('sidekick-shared');
  return {
    ...actual,
    importSessionHistory: (...args: unknown[]) => mockImport(...args),
    createSessionProviders: (...args: unknown[]) => mockCreateProviders(...args),
  };
});

import { RetroactiveDataLoader } from './RetroactiveDataLoader';

type ImportOptions = {
  providers: unknown[];
  isImported: (sessionId: string, filePath: string) => boolean;
  applySummary: (summary: { sessionId: string }, filePath: string) => void;
  markImported: (filePath: string) => void;
  onProgress?: (loaded: number, total: number) => void;
};

function historicalStub() {
  return {
    getImportedFiles: vi.fn(() => ['/sessions/imported.jsonl']),
    getSessionRecords: vi.fn(() => [{ sessionId: 'saved-session' }]),
    saveSessionSummary: vi.fn(),
    markFileImported: vi.fn(),
    forceSave: vi.fn(async () => undefined),
  };
}

describe('RetroactiveDataLoader', () => {
  beforeEach(() => {
    mockImport.mockReset();
    mockCreateProviders.mockReset();
  });

  it('imports through the shared importer with every provider and folds results into the store', async () => {
    const dispose = vi.fn();
    mockCreateProviders.mockReturnValue({
      providers: [
        { id: 'claude-code', dispose },
        { id: 'codex', dispose },
      ],
      diagnostics: [],
    });
    const historical = historicalStub();
    mockImport.mockImplementation(async (options: ImportOptions) => {
      // Already-imported files and live-saved session ids are skipped before any read.
      expect(options.isImported('anything', '/sessions/imported.jsonl')).toBe(true);
      expect(options.isImported('saved-session', '/sessions/other.jsonl')).toBe(true);
      expect(options.isImported('fresh', '/sessions/fresh.jsonl')).toBe(false);

      options.applySummary({ sessionId: 'fresh' }, '/sessions/fresh.jsonl');
      options.markImported('/sessions/fresh.jsonl');
      options.markImported('/sessions/empty.jsonl');
      // A session credited during this run is not credited twice.
      expect(options.isImported('fresh', '/sessions/again.jsonl')).toBe(true);
      options.onProgress?.(3, 3);
      return {
        filesFound: 3,
        filesProcessed: 2,
        filesSkipped: 1,
        filesUnavailable: 1,
        sessionsImported: 1,
        messagesImported: 12,
        diagnostics: [],
      };
    });
    const loader = new RetroactiveDataLoader(historical as never);
    const progress = vi.fn();

    const result = await loader.loadHistoricalData(progress);

    expect(mockImport).toHaveBeenCalledWith(
      expect.objectContaining({
        providers: [
          expect.objectContaining({ id: 'claude-code' }),
          expect.objectContaining({ id: 'codex' }),
        ],
      }),
    );
    expect(historical.saveSessionSummary).toHaveBeenCalledWith({ sessionId: 'fresh' });
    expect(historical.markFileImported).toHaveBeenCalledTimes(2);
    expect(historical.forceSave).toHaveBeenCalledOnce();
    expect(progress).toHaveBeenCalledWith(3, 3);
    expect(result).toEqual({
      filesProcessed: 2,
      recordsFound: 12,
      recordsImported: 12,
      sessionsCreated: 1,
      filesSkipped: 1,
    });
    // Providers the loader created are disposed once the import ends.
    expect(dispose).toHaveBeenCalledTimes(2);
  });

  it('uses caller-supplied providers without disposing them', async () => {
    const provider = { id: 'claude-code', dispose: vi.fn() };
    mockImport.mockResolvedValue({
      filesFound: 0,
      filesProcessed: 0,
      filesSkipped: 0,
      filesUnavailable: 0,
      sessionsImported: 0,
      messagesImported: 0,
      diagnostics: [],
    });
    const historical = historicalStub();
    const loader = new RetroactiveDataLoader(historical as never, [provider as never]);

    const result = await loader.loadHistoricalData();

    expect(mockCreateProviders).not.toHaveBeenCalled();
    expect(mockImport).toHaveBeenCalledWith(expect.objectContaining({ providers: [provider] }));
    expect(provider.dispose).not.toHaveBeenCalled();
    expect(historical.forceSave).not.toHaveBeenCalled();
    expect(result.sessionsCreated).toBe(0);
  });
});
