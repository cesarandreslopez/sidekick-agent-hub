import { beforeEach, describe, expect, it, vi } from 'vitest';

const executeWithTimeout = vi.hoisted(() => vi.fn());

vi.mock('vscode', () => ({
  languages: {
    createDiagnosticCollection: () => ({ clear: vi.fn(), set: vi.fn(), dispose: vi.fn() }),
  },
  workspace: { getConfiguration: () => ({ get: () => undefined }) },
}));
vi.mock('./Logger', () => ({ log: vi.fn(), logError: vi.fn() }));
vi.mock('./TimeoutManager', () => ({
  TimeoutManager: class {},
  getTimeoutManager: () => ({
    getTimeoutConfig: () => ({}),
    executeWithTimeout,
    promptRetry: vi.fn(),
  }),
}));

import { PreCommitReviewService } from './PreCommitReviewService';
import { ProviderRequestError } from '../utils/providerFailure';

const DIFF = [
  'diff --git a/src/a.ts b/src/a.ts',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1 +1 @@',
  '-const a = 1;',
  '+const a = 2;',
].join('\n');

/** Runs the task the way TimeoutManager does: a rejection comes back as `error`. */
async function runTask({ task }: { task: (signal: AbortSignal) => Promise<string> }) {
  try {
    return { success: true, result: await task(new AbortController().signal), timedOut: false };
  } catch (error) {
    return { success: false, error, timedOut: false, timeoutMs: 60_000 };
  }
}

function makeService(complete: () => Promise<string>) {
  const gitService = {
    getActiveRepository: () => ({ rootUri: { fsPath: '/tmp/repo' } }),
    getChangesForCommit: async () => ({ type: 'staged', diff: DIFF }),
  };
  const authService = {
    getProviderId: () => 'codex',
    getProviderDisplayName: () => 'Codex',
    complete: vi.fn(complete),
  };
  return new PreCommitReviewService(gitService as never, authService as never);
}

describe('PreCommitReviewService failure cause', () => {
  beforeEach(() => {
    executeWithTimeout.mockReset();
    executeWithTimeout.mockImplementation(runTask);
  });

  it('returns a provider failure as the cause with the unchanged message', async () => {
    const error = new ProviderRequestError({
      provider: 'codex',
      credentialKind: 'oauth',
      error: new Error('Codex error: turn failed', {
        cause: { message: 'turn failed', codexErrorInfo: 'serverOverloaded' },
      }),
    });

    const result = await makeService(() => Promise.reject(error)).reviewChanges();

    expect(result).toEqual({ issueCount: 0, error: error.message, cause: error });
  });

  it('sets no cause for timeouts or cancellation', async () => {
    executeWithTimeout.mockResolvedValueOnce({ success: false, timedOut: true, timeoutMs: 5000 });
    const timedOut = await makeService(() => Promise.resolve('')).reviewChanges();
    expect(timedOut.error).toMatch(/^Review timed out after 5000ms/);
    expect(timedOut).not.toHaveProperty('cause');

    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const cancelled = await makeService(() => Promise.reject(abort)).reviewChanges();
    expect(cancelled).toEqual({ issueCount: 0, error: 'Review cancelled' });
    expect(cancelled).not.toHaveProperty('cause');
  });
});
