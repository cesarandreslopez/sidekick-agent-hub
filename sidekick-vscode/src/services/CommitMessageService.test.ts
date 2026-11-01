import { beforeEach, describe, expect, it, vi } from 'vitest';

const executeWithTimeout = vi.hoisted(() => vi.fn());

vi.mock('vscode', () => ({
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

import { CommitMessageService } from './CommitMessageService';
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

const overloaded = () =>
  new ProviderRequestError({
    provider: 'codex',
    credentialKind: 'oauth',
    error: new Error('Codex error: turn failed', {
      cause: { message: 'turn failed', codexErrorInfo: 'serverOverloaded' },
    }),
  });

function makeService(
  complete: () => Promise<string>,
  getChangesForCommit: () => Promise<unknown> = async () => ({ type: 'staged', diff: DIFF }),
) {
  const gitService = { getChangesForCommit };
  const authService = {
    getProviderId: () => 'codex',
    getProviderDisplayName: () => 'Codex',
    complete: vi.fn(complete),
  };
  return new CommitMessageService(gitService as never, authService as never);
}

describe('CommitMessageService failure cause', () => {
  beforeEach(() => {
    executeWithTimeout.mockReset();
    executeWithTimeout.mockImplementation(runTask);
  });

  it('returns a provider failure as the cause with the unchanged message', async () => {
    const error = overloaded();
    const result = await makeService(() => Promise.reject(error)).generateCommitMessage();

    expect(result).toEqual({ message: null, error: error.message, cause: error });
  });

  it('returns a thrown error as the cause', async () => {
    const error = new Error('git exploded');
    const service = makeService(
      () => Promise.resolve('feat: x'),
      () => Promise.reject(error),
    );

    const result = await service.generateCommitMessage();

    expect(result).toEqual({ message: null, error: 'git exploded', cause: error });
  });

  it('sets no cause for no changes, timeouts, or cancellation', async () => {
    const none = await makeService(
      () => Promise.resolve(''),
      async () => null,
    ).generateCommitMessage();
    expect(none.cause).toBeUndefined();

    executeWithTimeout.mockResolvedValueOnce({ success: false, timedOut: true, timeoutMs: 5000 });
    const timedOut = await makeService(() => Promise.resolve('')).generateCommitMessage();
    expect(timedOut.error).toMatch(/^Request timed out after 5000ms/);
    expect(timedOut).not.toHaveProperty('cause');

    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const cancelled = await makeService(() => Promise.reject(abort)).generateCommitMessage();
    expect(cancelled).toEqual({ message: null });
    expect(cancelled).not.toHaveProperty('cause');
  });
});
