import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockExistsSync = vi.hoisted(() => vi.fn());
const mockExecFileSync = vi.hoisted(() => vi.fn());

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return { ...actual, existsSync: (...args: unknown[]) => mockExistsSync(...args) };
});
vi.mock('child_process', () => ({
  execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
}));
vi.mock('../services/Logger', () => ({ log: vi.fn() }));

import { clearCliCache, findCli } from './cliPathResolver';

describe('cliPathResolver cache', () => {
  beforeEach(() => {
    clearCliCache();
    mockExistsSync.mockReset();
    mockExecFileSync.mockReset();
  });

  it('uses the current configured path rather than a prior setting', () => {
    mockExistsSync.mockImplementation((candidate) =>
      ['/opt/first/codex', '/opt/second/codex'].includes(String(candidate)),
    );

    expect(findCli({ binaryName: 'codex', configuredPath: '/opt/first/codex' })).toBe(
      '/opt/first/codex',
    );
    expect(findCli({ binaryName: 'codex', configuredPath: '/opt/second/codex' })).toBe(
      '/opt/second/codex',
    );
  });

  it('revalidates a cached executable before returning it', () => {
    const existing = new Set(['/opt/first/claude']);
    mockExistsSync.mockImplementation((candidate) => existing.has(String(candidate)));
    mockExecFileSync.mockReturnValue('/usr/local/bin/claude\n');

    expect(findCli({ binaryName: 'claude', configuredPath: '/opt/first/claude' })).toBe(
      '/opt/first/claude',
    );
    existing.clear();
    expect(findCli({ binaryName: 'claude', configuredPath: '/opt/first/claude' })).toBe(
      '/usr/local/bin/claude',
    );
  });
});
