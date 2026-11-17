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

import * as vscode from 'vscode';
import { PrDescriptionService, githubCompareUrl } from './PrDescriptionService';
import { ProviderRequestError } from '../utils/providerFailure';

type GitAnswers = Record<string, string | Error>;

/**
 * An execGit mock that answers per command (keyed by the args joined with
 * spaces), and fails like git does for anything not listed.
 */
function gitMock(answers: GitAnswers) {
  return vi.fn(async (_repo: string, args: string[]) => {
    const answer = answers[args.join(' ')];
    if (answer === undefined || answer instanceof Error) {
      throw answer ?? new Error(`fatal: ${args.join(' ')}`);
    }
    return answer;
  });
}

const UPSTREAM = 'rev-parse --abbrev-ref @{u}';
const HEAD = 'rev-parse --abbrev-ref HEAD';
const ORIGIN_HEAD = 'symbolic-ref --short refs/remotes/origin/HEAD';
const verify = (ref: string) => `rev-parse --verify --quiet ${ref}`;

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
    // A local branch tracking origin/main: the upstream names another branch.
    execGit: gitMock({ [UPSTREAM]: 'origin/main\n', [HEAD]: 'fix-login\n' }),
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

describe('PrDescriptionService base branch', () => {
  const repository = { rootUri: { fsPath: '/tmp/repo' } };

  function serviceWith(answers: GitAnswers) {
    const gitService = {
      getActiveRepository: vi.fn(() => repository),
      execGit: gitMock(answers),
      getBranchCommits: vi.fn(async () => []),
    };
    return { service: new PrDescriptionService(gitService as never, {} as never), gitService };
  }

  it('does not compare a pushed branch with its own upstream', async () => {
    const { service, gitService } = serviceWith({
      [UPSTREAM]: 'origin/feat/x\n',
      [HEAD]: 'feat/x\n',
      [ORIGIN_HEAD]: 'origin/main\n',
      [verify('origin/main')]: 'abc123\n',
    });

    await service.generatePrDescription();

    expect(gitService.getBranchCommits).toHaveBeenCalledWith(repository, 'origin/main');
  });

  it('keeps an upstream that tracks a different branch, slashes and all', async () => {
    const { service, gitService } = serviceWith({
      [UPSTREAM]: 'origin/feature/foo\n',
      [HEAD]: 'foo\n',
    });

    await service.generatePrDescription();

    // A local `foo` tracking origin/feature/foo is not the same branch.
    expect(gitService.getBranchCommits).toHaveBeenCalledWith(repository, 'origin/feature/foo');
  });

  it('falls back to the first common default branch that exists', async () => {
    const { service, gitService } = serviceWith({
      [HEAD]: 'feat/x\n',
      [verify('origin/master')]: 'abc123\n',
    });

    await service.generatePrDescription();

    expect(vscode.window.showInputBox).not.toHaveBeenCalled();
    expect(gitService.getBranchCommits).toHaveBeenCalledWith(repository, 'origin/master');
  });

  it('reports no commits against an existing base as nothing to describe', async () => {
    const { service } = serviceWith({ [verify('origin/main')]: 'abc123\n' });

    const result = await service.generatePrDescription('origin/main');

    expect(result).toMatchObject({ description: null, noCommits: true, baseBranch: 'origin/main' });
    expect(result.error).toMatch(/aren't already on origin\/main/);
    expect(result).not.toHaveProperty('cause');
  });

  it('says when the base branch does not exist instead of "no commits"', async () => {
    const { service } = serviceWith({});

    const result = await service.generatePrDescription('mian');

    expect(result).toMatchObject({ noCommits: true, error: "Base branch 'mian' not found." });
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
    expect(timedOut.error).toMatch(/^Request timed out after 5s/);
    expect(timedOut).not.toHaveProperty('cause');

    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const cancelled = await makeFailingService(abort).service.generatePrDescription();
    expect(cancelled).toEqual({ description: null, cancelled: true });
    expect(cancelled).not.toHaveProperty('cause');
  });
});

describe('PrDescriptionService base-branch prompt', () => {
  it('cancels without calling the AI when the prompt is dismissed', async () => {
    const repository = { rootUri: { fsPath: '/tmp/repo' } };
    const gitService = {
      getActiveRepository: vi.fn(() => repository),
      // No upstream and no default branch, so the user is asked.
      execGit: gitMock({}),
      getBranchCommits: vi.fn(async () => ['feat: a']),
    };
    vi.mocked(vscode.window.showInputBox).mockResolvedValueOnce(undefined);
    const service = new PrDescriptionService(gitService as never, {} as never);

    expect(await service.generatePrDescription()).toEqual({ description: null, cancelled: true });
    expect(gitService.getBranchCommits).not.toHaveBeenCalled();
  });

  it('keeps main for an empty answer', async () => {
    const repository = { rootUri: { fsPath: '/tmp/repo' } };
    const gitService = {
      getActiveRepository: vi.fn(() => repository),
      execGit: gitMock({}),
      getBranchCommits: vi.fn(async () => []),
    };
    vi.mocked(vscode.window.showInputBox).mockResolvedValueOnce('');
    await new PrDescriptionService(gitService as never, {} as never).generatePrDescription();
    expect(gitService.getBranchCommits).toHaveBeenCalledWith(repository, 'main');
  });
});

describe('githubCompareUrl', () => {
  it('builds the compare page from HTTPS and SSH remotes', () => {
    expect(githubCompareUrl('https://github.com/acme/app.git\n', 'main', 'feat/x')).toBe(
      'https://github.com/acme/app/compare/main...feat/x?expand=1',
    );
    expect(githubCompareUrl('git@github.com:acme/app.git', 'origin/develop', 'fix')).toBe(
      'https://github.com/acme/app/compare/develop...fix?expand=1',
    );
  });

  it('lets GitHub pick the base when the upstream is the same branch', () => {
    expect(githubCompareUrl('https://github.com/acme/app', 'origin/feat/x', 'feat/x')).toBe(
      'https://github.com/acme/app/compare/feat/x?expand=1',
    );
  });

  it('returns undefined for other hosts or a detached HEAD', () => {
    expect(githubCompareUrl('git@gitlab.com:acme/app.git', 'main', 'x')).toBeUndefined();
    expect(githubCompareUrl('https://github.com/acme/app.git', 'main', 'HEAD')).toBeUndefined();
  });
});
