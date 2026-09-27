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
  /**
   * The live account's profile home held a CLI-usable copy of its login; it
   * was removed (the account that is live keeps exactly one copy: live).
   */
  demoted?: string;
  /** That copy was strictly newer than live, so it replaced the dying live login first. */
  repaired?: string;
  /** A switch that crashed mid-way was finished or rolled back from its journal. */
  journal?: 'finished' | 'rolled-back' | 'cleared';
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
