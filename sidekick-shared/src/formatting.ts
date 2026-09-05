/**
 * Pure display formatting helpers shared by CLI, extension host, webviews,
 * and downstream apps.
 *
 * This module intentionally has no Node-only imports.
 *
 * @module formatting
 */

export interface FormatTokenCountOptions {
  /** Suffix casing for thousands. Millions always use `M`. Defaults to `lower`. */
  suffixCase?: 'lower' | 'upper';
}

export interface FormatDurationMsOptions {
  /** `spaced`: `5m 30s`; `compact`: `5m30s`. Defaults to `spaced`. */
  style?: 'spaced' | 'compact';
  /** Render sub-second durations as `123ms` instead of `0.1s`. Defaults to false. */
  includeMilliseconds?: boolean;
  /** Decimal places for durations under one minute. Defaults to 0. */
  secondsFractionDigits?: number;
  /** Value to return for negative, non-finite, or otherwise invalid durations. */
  invalid?: string;
}

/** Format a token count with compact `k` / `M` suffixes. */
export function formatTokenCount(value: number, options: FormatTokenCountOptions = {}): string {
  if (!Number.isFinite(value)) return '0';
  const n = Math.trunc(value);
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  const thousandsSuffix = options.suffixCase === 'upper' ? 'K' : 'k';

  if (abs >= 1_000_000) return `${sign}${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${sign}${(abs / 1_000).toFixed(1)}${thousandsSuffix}`;
  return `${n}`;
}

/** Format an elapsed duration in milliseconds. */
export function formatDurationMs(ms: number, options: FormatDurationMsOptions = {}): string {
  const invalid = options.invalid ?? 'N/A';
  if (!Number.isFinite(ms) || ms < 0) return invalid;

  const style = options.style ?? 'spaced';
  const separator = style === 'compact' ? '' : ' ';
  const secondsFractionDigits = options.secondsFractionDigits ?? 0;

  if (ms < 1000) {
    if (options.includeMilliseconds) return `${Math.round(ms)}ms`;
    return `${(ms / 1000).toFixed(Math.max(1, secondsFractionDigits))}s`;
  }

  const seconds = ms / 1000;
  if (seconds < 60) {
    if (secondsFractionDigits > 0) return `${seconds.toFixed(secondsFractionDigits)}s`;
    return `${Math.floor(seconds)}s`;
  }

  const totalSeconds = Math.floor(seconds);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const remainingSeconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h${separator}${minutes}m${separator}${remainingSeconds}s`;
  }
  return `${minutes}m${separator}${remainingSeconds}s`;
}

/**
 * Calendar-date key (`YYYY-MM-DD`) in the machine's local time zone.
 *
 * Sidekick buckets "today", daily history, and heatmaps by the user's local
 * day, so every writer and reader of a date key goes through this helper.
 * A UTC key would move late-evening work onto the next day for anyone west
 * of Greenwich and onto the previous day for anyone east of it.
 */
export function formatLocalDateKey(value: Date | number = new Date()): string {
  const date = typeof value === 'number' ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return '';
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** Parse a `YYYY-MM-DD` key produced by `formatLocalDateKey` back into local midnight. */
export function parseLocalDateKey(key: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Shift a `YYYY-MM-DD` key by whole local days (DST-safe). */
export function addLocalDays(key: string, days: number): string {
  const date = parseLocalDateKey(key);
  if (!date) return key;
  return formatLocalDateKey(new Date(date.getFullYear(), date.getMonth(), date.getDate() + days));
}
