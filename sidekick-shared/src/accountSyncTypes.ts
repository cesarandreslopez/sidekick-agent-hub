/** Reports produced by the live-state sync engine (see accountSync.ts). */

export interface ProviderSyncReport {
  /** A live login that had no saved profile was registered under this id. */
  registered?: { id: string; email?: string };
  /** The live credential was folded into this profile's backup. */
  folded?: string;
  /** The active pointer was moved to this profile to match the live login. */
  repointed?: string;
  /** Duplicate profiles merged away (ids of the removed losers). */
  merged?: string[];
  /** Why nothing was synced (`logged-out`, `keyring`, `no-identity`, `unchanged`). */
  skipped?: string;
  warnings: string[];
}

export type SyncReason = 'startup' | 'watch' | 'poll' | 'pre-switch' | 'manual';

export interface SyncReport {
  claude: ProviderSyncReport;
  codex: ProviderSyncReport;
  ranAt: number;
  reason: SyncReason;
}

export function emptyProviderSyncReport(): ProviderSyncReport {
  return { warnings: [] };
}
