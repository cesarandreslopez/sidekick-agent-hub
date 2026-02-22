/**
 * Shared formatting utilities for the TUI dashboard.
 * Consolidates duplicated helpers from panels and MindMapBuilder.
 */

/** Shorten a file path to show only the last 3 segments. */
export function shortenPath(p: string): string {
  const parts = p.replace(/\\/g, '/').split('/');
  if (parts.length <= 3) return p;
  return '.../' + parts.slice(-3).join('/');
}

/** Format a number with K/M suffixes. */
export function fmtNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString();
}

/** Format a duration in ms to a human-readable string. */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const secs = ms / 1000;
  if (secs < 60) return `${secs.toFixed(1)}s`;
  const mins = Math.floor(secs / 60);
  const remSecs = Math.floor(secs % 60);
  return `${mins}m${remSecs}s`;
}

/** Truncate text to maxLength, appending "..." if truncated. */
export function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.substring(0, maxLength - 3) + '...';
}

/** Format a timestamp to HH:MM:SS. */
export function formatTime(ts: string): string {
  try {
    const d = new Date(ts);
    return d.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch { return '??:??:??'; }
}

/** Format elapsed time from a start timestamp. */
export function formatElapsed(startTime: string): string {
  const start = new Date(startTime).getTime();
  const diffMs = Date.now() - start;
  if (isNaN(diffMs) || diffMs < 0) return '--:--:--';
  const secs = Math.floor(diffMs / 1000);
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/** Build a progress bar of given width. */
export function makeBar(percent: number, width: number): string {
  const clamped = Math.max(0, Math.min(100, percent));
  const filled = Math.round((clamped / 100) * width);
  return '\u2588'.repeat(filled) + '\u2591'.repeat(width - filled);
}

/** Estimate the detail pane width (terminal minus side panel and borders). */
export function detailWidth(): number {
  return Math.max(40, (process.stdout.columns || 120) - 30);
}

/** Word-wrap plain text to a given column width, preserving existing line breaks. */
export function wordWrap(text: string, width: number): string {
  return text.split('\n').map(line => {
    if (line.length <= width) return line;
    const words = line.split(' ');
    const wrapped: string[] = [];
    let current = '';
    for (const word of words) {
      if (current.length === 0) {
        current = word;
      } else if (current.length + 1 + word.length <= width) {
        current += ' ' + word;
      } else {
        wrapped.push(current);
        current = word;
      }
    }
    if (current) wrapped.push(current);
    return wrapped.join('\n');
  }).join('\n');
}
