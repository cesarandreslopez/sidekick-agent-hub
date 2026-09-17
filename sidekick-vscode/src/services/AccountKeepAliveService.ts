/**
 * Opt-in keep-alive: while `sidekick.accounts.keepAlive` is on, refresh
 * saved-but-inactive accounts through the official CLIs after activation and
 * every six hours, so they do not expire while unused.
 */

import * as vscode from 'vscode';
import { refreshInactiveAccounts } from 'sidekick-shared';
import { log, logError } from './Logger';

const INTERVAL_MS = 6 * 60 * 60 * 1000;
const INITIAL_DELAY_MS = 15_000;

export class AccountKeepAliveService implements vscode.Disposable {
  private timer: ReturnType<typeof setInterval> | undefined;
  private initial: ReturnType<typeof setTimeout> | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private running = false;

  constructor(private readonly onRefreshed: () => void) {
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('sidekick.accounts.keepAlive')) this.configure();
      }),
    );
    this.configure();
  }

  private enabled(): boolean {
    return vscode.workspace.getConfiguration('sidekick').get<boolean>('accounts.keepAlive', false);
  }

  private configure(): void {
    this.stopTimers();
    if (!this.enabled()) return;
    this.initial = setTimeout(() => void this.runOnce(), INITIAL_DELAY_MS);
    this.timer = setInterval(() => void this.runOnce(), INTERVAL_MS);
    log('AccountKeepAliveService: keep-alive enabled');
  }

  async runOnce(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const result = await refreshInactiveAccounts();
      log(
        `AccountKeepAliveService: refreshed ${result.refreshed.length}, skipped ${result.skipped.length}, failed ${result.failed.length}`,
      );
      for (const failed of result.failed) {
        logError(`AccountKeepAliveService: ${failed.providerId} ${failed.id}: ${failed.error}`);
      }
      if (result.refreshed.length > 0) this.onRefreshed();
    } catch (err) {
      logError('AccountKeepAliveService: keep-alive run failed', err);
    } finally {
      this.running = false;
    }
  }

  private stopTimers(): void {
    if (this.initial) clearTimeout(this.initial);
    if (this.timer) clearInterval(this.timer);
    this.initial = undefined;
    this.timer = undefined;
  }

  dispose(): void {
    this.stopTimers();
    for (const disposable of this.disposables) disposable.dispose();
  }
}
