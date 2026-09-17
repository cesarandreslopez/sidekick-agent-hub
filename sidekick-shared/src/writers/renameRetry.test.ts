import { afterEach, describe, expect, it, vi } from 'vitest';

const mockRenameSync = vi.hoisted(() => vi.fn());
const mockRename = vi.hoisted(() => vi.fn());

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    renameSync: (...args: unknown[]) => mockRenameSync(...args),
    promises: { ...actual.promises, rename: (...args: unknown[]) => mockRename(...args) },
  };
});

import { renameSyncWithRetry, renameWithRetry } from './atomic';

const originalPlatform = process.platform;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

describe('rename with retry', () => {
  afterEach(() => {
    setPlatform(originalPlatform);
    mockRenameSync.mockReset();
    mockRename.mockReset();
  });

  it('retries transient Windows sharing violations and gives up after the budget', async () => {
    setPlatform('win32');
    const eperm = Object.assign(new Error('EPERM'), { code: 'EPERM' });
    let attempts = 0;
    mockRenameSync.mockImplementation(() => {
      attempts++;
      if (attempts < 3) throw eperm;
    });
    renameSyncWithRetry('a', 'b');
    expect(attempts).toBe(3);

    mockRename.mockRejectedValue(eperm);
    await expect(renameWithRetry('a', 'b')).rejects.toBe(eperm);
    expect(mockRename).toHaveBeenCalledTimes(10);
  }, 20_000);

  it('does not retry on other platforms or other errors', async () => {
    setPlatform('linux');
    const eperm = Object.assign(new Error('EPERM'), { code: 'EPERM' });
    mockRenameSync.mockImplementation(() => {
      throw eperm;
    });
    expect(() => renameSyncWithRetry('a', 'b')).toThrow(eperm);
    expect(mockRenameSync).toHaveBeenCalledTimes(1);

    setPlatform('win32');
    const enoent = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    mockRename.mockRejectedValue(enoent);
    await expect(renameWithRetry('a', 'b')).rejects.toBe(enoent);
    expect(mockRename).toHaveBeenCalledTimes(1);
  });
});
