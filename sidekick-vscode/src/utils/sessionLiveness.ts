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
  if (!monitor.isActive()) return 'none';
  const sessionPath = monitor.getSessionPath();
  if (!sessionPath) return 'none';
  const mtime = sessionMtimeMs(sessionPath, monitor.getProvider());
  return mtime !== null && now - mtime < SESSION_LIVE_WINDOW_MS ? 'live' : 'viewing';
}

/** How often sidebar views re-check liveness; matches the dashboard's tick. */
export const LIVENESS_TICK_MS = 30_000;

/**
 * Re-checks liveness on a fixed tick, so "Live" decays to "Viewing" when a
 * session simply goes quiet: no monitor event fires for that.
 *
 * The callback decides what to do (each view compares the fresh label with
 * the one it last posted and skips hidden views). `start()` is idempotent, so
 * a re-resolved view never stacks timers; call `stop()` from the view's
 * dispose handlers.
 */
export class LivenessTicker {
  private _timer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly _tick: () => void,
    private readonly _intervalMs = LIVENESS_TICK_MS,
  ) {}

  start(): void {
    this.stop();
    this._timer = setInterval(() => this._tick(), this._intervalMs);
  }

  stop(): void {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = undefined;
    }
  }

  get running(): boolean {
    return this._timer !== undefined;
  }
}
