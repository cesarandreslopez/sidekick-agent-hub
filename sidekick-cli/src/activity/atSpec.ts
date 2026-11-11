/**
 * `sidekick map --at <time>`: the moment of a session to show.
 *
 * | Form                  | Meaning                                              |
 * | --------------------- | ---------------------------------------------------- |
 * | `end` (default), `now` | the last record                                     |
 * | `start`               | the first record                                     |
 * | `+15m`, `+1h30m`, `+90s` | that long after the session started               |
 * | `-5m`                 | that long before the session ended                   |
 * | `50%`                 | that fraction of the way through                     |
 * | `14:03`, `14:03:20`   | that local time on the session's first day (the next |
 * |                       | day when the session crossed midnight and the time   |
 * |                       | would fall before it started)                        |
 * | ISO 8601 date-time    | that exact moment                                    |
 *
 * A bare `15m` is rejected: elsewhere in the CLI (`--since 15m`) it means
 * "fifteen minutes ago", which is not what a position inside a session means.
 */

export type AtSpec =
  | { kind: 'end' }
  | { kind: 'start' }
  | { kind: 'offset'; from: 'start' | 'end'; ms: number }
  | { kind: 'fraction'; value: number }
  | { kind: 'clock'; hours: number; minutes: number; seconds: number }
  | { kind: 'absolute'; ms: number };

const UNIT_MS: Record<string, number> = {
  ms: 1,
  s: 1_000,
  sec: 1_000,
  m: 60_000,
  min: 60_000,
  h: 3_600_000,
  hr: 3_600_000,
  d: 86_400_000,
};

const OFFSET_RE = /^([+-])((?:\d+(?:\.\d+)?\s*(?:ms|sec|s|min|m|hr|h|d)\s*)+)$/i;
const OFFSET_PART_RE = /(\d+(?:\.\d+)?)\s*(ms|sec|s|min|m|hr|h|d)/gi;
const BARE_DURATION_RE = /^\d+(?:\.\d+)?\s*(?:ms|sec|s|min|m|hr|h|d)$/i;
const CLOCK_RE = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/;
const PERCENT_RE = /^(\d+(?:\.\d+)?)%$/;

function sumOffset(body: string): number {
  let total = 0;
  OFFSET_PART_RE.lastIndex = 0;
  let part: RegExpExecArray | null;
  while ((part = OFFSET_PART_RE.exec(body)) !== null) {
    total += Number(part[1]) * UNIT_MS[part[2].toLowerCase()];
  }
  return total;
}

/** Parses an `--at` value; throws `RangeError` with a hint when it is not one of the forms. */
export function parseAtSpec(value: string): AtSpec {
  const text = value.trim();
  const lower = text.toLowerCase();
  if (lower === '' || lower === 'end' || lower === 'now') return { kind: 'end' };
  if (lower === 'start') return { kind: 'start' };

  const offset = OFFSET_RE.exec(text);
  if (offset) {
    return { kind: 'offset', from: offset[1] === '+' ? 'start' : 'end', ms: sumOffset(offset[2]) };
  }
  if (BARE_DURATION_RE.test(text)) {
    throw new RangeError(
      `Ambiguous --at "${value}": use +${text} (after the start) or -${text} (before the end)`,
    );
  }

  const percent = PERCENT_RE.exec(text);
  if (percent) {
    const fraction = Number(percent[1]) / 100;
    if (fraction > 1) throw new RangeError(`--at "${value}" is more than 100%`);
    return { kind: 'fraction', value: fraction };
  }

  const clock = CLOCK_RE.exec(text);
  if (clock) {
    const hours = Number(clock[1]);
    const minutes = Number(clock[2]);
    const seconds = clock[3] === undefined ? 0 : Number(clock[3]);
    if (hours > 23 || minutes > 59 || seconds > 59) {
      throw new RangeError(`--at "${value}" is not a valid time of day`);
    }
    return { kind: 'clock', hours, minutes, seconds };
  }

  // A date and a time (anything Date.parse accepts that has a date part).
  if (/\d{4}-\d{2}-\d{2}/.test(text)) {
    const ms = Date.parse(text);
    if (Number.isFinite(ms)) return { kind: 'absolute', ms };
  }

  throw new RangeError(
    `Invalid --at "${value}": use end, start, +15m, -5m, 50%, HH:MM[:SS], or an ISO date-time`,
  );
}

export interface ResolvedAt {
  /** Epoch ms inside [startMs, endMs]. */
  at: number;
  /** The spec pointed outside the session and was moved to its nearest end. */
  clamped: boolean;
}

/** Resolves a spec against a session's first and last record times. */
export function resolveAt(spec: AtSpec, range: { startMs: number; endMs: number }): ResolvedAt {
  const { startMs, endMs } = range;
  let at: number;
  switch (spec.kind) {
    case 'end':
      return { at: endMs, clamped: false };
    case 'start':
      return { at: startMs, clamped: false };
    case 'offset':
      at = spec.from === 'start' ? startMs + spec.ms : endMs - spec.ms;
      break;
    case 'fraction':
      at = startMs + (endMs - startMs) * spec.value;
      break;
    case 'clock': {
      const day = new Date(startMs);
      day.setHours(spec.hours, spec.minutes, spec.seconds, 0);
      at = day.getTime();
      // A time before the session started belongs to the next day when the
      // session crossed midnight.
      if (at < startMs && at + 86_400_000 <= endMs) at += 86_400_000;
      break;
    }
    case 'absolute':
      at = spec.ms;
      break;
  }
  if (at < startMs) return { at: startMs, clamped: true };
  if (at > endMs) return { at: endMs, clamped: true };
  return { at: Math.round(at), clamped: false };
}
