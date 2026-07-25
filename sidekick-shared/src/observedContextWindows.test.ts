import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  _clearObservedContextWindowWriteCache,
  loadObservedContextWindows,
  recordObservedContextWindow,
  getObservedContextWindowPath,
} from './observedContextWindows';
import {
  _clearObservedContextWindows,
  _clearCatalogContextWindows,
  _getObservedContextWindows,
  _setCatalogContextWindows,
  getModelContextWindowSize,
} from './modelContext';

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'sidekick-observed-'));
}

async function readStore(cacheDir: string): Promise<Record<string, unknown>> {
  const raw = await fs.readFile(getObservedContextWindowPath(cacheDir), 'utf8');
  return JSON.parse(raw);
}

describe('observedContextWindows', () => {
  let cacheDir: string;

  beforeEach(async () => {
    cacheDir = await makeTempDir();
    _clearObservedContextWindows();
    _clearCatalogContextWindows();
    _clearObservedContextWindowWriteCache();
  });

  afterEach(async () => {
    _clearObservedContextWindows();
    _clearCatalogContextWindows();
    _clearObservedContextWindowWriteCache();
    await fs.rm(cacheDir, { recursive: true, force: true });
  });

  it('records, persists, and reloads an observed window', async () => {
    await recordObservedContextWindow('gpt-5.6-sol', 258_400, { cacheDir });

    // In memory immediately.
    expect(getModelContextWindowSize('gpt-5.6-sol')).toBe(258_400);

    const store = (await readStore(cacheDir)) as {
      version: number;
      models: Record<string, { contextWindow: number; observedAt: string }>;
    };
    expect(store.version).toBe(1);
    expect(store.models['gpt-5.6-sol'].contextWindow).toBe(258_400);
    expect(typeof store.models['gpt-5.6-sol'].observedAt).toBe('string');

    // Survives a fresh process.
    _clearObservedContextWindows();
    expect(getModelContextWindowSize('gpt-5.6-sol')).toBe(1_050_000);
    const loaded = await loadObservedContextWindows({ cacheDir });
    expect(loaded['gpt-5.6-sol']).toBe(258_400);
    expect(getModelContextWindowSize('gpt-5.6-sol')).toBe(258_400);
  });

  it('outranks the catalog once loaded', async () => {
    _setCatalogContextWindows({ 'gpt-5.6-sol': 1_050_000 });
    expect(getModelContextWindowSize('gpt-5.6-sol')).toBe(1_050_000);

    await recordObservedContextWindow('gpt-5.6-sol', 258_400, { cacheDir });
    expect(getModelContextWindowSize('gpt-5.6-sol')).toBe(258_400);
  });

  it('does not rewrite the store when the value is unchanged', async () => {
    // Codex reports a window on every token_count event; an unconditional
    // write would mean constant disk I/O for a value that rarely moves.
    await recordObservedContextWindow('gpt-5.6-sol', 258_400, { cacheDir });
    const first = await fs.stat(getObservedContextWindowPath(cacheDir));

    await recordObservedContextWindow('gpt-5.6-sol', 258_400, { cacheDir });
    const second = await fs.stat(getObservedContextWindowPath(cacheDir));

    expect(second.mtimeMs).toBe(first.mtimeMs);
  });

  it('updates the store when the value changes', async () => {
    await recordObservedContextWindow('gpt-5.6-sol', 258_400, { cacheDir });
    await recordObservedContextWindow('gpt-5.6-sol', 353_400, { cacheDir });

    const store = (await readStore(cacheDir)) as {
      models: Record<string, { contextWindow: number }>;
    };
    expect(store.models['gpt-5.6-sol'].contextWindow).toBe(353_400);
    expect(getModelContextWindowSize('gpt-5.6-sol')).toBe(353_400);
  });

  it('merges concurrent writers instead of clobbering', async () => {
    // The CLI and the extension host can both be observing sessions at once.
    await Promise.all([
      recordObservedContextWindow('gpt-5.6-sol', 258_400, { cacheDir }),
      recordObservedContextWindow('gpt-5.6-terra', 353_400, { cacheDir }),
      recordObservedContextWindow('gpt-5.5', 258_400, { cacheDir }),
    ]);

    const store = (await readStore(cacheDir)) as {
      models: Record<string, { contextWindow: number }>;
    };
    expect(Object.keys(store.models).sort()).toEqual(['gpt-5.5', 'gpt-5.6-sol', 'gpt-5.6-terra']);
  });

  it('normalizes model ids to lowercase', async () => {
    await recordObservedContextWindow('  GPT-5.6-Sol  ', 258_400, { cacheDir });
    expect(_getObservedContextWindows()['gpt-5.6-sol']).toBe(258_400);
    expect(getModelContextWindowSize('gpt-5.6-sol')).toBe(258_400);
  });

  it('ignores empty ids and non-positive windows', async () => {
    await recordObservedContextWindow('', 258_400, { cacheDir });
    await recordObservedContextWindow('gpt-5.6-sol', 0, { cacheDir });
    await recordObservedContextWindow('gpt-5.6-sol', Number.NaN, { cacheDir });

    expect(_getObservedContextWindows()).toEqual({});
    await expect(fs.stat(getObservedContextWindowPath(cacheDir))).rejects.toThrow();
  });

  it('returns an empty map when no store exists', async () => {
    expect(await loadObservedContextWindows({ cacheDir })).toEqual({});
  });

  it('tolerates a malformed store', async () => {
    await fs.writeFile(getObservedContextWindowPath(cacheDir), '{ not json', 'utf8');
    expect(await loadObservedContextWindows({ cacheDir })).toEqual({});
  });

  it('writes every store when two cache dirs are used in one process', async () => {
    // The in-memory override table is process-global, so it cannot double as
    // the write dedupe: keyed on it, the second store would never be written.
    const otherDir = await makeTempDir();
    try {
      await recordObservedContextWindow('gpt-5.6-sol', 258_400, { cacheDir });
      await recordObservedContextWindow('gpt-5.6-sol', 258_400, { cacheDir: otherDir });

      const first = (await readStore(cacheDir)) as {
        models: Record<string, { contextWindow: number }>;
      };
      const second = (await readStore(otherDir)) as {
        models: Record<string, { contextWindow: number }>;
      };
      expect(first.models['gpt-5.6-sol'].contextWindow).toBe(258_400);
      expect(second.models['gpt-5.6-sol'].contextWindow).toBe(258_400);
    } finally {
      await fs.rm(otherDir, { recursive: true, force: true });
    }
  });

  it('retries the write after a persistence failure', async () => {
    // The dedupe records only on success, so a transient EACCES must not
    // convince later calls that the value is already on disk.
    await fs.chmod(cacheDir, 0o500);
    try {
      await recordObservedContextWindow('gpt-5.6-sol', 258_400, { cacheDir });
      await expect(fs.stat(getObservedContextWindowPath(cacheDir))).rejects.toThrow();
    } finally {
      await fs.chmod(cacheDir, 0o700);
    }

    await recordObservedContextWindow('gpt-5.6-sol', 258_400, { cacheDir });

    const store = (await readStore(cacheDir)) as {
      models: Record<string, { contextWindow: number }>;
    };
    expect(store.models['gpt-5.6-sol'].contextWindow).toBe(258_400);
  });

  it('drops malformed entries but keeps valid ones', async () => {
    await fs.writeFile(
      getObservedContextWindowPath(cacheDir),
      JSON.stringify({
        version: 1,
        models: {
          'gpt-5.6-sol': { contextWindow: 258_400, observedAt: 'x' },
          'bad-zero': { contextWindow: 0, observedAt: 'x' },
          'bad-type': { contextWindow: 'lots', observedAt: 'x' },
          'bad-shape': null,
        },
      }),
      'utf8',
    );

    expect(await loadObservedContextWindows({ cacheDir })).toEqual({ 'gpt-5.6-sol': 258_400 });
  });
});
