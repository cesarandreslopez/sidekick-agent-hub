import { beforeEach, describe, expect, it, vi } from 'vitest';

const showErrorMessage = vi.hoisted(() => vi.fn());

vi.mock('vscode', () => ({ window: { showErrorMessage } }));

import { ProviderRequestError } from './providerFailure';
import { showProviderFailure } from './providerRetryPrompt';

const codexError = (codexErrorInfo: unknown, extra: Record<string, unknown> = {}) =>
  new ProviderRequestError({
    provider: 'codex',
    credentialKind: 'oauth',
    error: new Error('Codex error: turn failed', {
      cause: { message: 'turn failed', codexErrorInfo, ...extra },
    }),
  });

describe('showProviderFailure', () => {
  beforeEach(() => {
    showErrorMessage.mockReset();
    showErrorMessage.mockResolvedValue(undefined);
  });

  it('offers Retry for a retryable diagnosis and runs the retry on click', async () => {
    showErrorMessage.mockResolvedValue('Retry');
    const retry = vi.fn();

    await showProviderFailure('Review failed: busy', codexError('serverOverloaded'), retry);

    expect(showErrorMessage).toHaveBeenCalledWith('Review failed: busy', 'Retry');
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('appends the provider wait hint', async () => {
    const cause = codexError('usageLimitExceeded', { headers: { 'retry-after': '30' } });

    await showProviderFailure('Transform failed: limited', cause, vi.fn());

    expect(showErrorMessage).toHaveBeenCalledWith(
      'Transform failed: limited The provider asked to wait 30s.',
      'Retry',
    );
  });

  it('does not retry when the notification is dismissed', async () => {
    const retry = vi.fn();

    await showProviderFailure('Failed', codexError('serverOverloaded'), retry);

    expect(retry).not.toHaveBeenCalled();
  });

  it('runs the retry once per click and waits for it to settle', async () => {
    showErrorMessage.mockResolvedValueOnce('Retry').mockResolvedValueOnce(undefined);
    const cause = codexError('serverOverloaded');
    let settled = false;
    // The retry fails the same way once more; the second notification is dismissed.
    const retry = vi.fn(async () => {
      await showProviderFailure('Failed', cause, retry);
      settled = true;
    });

    await showProviderFailure('Failed', cause, retry);

    expect(retry).toHaveBeenCalledTimes(1);
    expect(showErrorMessage).toHaveBeenCalledTimes(2);
    expect(settled).toBe(true);
  });

  it('shows the plain message without Retry when a retry cannot help', async () => {
    const retry = vi.fn();

    await showProviderFailure('Failed: plain', new Error('plain'), retry);
    await showProviderFailure('Failed: auth', codexError('unauthorized'), retry);
    await showProviderFailure('Failed: none', undefined, retry);

    expect(showErrorMessage.mock.calls).toEqual([
      ['Failed: plain'],
      ['Failed: auth'],
      ['Failed: none'],
    ]);
    expect(retry).not.toHaveBeenCalled();
  });

  it('does not wait on the plain notification', async () => {
    showErrorMessage.mockReturnValue(new Promise(() => {}));

    await expect(showProviderFailure('Failed', new Error('plain'), vi.fn())).resolves.toBe(
      undefined,
    );
  });
});
