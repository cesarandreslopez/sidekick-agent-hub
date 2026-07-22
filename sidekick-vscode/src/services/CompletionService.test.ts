import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
  workspace: {
    getConfiguration: () => ({
      get: (key: string) =>
        ({
          debounceMs: 10_000,
          inlineContextLines: 30,
          multiline: false,
          inlineModel: 'auto',
          timeoutPerKb: 500,
          maxTimeout: 120_000,
        })[key],
    }),
  },
  window: {},
}));
vi.mock('./Logger', () => ({ log: vi.fn(), logError: vi.fn() }));

import { CompletionService } from './CompletionService';

function token(cancelled: boolean) {
  return {
    isCancellationRequested: cancelled,
    onCancellationRequested: vi.fn(),
  };
}

describe('CompletionService debounce lifecycle', () => {
  it('resolves superseded and disposed debounce waits promptly', async () => {
    const service = new CompletionService({
      getProviderId: () => 'codex',
      complete: vi.fn(),
    } as never);
    const document = { languageId: 'typescript' };
    const position = {};

    const first = service.getCompletion(
      document as never,
      position as never,
      token(false) as never,
    );
    await Promise.resolve();
    const second = service.getCompletion(
      document as never,
      position as never,
      token(true) as never,
    );

    await expect(first).resolves.toBeUndefined();
    service.dispose();
    await expect(second).resolves.toBeUndefined();
  });
});
