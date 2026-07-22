import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
  workspace: { getConfiguration: vi.fn() },
  window: { showInputBox: vi.fn() },
}));
vi.mock('./Logger', () => ({ log: vi.fn(), logError: vi.fn() }));
vi.mock('./TimeoutManager', () => ({ getTimeoutManager: () => ({}) }));

import { PrDescriptionService } from './PrDescriptionService';

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
