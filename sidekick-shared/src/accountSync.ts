/**
 * Continuous reconciliation between the live provider logins and sidekick's
 * saved profiles. One engine replaces the old bootstrap/reconcile/backup
 * paths: it registers logins sidekick has never seen, folds rotated tokens
 * back into their profile, merges duplicate Codex seats, and re-points the
 * active pointer at whatever is really logged in.
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  cleanupAbandonedClaudeLogins,
  syncClaudeLiveStateUnlocked,
  withClaudeAuthSwapLock,
} from './accounts';
import { getClaudeConfigPath, getLiveClaudeHome, readLiveClaudeIdentity } from './claudeProfiles';
import {
  cleanupAbandonedCodexLogins,
  syncCodexLiveStateUnlocked,
  withCodexAuthSwapLock,
} from './codexProfiles';
import { getSystemCodexHome } from './codexPaths';
import type { AccountProviderId } from './accountRegistry';
import type { AccountHealthSource } from './accountHealth';
import {
  emptyProviderSyncReport,
  type ProviderSyncReport,
  type SyncReason,
  type SyncReport,
} from './accountSyncTypes';

export interface SyncLiveAccountStateOptions {
  providers?: AccountProviderId[];
  reason?: SyncReason;
  /**
   * Skip the sync when the live files have not changed since the last pass
   * (default for `watch`/`poll`). On macOS the Keychain cannot be fingerprinted
   * cheaply, so a Claude fold still runs at most every `keychainFoldIntervalMs`.
   */
  onlyIfChanged?: boolean;
  keychainFoldIntervalMs?: number;
  now?: number;
}

const DEFAULT_KEYCHAIN_FOLD_INTERVAL_MS = 10 * 60 * 1000;

interface ProviderFingerprintState {
  fingerprint?: string;
  lastFoldAt?: number;
}

const fingerprints: Record<AccountProviderId, ProviderFingerprintState> = {
  'claude-code': {},
  codex: {},
};
let syncInProgress = false;

function statStamp(filePath: string): string {
  try {
    const stat = fs.statSync(filePath);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return 'absent';
  }
}

function claudeFingerprint(): string {
  const home = getLiveClaudeHome();
  const identity = readLiveClaudeIdentity();
  return [
    identity?.uuid ?? 'none',
    statStamp(getClaudeConfigPath(home)),
    statStamp(path.join(home, '.credentials.json')),
  ].join('|');
}

function codexFingerprint(): string {
  const home = getSystemCodexHome();
  return [
    statStamp(path.join(home, 'auth.json')),
    statStamp(path.join(home, '.credentials.json')),
  ].join('|');
}

function sourceForReason(reason: SyncReason): AccountHealthSource {
  return reason === 'pre-switch' ? 'switch' : 'live-sync';
}

function shouldSync(
  provider: AccountProviderId,
  fingerprint: string,
  options: Required<
    Pick<SyncLiveAccountStateOptions, 'onlyIfChanged' | 'keychainFoldIntervalMs' | 'now'>
  >,
): boolean {
  if (!options.onlyIfChanged) return true;
  const state = fingerprints[provider];
  if (state.fingerprint !== fingerprint) return true;
  if (provider === 'claude-code' && process.platform === 'darwin') {
    // The Keychain item can change without touching any watched file.
    return (state.lastFoldAt ?? 0) + options.keychainFoldIntervalMs <= options.now;
  }
  return false;
}

/** Sync one provider under its swap lock; never throws. */
function syncProvider(
  provider: AccountProviderId,
  reason: SyncReason,
  options: Required<
    Pick<SyncLiveAccountStateOptions, 'onlyIfChanged' | 'keychainFoldIntervalMs' | 'now'>
  >,
): ProviderSyncReport {
  const fingerprint = provider === 'codex' ? codexFingerprint() : claudeFingerprint();
  if (!shouldSync(provider, fingerprint, options)) {
    return { ...emptyProviderSyncReport(), skipped: 'unchanged' };
  }
  const source = sourceForReason(reason);
  let report: ProviderSyncReport;
  try {
    report =
      provider === 'codex'
        ? withCodexAuthSwapLock(() => syncCodexLiveStateUnlocked(source))
        : withClaudeAuthSwapLock(() => syncClaudeLiveStateUnlocked(source));
  } catch (err) {
    return { warnings: [`Could not acquire the ${provider} account-switch lock: ${err}`] };
  }
  fingerprints[provider] = {
    // Re-fingerprint after the sync: folding rewrites nothing in the live home,
    // but registering touches accounts.json, which is also watched.
    fingerprint: provider === 'codex' ? codexFingerprint() : claudeFingerprint(),
    lastFoldAt: options.now,
  };
  return report;
}

/**
 * Reconcile the live logins with the saved profiles for both providers.
 * Safe to call from watchers: re-entrant calls return an empty report, and
 * `onlyIfChanged` short-circuits when the live files are unchanged.
 */
export function syncLiveAccountStateSync(options: SyncLiveAccountStateOptions = {}): SyncReport {
  const reason = options.reason ?? 'manual';
  const now = options.now ?? Date.now();
  const resolved = {
    onlyIfChanged: options.onlyIfChanged ?? (reason === 'watch' || reason === 'poll'),
    keychainFoldIntervalMs: options.keychainFoldIntervalMs ?? DEFAULT_KEYCHAIN_FOLD_INTERVAL_MS,
    now,
  };
  const providers = options.providers ?? ['claude-code', 'codex'];
  const report: SyncReport = {
    claude: { ...emptyProviderSyncReport(), skipped: 'not-requested' },
    codex: { ...emptyProviderSyncReport(), skipped: 'not-requested' },
    ranAt: now,
    reason,
  };
  if (syncInProgress) {
    report.claude.skipped = 'in-progress';
    report.codex.skipped = 'in-progress';
    return report;
  }
  syncInProgress = true;
  try {
    if (providers.includes('claude-code'))
      report.claude = syncProvider('claude-code', reason, resolved);
    if (providers.includes('codex')) report.codex = syncProvider('codex', reason, resolved);
  } finally {
    syncInProgress = false;
  }
  return report;
}

/** Promise-returning twin of {@link syncLiveAccountStateSync} for async hosts. */
export async function syncLiveAccountState(
  options: SyncLiveAccountStateOptions = {},
): Promise<SyncReport> {
  return syncLiveAccountStateSync(options);
}

/** Forget the change fingerprints (tests, or after an external reset). */
export function _resetSyncFingerprints(): void {
  fingerprints['claude-code'] = {};
  fingerprints.codex = {};
}

export interface CleanupAbandonedLoginsResult {
  claude: string[];
  codex: string[];
}

/** Remove isolated login homes that never authenticated (both providers). */
export function cleanupAbandonedLogins(
  olderThanMs: number = 6 * 60 * 60 * 1000,
  now: number = Date.now(),
): CleanupAbandonedLoginsResult {
  return {
    claude: cleanupAbandonedClaudeLogins(olderThanMs, now),
    codex: cleanupAbandonedCodexLogins(olderThanMs, now),
  };
}
