import * as fs from 'fs';
import * as path from 'path';
import { addCurrentAccount, readActiveClaudeAccount } from './accounts';
import { getActiveSavedAccount } from './accountRegistry';
import {
  getActiveCodexAccount,
  getCodexProfilesDir,
  getSystemCodexHome,
  prepareCodexAccount,
} from './codexProfiles';
import { readClaudeMaxCredentials } from './credentials';

export type EnsureDefaultAccountStatus = 'registered' | 'skipped' | 'error';

export interface EnsureDefaultAccountsResult {
  claude: EnsureDefaultAccountStatus;
  codex: EnsureDefaultAccountStatus;
}

export interface EnsureDefaultAccountsOptions {
  logger?: (message: string, error?: unknown) => void;
}

function logFailure(options: EnsureDefaultAccountsOptions | undefined, message: string, error: unknown): void {
  try {
    options?.logger?.(message, error);
  } catch {
    // Logging must never make account bootstrap fail.
  }
}

async function ensureDefaultClaudeAccount(
  options: EnsureDefaultAccountsOptions | undefined,
): Promise<EnsureDefaultAccountStatus> {
  try {
    if (getActiveSavedAccount('claude-code')) return 'skipped';

    const active = readActiveClaudeAccount();
    if (!active) return 'skipped';

    const credentials = await readClaudeMaxCredentials();
    if (!credentials) return 'skipped';

    const result = addCurrentAccount('Default');
    if (result.success) return 'registered';

    logFailure(options, 'Claude default account registration failed.', result.error ?? 'unknown error');
    return 'error';
  } catch (error) {
    logFailure(options, 'Claude default account registration failed.', error);
    return 'error';
  }
}

function cleanupPendingCodexProfile(profileId: string): void {
  fs.rmSync(path.join(getCodexProfilesDir(), profileId), { recursive: true, force: true });
}

function ensureDefaultCodexAccount(
  options: EnsureDefaultAccountsOptions | undefined,
): EnsureDefaultAccountStatus {
  try {
    if (getActiveCodexAccount()) return 'skipped';

    const systemAuthPath = path.join(getSystemCodexHome(), 'auth.json');
    if (!fs.existsSync(systemAuthPath)) return 'skipped';

    const result = prepareCodexAccount('Default');
    if (result.success && !result.needsLogin) return 'registered';

    if (result.profileId) {
      cleanupPendingCodexProfile(result.profileId);
    }
    logFailure(options, 'Codex default account registration failed.', result.error ?? 'Codex auth could not be finalized.');
    return 'error';
  } catch (error) {
    logFailure(options, 'Codex default account registration failed.', error);
    return 'error';
  }
}

export async function ensureDefaultAccounts(
  options?: EnsureDefaultAccountsOptions,
): Promise<EnsureDefaultAccountsResult> {
  const claude = await ensureDefaultClaudeAccount(options);
  const codex = ensureDefaultCodexAccount(options);

  return { claude, codex };
}
