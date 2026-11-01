/**
 * @fileoverview Error notification for a failed AI request that offers
 * "Retry" when the provider failure is worth retrying unchanged.
 *
 * @module providerRetryPrompt
 */

import * as vscode from 'vscode';
import { providerRetryOffer } from './providerFailure';

const RETRY_ACTION = 'Retry';

/**
 * Shows `message` as an error notification. When `cause` is a provider failure
 * whose shared diagnosis is retryable, the notification gains the provider's
 * wait hint and a "Retry" button that runs `retry` once per click.
 *
 * Resolves immediately when no retry is offered (the plain notification is not
 * awaited); otherwise after the user's choice and, on Retry, after `retry`
 * settles. A caller inside a `withProgress` task should not await it, so the
 * progress indicator closes while the notification is open.
 *
 * @param message - Notification text, shown unchanged apart from the wait hint
 * @param cause - The original error; anything other than a retryable
 *   `ProviderRequestError` gets the plain notification
 * @param retry - Re-runs the failed operation with the same arguments
 */
export async function showProviderFailure(
  message: string,
  cause: unknown,
  retry: () => unknown,
): Promise<void> {
  const offer = providerRetryOffer(cause);
  if (!offer) {
    void vscode.window.showErrorMessage(message);
    return;
  }
  const choice = await vscode.window.showErrorMessage(`${message}${offer.hint}`, RETRY_ACTION);
  if (choice === RETRY_ACTION) await retry();
}
