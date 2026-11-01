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
import { ProviderRequestError } from '../utils/providerFailure';

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

describe('InlineChatService failure cause', () => {
  const request = {
    query: 'explain',
    selectedText: 'const x = 1;',
    languageId: 'typescript',
    contextBefore: '',
    contextAfter: '',
    cursorPosition: { line: 0, character: 0 },
    documentUri: 'file:///tmp/test.ts',
  };

  it('returns a provider failure as the cause with the unchanged message', async () => {
    const error = new ProviderRequestError({
      provider: 'codex',
      credentialKind: 'oauth',
      error: new Error('Codex error: turn failed', {
        cause: { message: 'turn failed', codexErrorInfo: 'serverOverloaded' },
      }),
    });
    // Run the task the way TimeoutManager does: a rejection comes back as `error`.
    mockExecuteWithTimeout.mockImplementationOnce(
      async ({ task }: { task: (signal: AbortSignal) => Promise<string> }) => {
        try {
          return { success: true, result: await task(new AbortController().signal) };
        } catch (caught) {
          return { success: false, error: caught, timedOut: false, timeoutMs: 60_000 };
        }
      },
    );
    const authService = {
      getProviderId: () => 'codex',
      getProviderDisplayName: () => 'Codex',
      complete: vi.fn(() => Promise.reject(error)),
    };

    const result = await new InlineChatService(authService as never).process(request);

    expect(result).toEqual({ success: false, error: error.message, cause: error });
  });

  it('sets no cause for a timeout or cancellation', async () => {
    const authService = {
      getProviderId: () => 'codex',
      getProviderDisplayName: () => 'Codex',
      complete: vi.fn(),
    };
    const service = new InlineChatService(authService as never);

    const cancelled = await service.process(request);
    expect(cancelled).not.toHaveProperty('cause');

    mockExecuteWithTimeout.mockResolvedValueOnce({ success: false, timedOut: true, timeoutMs: 5 });
    const timedOut = await service.process(request);
    expect(timedOut).toEqual({ success: false, error: 'Request timed out after 5ms' });
  });
});
