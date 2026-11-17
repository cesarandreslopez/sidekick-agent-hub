/**
 * When a session counts as live in the terminal dashboard.
 *
 * The same two-minute rule the VS Code extension uses
 * (`sidekick-vscode/src/utils/sessionLiveness.ts`): a session whose file was
 * written within the window is Live, anything older is a past session being
 * viewed. Kept local to the CLI rather than exported from `sidekick-shared`;
 * change both together.
 */
export const SESSION_LIVE_WINDOW_MS = 2 * 60_000;

/** True when `lastActivity` falls within the live window of `now`. */
export function isWithinLiveWindow(lastActivity: Date | number, now: Date | number): boolean {
  const last = typeof lastActivity === 'number' ? lastActivity : lastActivity.getTime();
  const current = typeof now === 'number' ? now : now.getTime();
  return Number.isFinite(last) && current - last < SESSION_LIVE_WINDOW_MS;
}
