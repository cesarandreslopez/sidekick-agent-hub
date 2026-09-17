/**
 * Runs a provider sign-in inside a VS Code terminal and finalizes the saved
 * profile once the isolated home authenticates. One code path for both
 * providers: begin → poll status → finalize, cancellable from the progress
 * notification or by closing the terminal.
 */

import * as vscode from 'vscode';
import {
  beginAccountLogin,
  finalizeAccountLoginAsync,
  getAccountLoginStatusAsync,
} from 'sidekick-shared';
import type { AccountManagerResult, AccountProviderId } from 'sidekick-shared';
import { logError } from './Logger';

export interface AccountLoginRunOptions {
  /** Re-authenticate this saved profile instead of creating a new one. */
  existingAccountId?: string;
  /** Activate the account after a successful login (default true). */
  activate?: boolean;
  timeoutMs?: number;
  pollIntervalMs?: number;
}

export interface AccountLoginRunResult {
  outcome: 'saved' | 'cancelled' | 'timeout' | 'failed';
  result?: AccountManagerResult;
  error?: string;
}

const PROVIDER_LABELS: Record<AccountProviderId, string> = {
  'claude-code': 'Claude',
  codex: 'Codex',
};

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function powershellQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** Quote a command line for the terminal's shell family. */
export function quoteCommandLine(
  command: string,
  args: string[],
  platform: NodeJS.Platform,
): string {
  const quote = platform === 'win32' ? powershellQuote : shellQuote;
  const line = [command, ...args].map(quote).join(' ');
  return platform === 'win32' ? `& ${line}` : line;
}

export class AccountLoginRunner implements vscode.Disposable {
  private readonly active = new Set<() => void>();
  private disposed = false;

  async run(
    providerId: AccountProviderId,
    label: string,
    options: AccountLoginRunOptions = {},
  ): Promise<AccountLoginRunResult> {
    const begin = beginAccountLogin(providerId, label, {
      existingAccountId: options.existingAccountId,
    });
    if (!begin.success) return { outcome: 'failed', error: begin.error };

    const finalize = async (): Promise<AccountLoginRunResult> => {
      const result = await finalizeAccountLoginAsync(providerId, begin.loginId, {
        activate: options.activate ?? true,
      });
      return result.success
        ? { outcome: 'saved', result }
        : { outcome: 'failed', result, error: result.error };
    };

    if (begin.alreadyComplete) return finalize();
    if (!begin.command)
      return { outcome: 'failed', error: 'Account login command was not prepared.' };

    const env: Record<string, string | null> = { ...(begin.env ?? {}) };
    for (const name of begin.envUnset ?? []) env[name] = null;
    const terminal = vscode.window.createTerminal({
      name: `Sidekick ${PROVIDER_LABELS[providerId]} Login${label ? ` (${label})` : ''}`,
      env,
    });
    terminal.show();
    terminal.sendText(quoteCommandLine(begin.command, begin.args ?? [], process.platform), true);

    const timeoutMs = options.timeoutMs ?? 180_000;
    const pollIntervalMs = options.pollIntervalMs ?? 2_000;

    return vscode.window
      .withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Waiting for the ${PROVIDER_LABELS[providerId]} sign-in in the Sidekick terminal…`,
          cancellable: true,
        },
        (progress, token) =>
          new Promise<AccountLoginRunResult>((resolve) => {
            const startedAt = Date.now();
            let settled = false;
            let interval: ReturnType<typeof setInterval> | undefined;
            let tickInFlight = false;
            const listeners: vscode.Disposable[] = [];

            const stop = (): void => {
              if (interval !== undefined) clearInterval(interval);
              interval = undefined;
              for (const listener of listeners) listener.dispose();
              this.active.delete(stop);
            };
            const settle = (outcome: AccountLoginRunResult): void => {
              if (settled) return;
              settled = true;
              stop();
              resolve(outcome);
            };
            this.active.add(stop);

            listeners.push(
              token.onCancellationRequested(() => settle({ outcome: 'cancelled' })),
              vscode.window.onDidCloseTerminal((closed) => {
                if (closed === terminal) settle({ outcome: 'cancelled' });
              }),
            );

            const tick = async (): Promise<void> => {
              if (settled || tickInFlight) return;
              tickInFlight = true;
              try {
                const status = await getAccountLoginStatusAsync(providerId, begin.loginId);
                if (settled) return;
                if (status.state === 'authenticated') {
                  settle(await finalize());
                  return;
                }
                const elapsed = Date.now() - startedAt;
                progress.report({
                  message: `${Math.max(0, Math.ceil((timeoutMs - elapsed) / 1000))}s left`,
                });
                if (elapsed > timeoutMs) settle({ outcome: 'timeout' });
              } catch (err) {
                logError('Failed to poll account login status', err);
              } finally {
                tickInFlight = false;
              }
            };
            interval = setInterval(() => void tick(), pollIntervalMs);
            void tick();
          }),
      )
      .then((outcome) => (this.disposed ? { outcome: 'cancelled' as const } : outcome));
  }

  dispose(): void {
    this.disposed = true;
    for (const stop of [...this.active]) stop();
  }
}
