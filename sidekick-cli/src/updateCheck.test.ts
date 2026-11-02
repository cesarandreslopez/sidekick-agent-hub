import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { stripVTControlCharacters } from 'util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const configDir = vi.hoisted(() => ({ value: '' }));
vi.mock('sidekick-shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('sidekick-shared')>()),
  getConfigDir: () => configDir.value,
}));

// UpdateCheckService reads the build-time version; vitest's `define` exposes
// it as a global, so it can be stubbed per file.
vi.stubGlobal('__CLI_VERSION__', '0.12.0');
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import {
  UPDATE_CHECK_CACHE_FILE,
  UPDATE_CHECK_TTL_MS,
  UPDATE_NOTICE_INTERVAL_MS,
  UpdateCheckService,
  formatUpdateNotice,
  isNewer,
  readUpdateCache,
  resolveLatestVersion,
  shouldRunUpdateNotice,
  startUpdateNotice,
  type UpdateCheckCache,
  type UpdateInfo,
  type UpdateNoticeContext,
} from './updateCheck';

const HOUR = 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 2, 12, 0, 0);

function cachePath(): string {
  return path.join(configDir.value, UPDATE_CHECK_CACHE_FILE);
}

function seedCache(cache: Partial<UpdateCheckCache> & Record<string, unknown>): void {
  fs.writeFileSync(cachePath(), JSON.stringify(cache), 'utf8');
}

function readCacheFile(): UpdateCheckCache {
  return JSON.parse(fs.readFileSync(cachePath(), 'utf8')) as UpdateCheckCache;
}

beforeEach(() => {
  configDir.value = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-update-check-'));
  mockFetch.mockReset();
});

afterEach(() => {
  fs.rmSync(configDir.value, { recursive: true, force: true });
});

// ── isNewer ──

describe('isNewer', () => {
  it('returns true when a > b (patch)', () => {
    expect(isNewer('1.0.1', '1.0.0')).toBe(true);
  });

  it('returns true when a > b (minor)', () => {
    expect(isNewer('1.2.0', '1.1.9')).toBe(true);
  });

  it('returns true when a > b (major)', () => {
    expect(isNewer('2.0.0', '1.9.9')).toBe(true);
  });

  it('returns false when equal', () => {
    expect(isNewer('1.0.0', '1.0.0')).toBe(false);
  });

  it('returns false when a < b', () => {
    expect(isNewer('1.0.0', '1.0.1')).toBe(false);
  });

  it('compares numerically, not lexically', () => {
    expect(isNewer('0.30.0', '0.9.9')).toBe(true);
  });

  it('ranks a release above its own pre-release', () => {
    expect(isNewer('0.31.0', '0.31.0-beta.1')).toBe(true);
    expect(isNewer('0.31.0-beta.1', '0.31.0')).toBe(false);
  });

  it('ignores a pre-release suffix when the cores differ', () => {
    expect(isNewer('0.31.0', '0.0.0-test')).toBe(true);
    expect(isNewer('0.30.0', '0.31.0-beta.1')).toBe(false);
  });
});

// ── cache ──

describe('readUpdateCache', () => {
  it('reads a pre-0.30.1 cache that has only latest and checkedAt', () => {
    seedCache({ latest: '0.30.0', checkedAt: NOW });
    expect(readUpdateCache()).toEqual({ latest: '0.30.0', checkedAt: NOW });
  });

  it('treats a corrupt file as absent', () => {
    fs.writeFileSync(cachePath(), '{not json', 'utf8');
    expect(readUpdateCache()).toBeNull();
  });

  it('drops a latest that is not a version', () => {
    seedCache({ latest: '<html>', checkedAt: NOW });
    expect(readUpdateCache()).toEqual({ checkedAt: NOW });
  });
});

// ── resolveLatestVersion ──

