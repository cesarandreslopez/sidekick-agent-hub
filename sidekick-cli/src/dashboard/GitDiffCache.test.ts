import { beforeEach, describe, expect, it, vi } from 'vitest';

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }));
vi.mock('child_process', () => ({ execFile: execFileMock }));

import { GitDiffCache } from './GitDiffCache';

describe('GitDiffCache', () => {
  beforeEach(() => {
    execFileMock.mockReset();
  });

  it('returns immediately and refreshes numstat asynchronously with one in-flight request', () => {
    const callbacks: Array<(error: Error | null, output: string) => void> = [];
    execFileMock.mockImplementation(
      (
        _command: string,
        _args: string[],
        _options: unknown,
        callback: (error: Error | null, output: string) => void,
      ) => {
        callbacks.push(callback);
        return {};
      },
    );
    const cache = new GitDiffCache('/repo');
    expect(cache.getStats().size).toBe(0);
    expect(cache.getStats().size).toBe(0);
    expect(execFileMock).toHaveBeenCalledTimes(1);
    callbacks[0](null, '/repo\n');
    callbacks[1](null, '3\t1\tsrc/app.ts\n');
    expect(cache.getStats().get('src/app.ts')).toEqual({ additions: 3, deletions: 1 });
    expect(execFileMock).toHaveBeenCalledTimes(2);
    expect(cache.toRelative('/repo/src/app.ts')).toBe('src/app.ts');
  });
});
