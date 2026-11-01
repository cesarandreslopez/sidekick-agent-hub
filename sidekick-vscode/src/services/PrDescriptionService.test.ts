import { beforeEach, describe, expect, it, vi } from 'vitest';

const executeWithTimeout = vi.hoisted(() => vi.fn());

vi.mock('vscode', () => ({
  workspace: { getConfiguration: vi.fn(() => ({ get: () => undefined })) },
  window: { showInputBox: vi.fn() },
}));
vi.mock('./Logger', () => ({ log: vi.fn(), logError: vi.fn() }));
vi.mock('./TimeoutManager', () => ({
  getTimeoutManager: () => ({
    getTimeoutConfig: () => ({}),
    executeWithTimeout,
    promptRetry: vi.fn(),
  }),
}));

import { PrDescriptionService } from './PrDescriptionService';
import { ProviderRequestError } from '../utils/providerFailure';

/** Runs the task the way TimeoutManager does: a rejection comes back as `error`. */
async function runTask({ task }: { task: (signal: AbortSignal) => Promise<string> }) {
  try {
    return { success: true, result: await task(new AbortController().signal), timedOut: false };
  } catch (error) {
    return { success: false, error, timedOut: false, timeoutMs: 60_000 };
  }
}

function makeFailingService(error: unknown) {
  const repository = { rootUri: { fsPath: '/tmp/repo' } };
  const gitService = {
    getActiveRepository: vi.fn(() => repository),
    execGit: vi.fn(async () => 'origin/main\n'),
    getBranchCommits: vi.fn(async () => ['feat: add a']),
    getBranchDiff: vi.fn(async () => 'diff --git a/src/a.ts b/src/a.ts\n+const a = 2;'),
  };
  const authService = {
    getProviderId: () => 'codex',
    getProviderDisplayName: () => 'Codex',
    complete: vi.fn(() => Promise.reject(error)),
  };
  const service = new PrDescriptionService(gitService as never, authService as never);
  return { service, gitService, repository };
}

describe('PrDescriptionService', () => {
  it('preserves a slashed upstream branch as the comparison ref', async () => {
    const repository = { rootUri: { fsPath: '/tmp/repo' } };
    const gitService = {
      getActiveRepository: vi.fn(() => repository),
      execGit: vi.fn(async () => 'origin/feature/foo\n'),
      getBranchCommits: vi.fn(async () => []),
    };
    const service = new PrDescriptionService(gitService as never, {} as never);

    await service.generatePrDescription();

    expect(gitService.getBranchCommits).toHaveBeenCalledWith(repository, 'origin/feature/foo');
  });
});

describe('PrDescriptionService failure cause', () => {
  const overloaded = () =>
    new ProviderRequestError({
      provider: 'codex',
      credentialKind: 'oauth',
      error: new Error('Codex error: turn failed', {
        cause: { message: 'turn failed', codexErrorInfo: 'serverOverloaded' },
      }),
    });

  beforeEach(() => {
    executeWithTimeout.mockReset();
    executeWithTimeout.mockImplementation(runTask);
  });

  it('returns a provider failure as the cause with the base branch used', async () => {
    const error = overloaded();
    const { service } = makeFailingService(error);

    const result = await service.generatePrDescription();

    expect(result).toEqual({
      description: null,
      error: error.message,
      cause: error,
      baseBranch: 'origin/main',
    });
  });

  it('compares against a given base branch without detecting one', async () => {
    const { service, gitService, repository } = makeFailingService(overloaded());

    const result = await service.generatePrDescription('develop');

    expect(gitService.execGit).not.toHaveBeenCalled();
    expect(gitService.getBranchCommits).toHaveBeenCalledWith(repository, 'develop');
    expect(result.baseBranch).toBe('develop');
  });

  it('sets no cause for a timeout or cancellation', async () => {
    executeWithTimeout.mockResolvedValueOnce({ success: false, timedOut: true, timeoutMs: 5000 });
    const timedOut = await makeFailingService(overloaded()).service.generatePrDescription();
    expect(timedOut.error).toMatch(/^Request timed out after 5000ms/);
    expect(timedOut).not.toHaveProperty('cause');

    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const cancelled = await makeFailingService(abort).service.generatePrDescription();
    expect(cancelled).toEqual({ description: null, error: 'Request cancelled' });
    expect(cancelled).not.toHaveProperty('cause');
  });
});
