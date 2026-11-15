/**
 * Compact number formatting for the dashboard webview: headline values and
 * axis ticks use `12.3k` / `4.5M` (the shared `formatTokenCount` vocabulary,
 * lowercase `k`), with the exact figure kept for tooltips.
 *
 * @module webview/dashboard/format
 */

import { formatTokenCount } from 'sidekick-shared/browser';

/** `950`, `12.3k`, `4.5M`; values that would round to `1000.0k` read `1.0M`. */
export function compactNumber(value: number): string {
  if (!Number.isFinite(value)) return '0';
  const abs = Math.abs(value);
  if (abs >= 999_950 && abs < 1_000_000) {
    return `${value < 0 ? '-' : ''}1.0M`;
  }
  return formatTokenCount(value);
}

/** `1,234,567` — the exact figure, for `title` attributes. */
export function exactNumber(value: number): string {
  return Number.isFinite(value) ? Math.round(value).toLocaleString('en-US') : '0';
}

/** Short dollar amount for chart axes: `$0`, `$0.25`, `$12`, `$1.2k`. */
export function axisCost(value: number): string {
  if (!Number.isFinite(value) || value === 0) return '$0';
  const abs = Math.abs(value);
  const sign = value < 0 ? '-' : '';
  if (abs >= 1000) return `${sign}$${compactNumber(abs)}`;
  if (abs >= 10) return `${sign}$${Math.round(abs)}`;
  return `${sign}$${abs.toFixed(2).replace(/\.?0+$/, '') || '0'}`;
}

/** Duration stops counting once the newest event is this old (the session is idle). */
export const SESSION_IDLE_AFTER_MS = 5 * 60_000;

/**
 * Session duration text (`12m`, `1h 4m`): start to now while live, start to
 * the last event once idle for {@link SESSION_IDLE_AFTER_MS}, so a past or
 * idle session stops counting.
 */
export function sessionDurationText(
  startIso: string | null | undefined,
  lastActivityIso: string | null | undefined,
  now: number = Date.now(),
): string {
  const start = startIso ? Date.parse(startIso) : NaN;
  if (!Number.isFinite(start)) return '0m';
  const last = lastActivityIso ? Date.parse(lastActivityIso) : NaN;
  const end = Number.isFinite(last) && now - last > SESSION_IDLE_AFTER_MS ? last : now;
  const minutes = Math.max(0, Math.floor((end - start) / 60_000));
  const hours = Math.floor(minutes / 60);
  return hours > 0 ? `${hours}h ${minutes % 60}m` : `${minutes}m`;
}

/** Words too common to say anything about a session. */
const STOPWORDS = new Set(
  (
    'the and for with that this from into onto then than they them their there these those ' +
    "was were are is be been being have has had not but you your our its it's all any can " +
    'will would should could just also only out over under about after before when where ' +
    'which while what who how why each per via use used using file files tool tools call ' +
    'calls result results'
  ).split(/\s+/),
);

/**
 * The top `limit` entries of a word-frequency list with stopwords (and
 * one- or two-letter words) removed. Filtering happens before slicing so the
 * chart still shows `limit` meaningful words.
 */
export function frequentWords(
  words: ReadonlyArray<{ name: string; count: number }> | null | undefined,
  limit: number,
): Array<{ name: string; count: number }> {
  return (words ?? [])
    .filter((word) => word.name.length > 2 && !STOPWORDS.has(word.name.toLowerCase()))
    .slice(0, limit);
}

/** `1 file` / `3 files`. */
export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

const STATUS_LABELS: Record<string, string> = {
  in_progress: 'In Progress',
  completed: 'Completed',
  pending: 'Pending',
  failed: 'Failed',
  deleted: 'Deleted',
  skipped: 'Skipped',
  blocked: 'Blocked',
  cancelled: 'Cancelled',
};

/** Human label for a raw task status: `in_progress` → `In Progress`. */
export function statusLabel(status: string): string {
  if (STATUS_LABELS[status]) return STATUS_LABELS[status];
  return status
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}