describe('resolveLatestVersion', () => {
  it('answers from a fresh cache without fetching', async () => {
    seedCache({ latest: '0.14.0', checkedAt: NOW - HOUR });
    const fetchLatest = vi.fn();

    const result = await resolveLatestVersion({
      allowFetch: true,
      timeoutMs: 1000,
      now: () => NOW,
      fetchLatest,
    });

    expect(fetchLatest).not.toHaveBeenCalled();
    expect(result.latest).toBe('0.14.0');
  });

  it('fetches when the cache is stale and writes the answer', async () => {
    seedCache({ latest: '0.13.0', checkedAt: NOW - UPDATE_CHECK_TTL_MS - 1 });

    const result = await resolveLatestVersion({
      allowFetch: true,
      timeoutMs: 1000,
      now: () => NOW,
      fetchLatest: async () => '0.14.0',
    });

    expect(result.latest).toBe('0.14.0');
    expect(readCacheFile()).toMatchObject({ latest: '0.14.0', checkedAt: NOW });
  });

  it('never fetches when fetching is not allowed, however old the cache', async () => {
    seedCache({ latest: '0.13.0', checkedAt: NOW - 30 * 24 * HOUR });
    const fetchLatest = vi.fn();

    const result = await resolveLatestVersion({
      allowFetch: false,
      timeoutMs: 1000,
      now: () => NOW,
      fetchLatest,
    });

    expect(fetchLatest).not.toHaveBeenCalled();
    expect(result.latest).toBe('0.13.0');
  });

  it('stamps a failed fetch and keeps the last known version', async () => {
    seedCache({ latest: '0.13.0', checkedAt: NOW - UPDATE_CHECK_TTL_MS - 1, notifiedAt: 5 });

    const result = await resolveLatestVersion({
      allowFetch: true,
      timeoutMs: 1000,
      now: () => NOW,
      fetchLatest: async () => {
        throw new Error('offline');
      },
    });

    expect(result.latest).toBe('0.13.0');
    expect(readCacheFile()).toEqual({ latest: '0.13.0', checkedAt: NOW, notifiedAt: 5 });
  });

  it('backs off after a failure instead of retrying on the next run', async () => {
    const fetchLatest = vi.fn(async () => {
      throw new Error('offline');
    });
    await resolveLatestVersion({ allowFetch: true, timeoutMs: 1000, now: () => NOW, fetchLatest });
    await resolveLatestVersion({
      allowFetch: true,
      timeoutMs: 1000,
      now: () => NOW + HOUR,
      fetchLatest,
    });

    expect(fetchLatest).toHaveBeenCalledTimes(1);
  });

  it('refetches when the cached check is in the future (clock moved back)', async () => {
    seedCache({ latest: '0.13.0', checkedAt: NOW + 10 * HOUR });
    const fetchLatest = vi.fn(async () => '0.14.0');

    const result = await resolveLatestVersion({
      allowFetch: true,
      timeoutMs: 1000,
      now: () => NOW,
      fetchLatest,
    });

    expect(fetchLatest).toHaveBeenCalledTimes(1);
    expect(result.latest).toBe('0.14.0');
  });

  it('passes an abort signal that fires after the timeout', async () => {
    const result = await resolveLatestVersion({
      allowFetch: true,
      timeoutMs: 20,
      now: () => NOW,
      fetchLatest: (signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason));
        }),
    });

    expect(result.latest).toBeNull();
    expect(readCacheFile()).toEqual({ checkedAt: NOW });
  });
});

// ── shouldRunUpdateNotice ──

describe('shouldRunUpdateNotice', () => {
  const base: UpdateNoticeContext = {
    commandToken: 'quota',
    json: false,
    env: {},
    stdoutIsTTY: true,
    stderrIsTTY: true,
  };

  it('runs for an interactive command', () => {
    expect(shouldRunUpdateNotice(base)).toBe(true);
  });

  it.each(['statusline', 'mcp', 'dashboard'])('skips %s', (commandToken) => {
    expect(shouldRunUpdateNotice({ ...base, commandToken })).toBe(false);
  });

  it('skips a bare or flag-only invocation', () => {
    expect(shouldRunUpdateNotice({ ...base, commandToken: undefined })).toBe(false);
    expect(shouldRunUpdateNotice({ ...base, commandToken: '--version' })).toBe(false);
  });

  it('skips --json output', () => {
    expect(shouldRunUpdateNotice({ ...base, json: true })).toBe(false);
  });

  it('skips piped stdout or stderr', () => {
    expect(shouldRunUpdateNotice({ ...base, stdoutIsTTY: false })).toBe(false);
    expect(shouldRunUpdateNotice({ ...base, stderrIsTTY: false })).toBe(false);
  });

  it.each([
    [{ CI: 'true' }, false],
    [{ CI: '1' }, false],
    [{ CI: 'false' }, true],
    [{ SIDEKICK_NO_UPDATE_NOTIFIER: '1' }, false],
    [{ SIDEKICK_NO_UPDATE_NOTIFIER: '0' }, true],
    [{ NO_UPDATE_NOTIFIER: '1' }, false],
  ])('honors env %o', (env, expected) => {
    expect(shouldRunUpdateNotice({ ...base, env })).toBe(expected);
  });
});

// ── startUpdateNotice ──

