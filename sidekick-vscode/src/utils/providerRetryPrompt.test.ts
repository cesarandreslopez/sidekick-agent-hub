import { beforeEach, describe, expect, it, vi } from 'vitest';

const showErrorMessage = vi.hoisted(() => vi.fn());
const executeCommand = vi.hoisted(() => vi.fn());

vi.mock('vscode', () => ({ window: { showErrorMessage }, commands: { executeCommand } }));

import { ProviderRequestError } from './providerFailure';
import { recoveryActionFor, showProviderFailure } from './providerRetryPrompt';

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

  it('offers Retry when Codex flex capacity is unavailable', async () => {
    showErrorMessage.mockResolvedValue('Retry');
    const retry = vi.fn();

    await showProviderFailure('Explain failed: flex', codexError('flexUnavailable'), retry);

    expect(showErrorMessage).toHaveBeenCalledWith('Explain failed: flex', 'Retry');
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('does not offer Retry after Codex hit its approval-denial limit', async () => {
    const retry = vi.fn();

    await showProviderFailure('Failed: denied', codexError('tooManyDenials'), retry);
    await showProviderFailure('Failed: denied', codexError('too_many_denials'), retry);

    // No retry; the recovery button for a policy denial is View Logs.
    expect(showErrorMessage.mock.calls).toEqual([
      ['Failed: denied', 'View Logs'],
      ['Failed: denied', 'View Logs'],
    ]);
    expect(retry).not.toHaveBeenCalled();
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

  it('shows the plain message, with no button, for anything but a provider failure', async () => {
    const retry = vi.fn();

    await showProviderFailure('Failed: plain', new Error('plain'), retry);
    await showProviderFailure('Failed: none', undefined, retry);

    expect(showErrorMessage.mock.calls).toEqual([['Failed: plain'], ['Failed: none']]);
    expect(retry).not.toHaveBeenCalled();
  });

  it('offers the fix a non-retryable provider failure asks for, and runs it on click', async () => {
    executeCommand.mockReset();
    const expired = new ProviderRequestError({
      provider: 'claude-code',
      credentialKind: 'oauth',
      error: Object.assign(new Error('OAuth token has expired'), { status: 401 }),
    });
    showErrorMessage.mockResolvedValueOnce('Sign In Again');
    const retry = vi.fn();

    await showProviderFailure('Transform failed: expired', expired, retry);

    expect(showErrorMessage).toHaveBeenCalledWith('Transform failed: expired', 'Sign In Again');
    expect(executeCommand).toHaveBeenCalledWith('sidekick.accounts.signInAgain');
    expect(retry).not.toHaveBeenCalled();
  });

  it('does not wait on the plain notification', async () => {
    showErrorMessage.mockReturnValue(new Promise(() => {}));

    await expect(showProviderFailure('Failed', new Error('plain'), vi.fn())).resolves.toBe(
      undefined,
    );
  });
});

describe('recoveryActionFor', () => {
  const diagnosis = (recovery: string, extra: Record<string, unknown> = {}) =>
    ({ provider: 'claude-code', credentialKind: 'oauth', recovery, ...extra }) as never;

  it('maps each recovery hint to the button that performs it', () => {
    expect(recoveryActionFor(diagnosis('sign_in')).command).toBe('sidekick.accounts.signInAgain');
    expect(
      recoveryActionFor(diagnosis('update_credentials', { credentialKind: 'api-key' })).command,
    ).toBe('sidekick.setApiKey');
    expect(recoveryActionFor(diagnosis('choose_model'))).toEqual({
      title: 'Open Settings',
      command: 'workbench.action.openSettings',
      args: ['sidekick model'],
    });
    expect(recoveryActionFor(diagnosis('repair_runtime')).command).toBe('sidekick.doctor');
    expect(recoveryActionFor(diagnosis('inspect_error')).command).toBe('sidekick.showLogs');
  });

  it('offers Set API Key only for the Claude API key Sidekick manages', () => {
    expect(
      recoveryActionFor(
        diagnosis('update_credentials', { provider: 'codex', credentialKind: 'api-key' }),
      ).command,
    ).toBe('sidekick.showLogs');
    expect(recoveryActionFor(diagnosis('update_credentials')).command).toBe('sidekick.showLogs');
  });
});
