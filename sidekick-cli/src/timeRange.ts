/**
 * Parse the `--since` / `--until` values the report commands accept.
 *
 * Accepts a relative window (`90m`, `24h`, `7d`, `2w`), a local calendar day
 * (`YYYY-MM-DD`, midnight local time), or anything `Date.parse` understands.
 */

import { parseLocalDateKey } from 'sidekick-shared';

const RELATIVE_WINDOW = /^(\d+(?:\.\d+)?)\s*(m|min|mins|h|hr|hrs|d|day|days|w|wk|wks)$/i;

const UNIT_MS: Record<string, number> = {
  m: 60_000,
  min: 60_000,
  mins: 60_000,
  h: 3_600_000,
  hr: 3_600_000,
  hrs: 3_600_000,
  d: 86_400_000,
  day: 86_400_000,
  days: 86_400_000,
  w: 7 * 86_400_000,
  wk: 7 * 86_400_000,
  wks: 7 * 86_400_000,
};

/** Resolve a user-supplied time; throws `RangeError` for anything unparseable. */
export function parseTimeOption(value: string, now: Date = new Date()): Date {
  const trimmed = value.trim();
  const relative = RELATIVE_WINDOW.exec(trimmed);
  if (relative) {
    const amount = Number(relative[1]);
    const unit = UNIT_MS[relative[2].toLowerCase()];
    return new Date(now.getTime() - amount * unit);
  }
  const day = parseLocalDateKey(trimmed);
  if (day) return day;
  const ms = Date.parse(trimmed);
  if (Number.isFinite(ms)) return new Date(ms);
  throw new RangeError(
    `Invalid time "${value}": use an ISO date, YYYY-MM-DD, or a relative window such as 7d, 24h, or 90m`,
  );
}
