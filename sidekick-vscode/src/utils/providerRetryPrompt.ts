/**
 * @fileoverview Error notification for a failed AI request. A retryable
 * provider failure offers "Retry"; one that needs the user to do something
 * first offers the button that does it.
 *
 * @module providerRetryPrompt
 */

import * as vscode from 'vscode';
import type { ProviderFailureDiagnosis } from 'sidekick-shared';
import { ProviderRequestError, providerRetryOffer } from './providerFailure';

const RETRY_ACTION = 'Retry';

/** A button that takes the user to the fix a diagnosis asks for. */
export interface RecoveryAction {
  title: string;
  command: string;
  args?: unknown[];
}

/**
 * The button for a non-retryable provider failure, from its recovery hint:
 * the message says "sign in again" or "set the API key", so the notification
 * offers exactly that. Anything without a direct fix gets View Logs.
 */
export function recoveryActionFor(diagnosis: ProviderFailureDiagnosis): RecoveryAction {
  switch (diagnosis.recovery) {
    case 'sign_in':
      return { title: 'Sign In Again', command: 'sidekick.accounts.signInAgain' };
    case 'update_credentials':
      // Only Sidekick's own Claude API key can be set from here.
      return diagnosis.provider === 'claude-code' && diagnosis.credentialKind === 'api-key'
        ? { title: 'Set API Key', command: 'sidekick.setApiKey' }
        : { title: 'View Logs', command: 'sidekick.showLogs' };
    case 'choose_model':
      return {
        title: 'Open Settings',
        command: 'workbench.action.openSettings',
        args: ['sidekick model'],
      };
    case 'repair_runtime':
      return { title: 'Run Doctor', command: 'sidekick.doctor' };
    default:
      return { title: 'View Logs', command: 'sidekick.showLogs' };
  }
}

/**
 * Shows `message` as an error notification.
 *
 * - A retryable `ProviderRequestError` gains the provider's wait hint and a
 *   "Retry" button that runs `retry` once per click.
 * - A non-retryable one gains the button its recovery hint asks for (Sign In
 *   Again, Set API Key, Open Settings, Run Doctor, or View Logs).
 * - Anything else (a local validation message, say) is shown plain.
 *
 * Resolves after the user's choice (and, on Retry, after `retry` settles), or
 * immediately for a plain notification. A caller inside a `withProgress` task
 * should not await it, so the progress indicator closes while it is open.
 *
 * @param message - Notification text, shown unchanged apart from the wait hint
 * @param cause - The original error
 * @param retry - Re-runs the failed operation with the same arguments
 */
export async function showProviderFailure(
  message: string,
  cause: unknown,
  retry: () => unknown,
): Promise<void> {
  const offer = providerRetryOffer(cause);
  if (offer) {
    const choice = await vscode.window.showErrorMessage(`${message}${offer.hint}`, RETRY_ACTION);
    if (choice === RETRY_ACTION) await retry();
    return;
  }
  if (!(cause instanceof ProviderRequestError)) {
    void vscode.window.showErrorMessage(message);
    return;
  }
  const action = recoveryActionFor(cause.diagnosis);
  const choice = await vscode.window.showErrorMessage(message, action.title);
  if (choice === action.title) {
    await vscode.commands.executeCommand(action.command, ...(action.args ?? []));
  }
}
