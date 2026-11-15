/**
 * @fileoverview One vocabulary for "is the attached session live?" across
 * the sidebar webviews.
 *
 * - `Live`: the monitor is attached and the session changed recently.
 * - `Viewing`: the monitor is attached to a session that has gone quiet
 *   (a past session the user picked, or one that stopped).
 * - `No session`: nothing is attached.
 *
 * @module utils/sessionLiveness
 */

import * as fs from 'fs';

/**
 * A session counts as live while its file changed this recently. Matches the
 * session list's activity window so every view agrees on "Live".
 */
export const SESSION_LIVE_WINDOW_MS = 2 * 60 * 1000;

export type SessionLiveness = 'live' | 'viewing' | 'none';

/** Display labels for {@link SessionLiveness}. */
export const SESSION_LIVENESS_LABELS: Record<SessionLiveness, string> = {
  live: 'Live',
  viewing: 'Viewing',
  none: 'No session',
};

interface MetadataSource {
  getSessionMetadata?(sessionPath: string): { mtime: Date } | null;
}

interface LivenessSource {
  isActive(): boolean;
  getSessionPath(): string | null;
  getProvider(): MetadataSource;
}

/** Last-modified time of a session (DB-backed providers use synthetic paths). */
export function sessionMtimeMs(sessionPath: string, provider?: MetadataSource): number | null {
  try {
    return fs.statSync(sessionPath).mtimeMs;
  } catch {
    const meta = provider?.getSessionMetadata?.(sessionPath);
    return meta ? meta.mtime.getTime() : null;
  }
}

/** Classifies the monitor's attached session as live, viewing, or none. */
export function getSessionLiveness(monitor: LivenessSource, now = Date.now()): SessionLiveness {
  const sessionPath = monitor.getSessionPath();
  if (!monitor.isActive() || !sessionPath) return 'none';
  const mtime = sessionMtimeMs(sessionPath, monitor.getProvider());
  return mtime !== null && now - mtime < SESSION_LIVE_WINDOW_MS ? 'live' : 'viewing';
}
