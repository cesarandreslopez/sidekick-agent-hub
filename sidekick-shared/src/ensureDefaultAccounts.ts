import { reconcileClaudeAuthState } from './accounts';
import { reconcileCodexAuthStateAsync } from './codexProfiles';
import { cleanupAbandonedLogins, syncLiveAccountState } from './accountSync';
import type { ProviderSyncReport, SyncReport } from './accountSyncTypes';

export type EnsureDefaultAccountStatus = 'registered' | 'skipped' | 'error';

export interface EnsureDefaultAccountsResult {
  claude: EnsureDefaultAccountStatus;
  codex: EnsureDefaultAccountStatus;
  /** The full sync report behind the two statuses. */
  sync?: SyncReport;
}

export interface EnsureDefaultAccountsOptions {
  logger?: (message: string, error?: unknown) => void;
}

function logFailure(
  options: EnsureDefaultAccountsOptions | undefined,
  message: string,
  error: unknown,
): void {
  try {
    options?.logger?.(message, error);
  } catch {
    // Logging must never make account bootstrap fail.
  }
}

function statusFromReport(report: ProviderSyncReport): EnsureDefaultAccountStatus {
  if (report.registered) return 'registered';
  if (report.warnings.length > 0) return 'error';
  return 'skipped';
}

/**
 * Host startup hook: run the one-time on-disk migrations, drop abandoned
 * isolated logins, then reconcile the live logins with the saved profiles
 * (registering any login sidekick has never seen).
 */
export async function ensureDefaultAccounts(
  options?: EnsureDefaultAccountsOptions,
): Promise<EnsureDefaultAccountsResult> {
  try {
    reconcileClaudeAuthState();
  } catch (error) {
    logFailure(options, 'Claude auth reconciliation failed.', error);
  }

  try {
    await reconcileCodexAuthStateAsync();
  } catch (error) {
    logFailure(options, 'Codex auth reconciliation failed.', error);
  }

  try {
    cleanupAbandonedLogins();
  } catch (error) {
    logFailure(options, 'Abandoned login cleanup failed.', error);
  }

  let sync: SyncReport;
  try {
    sync = await syncLiveAccountState({ reason: 'startup' });
  } catch (error) {
    logFailure(options, 'Account sync failed.', error);
    return { claude: 'error', codex: 'error' };
  }

  for (const [provider, report] of [
    ['Claude', sync.claude],
    ['Codex', sync.codex],
  ] as const) {
    for (const warning of report.warnings) {
      logFailure(options, `${provider} account sync: ${warning}`, undefined);
    }
  }

  return {
    claude: statusFromReport(sync.claude),
    codex: statusFromReport(sync.codex),
    sync,
  };
}
