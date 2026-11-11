/**
 * Small text formatters for the Activity Map webview.
 *
 * @module webview/activityMap/format
 */

/** `850ms`, `4.2s`, `3m12s`, `1h04m`. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '';
  if (ms < 1000) return `${Math.max(1, Math.round(ms))}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const totalSeconds = Math.round(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h${String(minutes).padStart(2, '0')}m`;
  return `${minutes}m${String(seconds).padStart(2, '0')}s`;
}

/** Wall-clock time, `HH:MM:SS`. */
export function formatClock(at: number): string {
  const date = new Date(at);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** `+14m02s` from the session start. */
export function formatOffset(ms: number): string {
  if (!Number.isFinite(ms)) return '';
  return `+${formatDuration(Math.max(0, ms)) || '0s'}`;
}

/** `12.3k` style counts. */
export function formatCount(value: number): string {
  if (value < 1000) return String(value);
  if (value < 10_000) return `${(value / 1000).toFixed(1)}k`;
  return `${Math.round(value / 1000)}k`;
}