describe('startUpdateNotice', () => {
  function notice(now = NOW, fetchLatest?: (signal: AbortSignal) => Promise<string>) {
    return startUpdateNotice({
      allowFetch: true,
      current: '0.30.0',
      now: () => now,
      fetchLatest: fetchLatest ?? (async () => '0.30.1'),
    }).finish();
  }

  it('returns the notice when a newer version exists and records it', async () => {
    const text = await notice();

    expect(text).not.toBeNull();
    const plain = stripVTControlCharacters(text ?? '');
    expect(plain).toContain('Update available: sidekick 0.30.0 → 0.30.1');
    expect(plain).toContain('npm install -g sidekick-agent-hub');
    expect(plain).toContain('releases/tag/v0.30.1');
    expect(readCacheFile()).toMatchObject({ notifiedAt: NOW, notifiedVersion: '0.30.1' });
  });

  it('stays quiet when already on the latest version', async () => {
    expect(await notice(NOW, async () => '0.30.0')).toBeNull();
  });

  it('stays quiet when nothing is known yet and fetching is not allowed', async () => {
    const text = await startUpdateNotice({
      allowFetch: false,
      current: '0.30.0',
      now: () => NOW,
    }).finish();

    expect(text).toBeNull();
    expect(fs.existsSync(cachePath())).toBe(false);
  });

  it('shows the same version at most twice a day', async () => {
    expect(await notice(NOW)).not.toBeNull();
    expect(await notice(NOW + HOUR)).toBeNull();
    expect(await notice(NOW + UPDATE_NOTICE_INTERVAL_MS - 1)).toBeNull();
    expect(await notice(NOW + UPDATE_NOTICE_INTERVAL_MS)).not.toBeNull();
  });

  it('announces a newer release right away even inside the interval', async () => {
    seedCache({
      latest: '0.30.2',
      checkedAt: NOW,
      notifiedAt: NOW - HOUR,
      notifiedVersion: '0.30.1',
    });

    const text = await notice(NOW);

    expect(stripVTControlCharacters(text ?? '')).toContain('0.30.0 → 0.30.2');
  });

  it('shows the cached answer without fetching for cache-only runs', async () => {
    seedCache({ latest: '0.30.1', checkedAt: NOW - 10 * 24 * HOUR });
    const fetchLatest = vi.fn();

    const text = await startUpdateNotice({
      allowFetch: false,
      current: '0.30.0',
      now: () => NOW,
      fetchLatest,
    }).finish();

    expect(fetchLatest).not.toHaveBeenCalled();
    expect(text).not.toBeNull();
  });

  it('resolves null when the registry does not answer in time', async () => {
    const text = await startUpdateNotice({
      allowFetch: true,
      current: '0.30.0',
      timeoutMs: 20,
      now: () => NOW,
      fetchLatest: (signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason));
        }),
    }).finish();

    expect(text).toBeNull();
  });
});

describe('formatUpdateNotice', () => {
  it('starts with a blank line and ends with a newline', () => {
    const plain = stripVTControlCharacters(formatUpdateNotice('0.30.0', '0.30.1'));
    expect(plain.startsWith('\n')).toBe(true);
    expect(plain.endsWith('\n')).toBe(true);
    expect(plain.split('\n')).toHaveLength(4);
  });
});

// ── UpdateCheckService (dashboard) ──

describe('UpdateCheckService', () => {
  let service: UpdateCheckService;
  let callback: ReturnType<typeof vi.fn<(info: UpdateInfo | null) => void>>;

  beforeEach(() => {
    service = new UpdateCheckService();
    callback = vi.fn<(info: UpdateInfo | null) => void>();
    service.onResult(callback);
  });

  it('emits UpdateInfo when a newer version is available', async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ version: '0.13.0' }) });

    await service.check();

    expect(callback).toHaveBeenCalledWith({ current: '0.12.0', latest: '0.13.0' });
  });

  it('emits null when current version matches latest', async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ version: '0.12.0' }) });

    await service.check();

    expect(callback).toHaveBeenCalledWith(null);
  });

  it('emits null when current version is ahead of latest', async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ version: '0.11.0' }) });

    await service.check();

    expect(callback).toHaveBeenCalledWith(null);
  });

  it('emits null on network failure (no crash)', async () => {
    mockFetch.mockRejectedValue(new Error('Network error'));

    await service.check();

    expect(callback).toHaveBeenCalledWith(null);
  });

  it('emits null on non-ok response', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 500 });

    await service.check();

    expect(callback).toHaveBeenCalledWith(null);
  });

  it('uses the cached result when the cache is fresh', async () => {
    seedCache({ latest: '0.14.0', checkedAt: Date.now() - 1000 });

    await service.check();

    expect(mockFetch).not.toHaveBeenCalled();
    expect(callback).toHaveBeenCalledWith({ current: '0.12.0', latest: '0.14.0' });
  });

  it('fetches when the cache is stale and writes the answer', async () => {
    seedCache({ latest: '0.13.0', checkedAt: Date.now() - UPDATE_CHECK_TTL_MS - HOUR });
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ version: '0.14.0' }) });

    await service.check();

    expect(mockFetch).toHaveBeenCalledWith(
      'https://registry.npmjs.org/sidekick-agent-hub/latest',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(callback).toHaveBeenCalledWith({ current: '0.12.0', latest: '0.14.0' });
    expect(readCacheFile().latest).toBe('0.14.0');
  });
});
