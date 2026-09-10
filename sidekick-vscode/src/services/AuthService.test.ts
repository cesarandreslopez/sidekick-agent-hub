import { beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({
  provider: 'claude-api',
  complete: vi.fn(),
  isAvailable: vi.fn(),
  getApiKey: vi.fn(),
}));
vi.mock('vscode', () => ({
  workspace: {
    getConfiguration: () => ({
      get: (key: string) => (key === 'inferenceProvider' ? state.provider : undefined),
      inspect: () => ({}),
    }),
    onDidChangeConfiguration: () => ({ dispose() {} }),
  },
}));
vi.mock('./SecretsManager', () => ({
  SecretsManager: class {
    getApiKey = state.getApiKey;
  },
}));
vi.mock('./ApiKeyClient', () => ({
  ApiKeyClient: class {
    complete = state.complete;
    isAvailable = state.isAvailable;
    dispose() {}
  },
}));
vi.mock('./MaxSubscriptionClient', () => ({
  MaxSubscriptionClient: class {
    complete = state.complete;
    isAvailable = state.isAvailable;
    dispose() {}
  },
}));
vi.mock('./CodexClient', () => ({
  CodexClient: class {
    complete = state.complete;
    isAvailable = state.isAvailable;
    dispose() {}
  },
}));
vi.mock('./providers/ProviderDetector', () => ({ detectInferenceProvider: () => state.provider }));
vi.mock('./Logger', () => ({ log: vi.fn() }));
import { AuthService } from './AuthService';
import { TimeoutError } from '../types';
const context = { secrets: {} } as import('vscode').ExtensionContext;
beforeEach(() => {
  state.provider = 'claude-api';
  state.complete.mockReset();
  state.isAvailable.mockReset();
  state.getApiKey.mockReset().mockResolvedValue('test-key');
});
describe('AuthService failure evidence', () => {
  it('diagnoses the request provider even if settings change while it is running', async () => {
    const service = new AuthService(context);
    state.complete.mockImplementation(async () => {
      state.provider = 'codex';
      await (
        service as unknown as { handleProviderChange(): Promise<void> }
      ).handleProviderChange();
      throw { status: 401 };
    });
    await expect(service.complete('prompt')).rejects.toMatchObject({
      diagnosis: {
        provider: 'claude-code',
        credentialKind: 'api-key',
        diagnosis: 'api_credentials_rejected',
      },
    });
    service.dispose();
  });
  it.each(['claude-api', 'claude-max', 'codex'])(
    'reports terminal service failures for %s without credential guidance',
    async (provider) => {
      state.provider = provider;
      state.complete.mockRejectedValue({ status: 503, message: 'secret detail' });
      const service = new AuthService(context);
      await expect(service.complete('prompt')).rejects.toMatchObject({
        diagnosis: { diagnosis: 'service_unavailable', httpStatus: 503 },
        message: expect.stringContaining('unavailable'),
      });
      service.dispose();
    },
  );
  it.each([
    [401, 'api_credentials_rejected'],
    [503, 'service_unavailable'],
  ] as const)('preserves API check HTTP %s', async (status, diagnosis) => {
    state.isAvailable.mockRejectedValue({ status });
    const service = new AuthService(context);
    expect(await service.testConnection()).toMatchObject({
      success: false,
      diagnosis: { diagnosis },
    });
    service.dispose();
  });
  it('distinguishes missing API configuration', async () => {
    state.getApiKey.mockResolvedValue(undefined);
    const service = new AuthService(context);
    expect(await service.testConnection()).toMatchObject({
      success: false,
      diagnosis: { diagnosis: 'missing_credentials' },
    });
    expect(state.isAvailable).not.toHaveBeenCalled();
    service.dispose();
  });
  it('does not describe local readiness as authenticated connectivity', async () => {
    state.provider = 'codex';
    state.isAvailable.mockResolvedValue(true);
    const service = new AuthService(context);
    expect(await service.testConnection()).toMatchObject({
      success: true,
      observation: 'local-readiness',
      message: expect.stringContaining('authentication has not been verified'),
    });
    expect(state.complete).not.toHaveBeenCalled();
    service.dispose();
  });
  it.each([
    new TimeoutError('timeout', 100),
    Object.assign(new Error('cancelled'), { name: 'AbortError' }),
  ])('preserves cancellation and timeout control flow', async (error) => {
    state.complete.mockRejectedValue(error);
    const service = new AuthService(context);
    await expect(service.complete('prompt')).rejects.toBe(error);
    service.dispose();
  });
});
