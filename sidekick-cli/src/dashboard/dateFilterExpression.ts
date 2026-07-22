/**
 * Date filter expression parser for the dashboard's Date filter mode.
 *
 * Grammar (case-insensitive, whitespace-trimmed):
 *   today          items from local midnight today onward
 *   yesterday      items within yesterday (local midnights)
 *   Nh / Nd / Nw   items within the last N hours / days / weeks
 *   YYYY-MM-DD     items within that local calendar day
 *   >expr          items after expr ends (e.g. >2026-06-01, >yesterday)
 *   <expr          items before expr starts (e.g. <2026-06-01, <2d = older
 *                  than two days)
 *
 * Emits pre-computed ISO bounds ({ since?, until? }) — the same shape
 * sidekick-shared's FilterEngine.matchDate consumes — so the grammar can
 * migrate to the shared package without reshaping its output.
 */

export interface DateBounds {
  since?: string;
  until?: string;
}

export interface DateParseError {
  error: string;
}

interface BaseRange {
  start: Date;
  end?: Date;
}

const RELATIVE_RE = /^(\d+)([hdw])$/;
const ISO_DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

const UNIT_MS: Record<string, number> = {
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
  w: 7 * 24 * 60 * 60 * 1000,
};

const GRAMMAR_HINT = 'use today, yesterday, 2d, 1w, YYYY-MM-DD, >expr, or <expr';

function startOfLocalDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function addDays(d: Date, days: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + days);
}

/** Parse a YYYY-MM-DD value as local midnight rather than UTC midnight. */
export function localDateOnlyTimestamp(value: string): number | null {
  const match = ISO_DAY_RE.exec(value);
  if (!match) return null;
  const year = parseInt(match[1], 10);
  const month = parseInt(match[2], 10);
  const day = parseInt(match[3], 10);
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    return null;
  }
  return date.getTime();
}

/** Resolve a base (unprefixed) expression to a local time range. */
function resolveBase(expr: string, now: Date): BaseRange | null {
  if (expr === 'today') {
    return { start: startOfLocalDay(now) };
  }
  if (expr === 'yesterday') {
    const todayStart = startOfLocalDay(now);
    return { start: addDays(todayStart, -1), end: todayStart };
  }

  const rel = RELATIVE_RE.exec(expr);
  if (rel) {
    const amount = parseInt(rel[1], 10);
    return { start: new Date(now.getTime() - amount * UNIT_MS[rel[2]]) };
  }

  const iso = ISO_DAY_RE.exec(expr);
  if (iso) {
    const year = parseInt(iso[1], 10);
    const month = parseInt(iso[2], 10);
    const day = parseInt(iso[3], 10);
    const start = new Date(year, month - 1, day);
    // Reject dates that roll over (e.g. 2026-13-40)
    if (start.getFullYear() !== year || start.getMonth() !== month - 1 || start.getDate() !== day) {
      return null;
    }
    return { start, end: addDays(start, 1) };
  }

  return null;
}

/**
 * Parse a date filter expression into ISO bounds, or an error message for
 * display in the filter overlay. `now` is injectable for tests.
 */
export function parseDateExpression(
  expr: string,
  now: Date = new Date(),
): DateBounds | DateParseError {
  const trimmed = expr.trim().toLowerCase();
  if (!trimmed) return { error: `Empty date filter — ${GRAMMAR_HINT}` };

  const op = trimmed[0] === '>' || trimmed[0] === '<' ? trimmed[0] : null;
  const base = resolveBase(op ? trimmed.slice(1).trim() : trimmed, now);
  if (!base) return { error: `Invalid date filter — ${GRAMMAR_HINT}` };

  if (op === '>') {
    // After the expression's range ends (falls back to its start when the
    // range is open-ended, e.g. >today).
    return { since: (base.end ?? base.start).toISOString() };
  }
  if (op === '<') {
    // Before the expression's range starts.
    return { until: base.start.toISOString() };
  }
  return {
    since: base.start.toISOString(),
    ...(base.end ? { until: base.end.toISOString() } : {}),
  };
}

/**
 * Extract an epoch-ms timestamp from a panel item's data payload, trying the
 * same fields the session filter matches on: explicit createdAt/timestamp
 * ISO strings first, then the leading YYYY-MM-DD of session identifiers.
 * Returns null when the item carries no recognizable timestamp.
 */
export function itemTimestampMs(data: unknown): number | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;

  for (const field of ['createdAt', 'timestamp']) {
    const value = d[field];
    if (typeof value === 'string') {
      const ms = Date.parse(value);
      if (!Number.isNaN(ms)) return ms;
    }
  }

  for (const field of ['sessionOrigin', 'sessionId']) {
    const value = d[field];
    if (typeof value === 'string') {
      const match = /^\d{4}-\d{2}-\d{2}/.exec(value);
      if (match) {
        const ms = localDateOnlyTimestamp(match[0]);
        if (ms !== null) return ms;
      }
    }
  }

  return null;
}
