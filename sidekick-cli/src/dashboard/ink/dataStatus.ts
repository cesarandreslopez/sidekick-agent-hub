/**
 * Health of the dashboard's data sources, rendered as a compact status badge.
 *
 * Load and watch failures used to be swallowed into empty catch blocks, so a
 * broken store or an unreadable session file produced an empty-looking
 * dashboard with nothing to distinguish it from a genuinely quiet project.
 */

export interface DataStatus {
  /** When the persisted project data last loaded successfully. */
  loadedAt: number | null;
  /** Message from the most recent failed load, if it has not since succeeded. */
  error: string | null;
  /** A refresh is in flight. */
  refreshing: boolean;
  /** Message from the most recent session-watcher failure. */
  watcherError: string | null;
  /** When that watcher failure was recorded, so the badge can expire it. */
  watcherErrorAt: number | null;
}

export interface StatusBadge {
  text: string;
  color: 'red' | 'yellow' | 'gray';
}

/** How long data may go unrefreshed before the badge calls it stale. */
export const STALE_AFTER_MS = 120_000;

/**
 * How long a watcher failure keeps the badge.
 *
 * The watcher treats most errors as recoverable — it closes the handle and
 * degrades to catch-up polling — so the failure is a moment in time, not a
 * standing condition. Without an expiry one transient hiccup pinned the badge
 * for the life of the process and masked every lower-ranked signal behind it.
 */
export const WATCHER_ERROR_TTL_MS = 60_000;

export function initialDataStatus(): DataStatus {
  return {
    loadedAt: null,
    error: null,
    refreshing: false,
    watcherError: null,
    watcherErrorAt: null,
  };
}

/**
 * Badge for the status bar, or `null` when everything is healthy and fresh.
 *
 * Ordered by severity: a failed load outranks a recent watcher hiccup, which
 * outranks an in-flight refresh, which outranks staleness.
 */
export function describeDataStatus(status: DataStatus, now: number): StatusBadge | null {
  if (status.error) return { text: '⚠ data', color: 'red' };
  const watcherErrorIsCurrent =
    status.watcherError !== null &&
    (status.watcherErrorAt === null || now - status.watcherErrorAt <= WATCHER_ERROR_TTL_MS);
  if (watcherErrorIsCurrent) return { text: '⚠ session', color: 'yellow' };
  if (status.refreshing) return { text: '↻', color: 'gray' };
  if (status.loadedAt !== null && now - status.loadedAt > STALE_AFTER_MS) {
    return { text: `stale ${Math.floor((now - status.loadedAt) / 60_000)}m`, color: 'yellow' };
  }
  return null;
}
