import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { isNewer, type UpdateInfo } from './UpdateCheckService';

// ── isNewer (pure function, no mocks needed) ──

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
});

// ── UpdateCheckService (requires mocks) ──

// Mock __CLI_VERSION__ before importing the class
vi.stubGlobal('__CLI_VERSION__', '0.12.0');

// Mock fs
const mockExistsSync = vi.fn().mockReturnValue(false);
const mockReadFileSync = vi.fn().mockReturnValue('{}');
const mockWriteFileSync = vi.fn();
const mockMkdirSync = vi.fn();

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    existsSync: (...args: unknown[]) => mockExistsSync(...args),
    readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
    writeFileSync: (...args: unknown[]) => mockWriteFileSync(...args),
    mkdirSync: (...args: unknown[]) => mockMkdirSync(...args),
  };
});

// Mock sidekick-shared
vi.mock('sidekick-shared', () => ({
  getConfigDir: () => '/fake/config/sidekick',
}));

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import { UpdateCheckService } from './UpdateCheckService';

describe('UpdateCheckService', () => {
  let service: UpdateCheckService;
  let callback: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
    service = new UpdateCheckService();
    callback = vi.fn<(info: UpdateInfo | null) => void>();
    service.onResult(callback);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('emits UpdateInfo when a newer version is available', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ version: '0.13.0' }),
    });

    await service.check();

    expect(callback).toHaveBeenCalledWith({
      current: '0.12.0',
      latest: '0.13.0',
    });
  });

  it('emits null when current version matches latest', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ version: '0.12.0' }),
    });

    await service.check();

    expect(callback).toHaveBeenCalledWith(null);
  });

  it('emits null when current version is ahead of latest', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ version: '0.11.0' }),
    });

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

  it('uses cached result when cache is fresh (< 24h)', async () => {
    const freshCache = JSON.stringify({
      latest: '0.14.0',
      checkedAt: Date.now() - 1000, // 1 second ago
    });
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(freshCache);

    await service.check();

    expect(mockFetch).not.toHaveBeenCalled();
    expect(callback).toHaveBeenCalledWith({
      current: '0.12.0',
      latest: '0.14.0',
    });
  });

  it('fetches when cache is stale (> 24h)', async () => {
    const staleCache = JSON.stringify({
      latest: '0.13.0',
      checkedAt: Date.now() - 25 * 60 * 60 * 1000, // 25 hours ago
    });
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(staleCache);

    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ version: '0.14.0' }),
    });

    await service.check();

    expect(mockFetch).toHaveBeenCalled();
    expect(callback).toHaveBeenCalledWith({
      current: '0.12.0',
      latest: '0.14.0',
    });
  });

  it('writes cache after successful fetch', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ version: '0.13.0' }),
    });

    await service.check();

    expect(mockWriteFileSync).toHaveBeenCalledWith(
      '/fake/config/sidekick/update-check.json',
      expect.stringContaining('"latest":"0.13.0"'),
      'utf8',
    );
  });
});
