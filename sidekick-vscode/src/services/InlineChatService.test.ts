import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockExecuteWithTimeout = vi.hoisted(() => vi.fn());

vi.mock('vscode', () => ({
  workspace: { getConfiguration: () => ({ get: () => 'auto' }) },
}));
vi.mock('./TimeoutManager', () => ({
  TimeoutManager: class {},
  getTimeoutManager: () => ({
    getTimeoutConfig: () => ({
      baseTimeout: 60_000,
      maxTimeout: 120_000,
      perKbTimeout: 500,
      retryMultiplier: 1.5,
    }),
    executeWithTimeout: (...args: unknown[]) => mockExecuteWithTimeout(...args),
    promptRetry: vi.fn(),
  }),
}));

import { InlineChatService } from './InlineChatService';

describe('InlineChatService', () => {
  beforeEach(() => {
    mockExecuteWithTimeout.mockReset();
    mockExecuteWithTimeout.mockResolvedValue({
      success: false,
      timedOut: false,
      timeoutMs: 60_000,
      error: Object.assign(new Error('cancelled'), { name: 'AbortError' }),
    });
  });

  it('links the provider cancellation signal and avoids duplicate progress UI', async () => {
    const authService = {
      getProviderId: () => 'codex',
      getProviderDisplayName: () => 'Codex',
      complete: vi.fn(),
    };
    const controller = new AbortController();
    const service = new InlineChatService(authService as never);

    const result = await service.process(
      {
        query: 'explain',
        selectedText: 'const x = 1;',
        languageId: 'typescript',
        contextBefore: '',
        contextAfter: '',
        cursorPosition: { line: 0, character: 0 },
        documentUri: 'file:///tmp/test.ts',
      },
      controller.signal,
    );

    expect(mockExecuteWithTimeout).toHaveBeenCalledWith(
      expect.objectContaining({
        showProgress: false,
        externalSignal: controller.signal,
      }),
    );
    expect(result).toEqual({ success: false, error: 'Request cancelled' });
  });
});
