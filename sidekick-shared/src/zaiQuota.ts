/**
 * Deprecated stateless quota accumulator for z.ai coding plans.
 *
 * This estimator is kept for compatibility with consumers that imported the
 * old helpers directly. Product code should use `zaiQuotaApi.ts`, which calls
 * z.ai's authoritative quota endpoint. The legacy estimator only uses:
 *
 *   1. Per-call token `usage` returned inline on each chat completion —
 *      which OpenCode persists into `opencode.db` message rows tagged with
 *      `providerID ∈ {"zai", "zai-coding-plan"}`.
 *   2. Business error codes (`1308` / `1310` / `1313` / `1309`) returned
 *      when a limit is actually hit, with `${next_flush_time}` embedded
 *      in the human-readable message text.
 *
 * This module is therefore a **derivation** rather than a fetcher: callers
 * feed it observed assistant turns (and any error events), and it computes a
 * compatibility `QuotaState` keyed against the published per-tier budgets.
 *
 * Polling / eventing / persistence are the caller's responsibility —
 * see `ZaiQuotaWatcher` for the bundled watcher.
 */
import type { QuotaState, QuotaWindow } from './quota';

// ── Tier budgets ──

/**
 * Published z.ai coding-plan prompt budgets.
 *
 * Source: https://docs.z.ai/devpack/overview & /devpack/faq.
 * "One prompt ≈ one query; each prompt is estimated to invoke the model
 * 15–20 times." We use the midpoint (17.5) when converting observed
 * assistant turns into prompt equivalents.
 */
export const ZAI_TIER_BUDGETS = {
  lite: { fiveHour: 80, weekly: 400 },
  pro: { fiveHour: 400, weekly: 2000 },
  max: { fiveHour: 1600, weekly: 8000 },
} as const satisfies Record<ZaiTier, { fiveHour: number; weekly: number }>;

export type ZaiTier = 'lite' | 'pro' | 'max';

/**
 * Midpoint of z.ai's documented "15–20 model invocations per prompt" range.
 * Used to convert accumulated assistant turns into prompt equivalents.
 * Calibration note: this constant may need per-tier adjustment after
 * real-world validation against the z.ai web UI.
 */
export const ZAI_PROMPT_INVOCATIONS = 17.5;

const FIVE_HOUR_MS = 5 * 3_600_000;
const SEVEN_DAY_MS = 7 * 86_400_000;

/**
 * Provider IDs that OpenCode tags on z.ai-routed messages.
 * `zai-coding-plan` is the Coding Plan key; `zai` is the bare API key.
 */
export const ZAI_PROVIDER_IDS = ['zai', 'zai-coding-plan'] as const;
export type ZaiProviderId = (typeof ZAI_PROVIDER_IDS)[number];

export function isZaiProviderId(value: unknown): value is ZaiProviderId {
  return value === 'zai' || value === 'zai-coding-plan';
}

// ── Assistant-turn input shape ──

/**
 * Minimal description of a z.ai-routed assistant turn needed to accumulate
 * usage. Mirrors the fields OpenCode already extracts via its parser
 * (`openCodeParser.ts:346-357`). Tokens are Anthropic-style for cross-
 * provider comparability; cost is omitted (always 0 for z.ai).
 *
 * `timestampMs` is when the assistant turn completed (epoch milliseconds).
 */
export interface ZaiAssistantTurn {
  timestampMs: number;
  model?: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
}

// ── Accumulated usage ──

export interface ZaiAccumulatedUsage {
  /** Number of z.ai assistant turns inside the 5-hour window. */
  fiveHourTurns: number;
  /** Number of z.ai assistant turns inside the 7-day window. */
  weeklyTurns: number;
  /** Sum of token fields across the 5-hour window. */
  fiveHourTokens: number;
  /** Sum of token fields across the 7-day window. */
  weeklyTokens: number;
  /** Estimated prompts consumed in the 5-hour window (turns / 17.5). */
  fiveHourPrompts: number;
  /** Estimated prompts consumed in the 7-day window (turns / 17.5). */
  weeklyPrompts: number;
  /** Earliest turn timestamp inside the 5-hour window (epoch ms), or null. */
  fiveHourStartedAtMs: number | null;
  /** Earliest turn timestamp inside the 7-day window (epoch ms), or null. */
  weeklyStartedAtMs: number | null;
}

/**
 * Sums the token fields of a single turn into a scalar.
 * Cache reads are weighted at 0.1× (Anthropic convention) to avoid
 * over-counting repeated context. Output and reasoning tokens are weighted 1×.
 */
export function turnTokenWeight(
  turn: Pick<
    ZaiAssistantTurn,
    'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheWriteTokens' | 'reasoningTokens'
  >,
): number {
  return (
    turn.inputTokens +
    turn.outputTokens +
    Math.round(turn.cacheReadTokens * 0.1) +
    turn.cacheWriteTokens +
    (turn.reasoningTokens || 0)
  );
}

/**
 * Reduces a stream of z.ai-routed assistant turns into rolling-window usage.
 *
 * Pure & stateless: the caller is responsible for passing the relevant turns.
 * Turns outside the 7-day window are ignored; turns inside the 7-day window
 * but outside the 5-hour window still count toward weekly usage.
 */
export function accumulateZaiUsage(
  turns: readonly ZaiAssistantTurn[],
  nowMs: number = Date.now(),
): ZaiAccumulatedUsage {
  const fiveHourCutoff = nowMs - FIVE_HOUR_MS;
  const weeklyCutoff = nowMs - SEVEN_DAY_MS;

  let fiveHourTurns = 0;
  let weeklyTurns = 0;
  let fiveHourTokens = 0;
  let weeklyTokens = 0;
  let fiveHourStartedAtMs: number | null = null;
  let weeklyStartedAtMs: number | null = null;

  for (const turn of turns) {
    if (turn.timestampMs < weeklyCutoff) continue;
    weeklyTurns += 1;
    weeklyTokens += turnTokenWeight(turn);
    if (weeklyStartedAtMs === null || turn.timestampMs < weeklyStartedAtMs) {
      weeklyStartedAtMs = turn.timestampMs;
    }

    if (turn.timestampMs >= fiveHourCutoff) {
      fiveHourTurns += 1;
      fiveHourTokens += turnTokenWeight(turn);
      if (fiveHourStartedAtMs === null || turn.timestampMs < fiveHourStartedAtMs) {
        fiveHourStartedAtMs = turn.timestampMs;
      }
    }
  }

  return {
    fiveHourTurns,
    weeklyTurns,
    fiveHourTokens,
    weeklyTokens,
    fiveHourPrompts: fiveHourTurns / ZAI_PROMPT_INVOCATIONS,
    weeklyPrompts: weeklyTurns / ZAI_PROMPT_INVOCATIONS,
    fiveHourStartedAtMs,
    weeklyStartedAtMs,
  };
}

// ── Tier resolution ──

/**
 * Resolves the effective z.ai tier when the user has selected `'auto'`.
 *
 * Heuristic: if accumulated weekly prompts already exceed a tier's budget,
 * the user must be on a higher tier. This under-detects at the start of a
 * weekly cycle (a Max user looks identical to a Lite user until they cross
 * 400 prompts/week), so callers should still expose an explicit override.
 */
export function resolveZaiTier(
  configured: ZaiTier | 'auto',
  accumulated: ZaiAccumulatedUsage,
): ZaiTier {
  if (configured !== 'auto') return configured;

  if (accumulated.weeklyPrompts > ZAI_TIER_BUDGETS.pro.weekly) return 'max';
  if (accumulated.weeklyPrompts > ZAI_TIER_BUDGETS.lite.weekly) return 'pro';
  return 'lite';
}

// ── Quota-state inference ──

export interface InferZaiQuotaStateOptions {
  /** ISO timestamp to stamp on the sample. Default: now. */
  capturedAt?: string;
  /** Mark the sample stale when the windows aren't fully observed yet. */
  stale?: boolean;
  /** Authoritative reset timestamp from a trapped 1308/1310 error. */
  authoritativeFiveHourResetAt?: string;
  authoritativeWeeklyResetAt?: string;
}

/**
 * Converts accumulated usage into a shared `QuotaState`.
 *
 * The two windows reuse the `fiveHour` / `sevenDay` field names for cross-
 * provider compatibility, but are labeled "5-Hour" and "Weekly" via
 * `fiveHourLabel` / `sevenDayLabel` — mirroring how Codex relabels its
 * generic primary/secondary windows.
 *
 * Reset timestamps are best-effort because z.ai does not expose them:
 *   - `fiveHour.resetsAt` ← first turn in window + 5h, unless an error
 *     event supplied an authoritative reset.
 *   - `sevenDay.resetsAt` ← first turn in window + 7d (documented as
 *     "7 days from order time" — order time is unknown, so this is a
 *     lower bound at best).
 */
export function inferZaiQuotaState(
  accumulated: ZaiAccumulatedUsage,
  tier: ZaiTier,
  options: InferZaiQuotaStateOptions = {},
): QuotaState {
  const budget = ZAI_TIER_BUDGETS[tier];
  const capturedAt = options.capturedAt ?? new Date().toISOString();

  const fiveHourUtil =
    budget.fiveHour > 0 ? Math.min((accumulated.fiveHourPrompts / budget.fiveHour) * 100, 200) : 0;
  const weeklyUtil =
    budget.weekly > 0 ? Math.min((accumulated.weeklyPrompts / budget.weekly) * 100, 200) : 0;

  const fiveHourResetsAt =
    options.authoritativeFiveHourResetAt ??
    (accumulated.fiveHourStartedAtMs !== null
      ? new Date(accumulated.fiveHourStartedAtMs + FIVE_HOUR_MS).toISOString()
      : '');
  const sevenDayResetsAt =
    options.authoritativeWeeklyResetAt ??
    (accumulated.weeklyStartedAtMs !== null
      ? new Date(accumulated.weeklyStartedAtMs + SEVEN_DAY_MS).toISOString()
      : '');

  const fiveHour: QuotaWindow = {
    utilization: Math.round(fiveHourUtil * 10) / 10,
    resetsAt: fiveHourResetsAt,
  };
  const sevenDay: QuotaWindow = {
    utilization: Math.round(weeklyUtil * 10) / 10,
    resetsAt: sevenDayResetsAt,
  };

  const hasAnyData = accumulated.fiveHourTurns > 0 || accumulated.weeklyTurns > 0;

  return {
    fiveHour,
    sevenDay,
    available: hasAnyData,
    providerId: 'zai',
    source: 'session',
    capturedAt,
    stale: options.stale ?? !hasAnyData,
    fiveHourLabel: '5-Hour',
    sevenDayLabel: 'Weekly',
    planType: tier,
    limitId: `zai-${tier}`,
    limitName: `z.ai ${tier.charAt(0).toUpperCase() + tier.slice(1)}`,
  };
}

// ── Error-code trapping ──

export type ZaiQuotaErrorKind = 'exhausted' | 'fup' | 'expired' | 'invalid';

export interface ZaiQuotaError {
  kind: ZaiQuotaErrorKind;
  /** ISO timestamp parsed from `${next_flush_time}` in the error message, if present. */
  resetsAt?: string;
  /** The raw business error code from z.ai. */
  code: string;
  /** Human-readable message. */
  message: string;
}

/**
 * z.ai business error codes that signal quota/plan state.
 * Source: https://docs.z.ai/api-reference/api-code
 */
const ZAI_ERROR_CODES: Record<string, ZaiQuotaErrorKind> = {
  '1308': 'exhausted', // Usage limit reached for `{number} {unit}` (includes next_flush_time)
  '1310': 'exhausted', // Weekly/Monthly limit exhausted (resets at next_flush_time)
  '1313': 'fup', // Fair-Use-Policy violation — request rate restricted
  '1309': 'expired', // GLM Coding Plan package has expired
};

/**
 * Extracts a z.ai quota error from a message-error payload, if present.
 *
 * The reset timestamp is embedded inside the human-readable `message` text
 * as `${next_flush_time}`. z.ai's docs interpolate the value into the
 * message string; we parse ISO datetimes, epoch seconds, and the literal
 * `YYYY-MM-DD HH:mm:ss` form defensively.
 *
 * Returns `null` when the code is not a quota-related business error.
 */
export function parseZaiQuotaError(error: {
  code?: string | number;
  message?: string;
  type?: string;
}): ZaiQuotaError | null {
  if (!error) return null;
  const code = String(error.code ?? '');
  const kind = ZAI_ERROR_CODES[code];
  if (!kind) return null;

  const message = error.message ?? '';
  const resetsAt = extractNextFlushTime(message);

  return { kind, resetsAt, code, message };
}

/**
 * Parses `${next_flush_time}` out of a z.ai error message.
 *
 * Handles ISO 8601 (`2025-01-31T14:00:00Z`), space-separated
 * (`2025-01-31 14:00:00`), and epoch-seconds (1234567890) forms.
 * Returns undefined when no parseable timestamp is found.
 */
export function extractNextFlushTime(message: string): string | undefined {
  if (!message) return undefined;

  // ISO 8601 with optional timezone.
  const isoMatch = message.match(
    /(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)/,
  );
  if (isoMatch) {
    const ms = Date.parse(isoMatch[1]);
    if (Number.isFinite(ms)) return new Date(ms).toISOString();
  }

  // `YYYY-MM-DD HH:mm:ss` (no T separator) — z.ai's likely interpolated form.
  const spaceMatch = message.match(/(\d{4}-\d{2}-\d{2}[ ]\d{2}:\d{2}:\d{2})/);
  if (spaceMatch) {
    const normalised = spaceMatch[1].replace(' ', 'T');
    const ms = Date.parse(`${normalised}Z`);
    if (Number.isFinite(ms)) return new Date(ms).toISOString();
  }

  // Epoch seconds — 10-digit integer in a plausible range.
  const epochMatch = message.match(/(?<!\d)(\d{10})(?!\d)/);
  if (epochMatch) {
    const seconds = Number(epochMatch[1]);
    if (seconds > 1_700_000_000 && seconds < 2_000_000_000) {
      return new Date(seconds * 1000).toISOString();
    }
  }

  return undefined;
}

// ── Unavailable state helper ──

/**
 * Builds an unavailable z.ai `QuotaState` for the cold-start case where
 * no z.ai traffic has been observed yet.
 */
export function makeUnavailableZaiQuotaState(
  error: string = 'No z.ai usage observed yet',
  tier: ZaiTier = 'lite',
  capturedAt: string = new Date().toISOString(),
): QuotaState {
  return {
    fiveHour: { utilization: 0, resetsAt: '' },
    sevenDay: { utilization: 0, resetsAt: '' },
    available: false,
    error,
    providerId: 'zai',
    source: 'session',
    capturedAt,
    stale: true,
    fiveHourLabel: '5-Hour',
    sevenDayLabel: 'Weekly',
    planType: tier,
  };
}

// ── OpenCode DB adapter ──

/**
 * Shape of a row returned by `OpenCodeDatabase.getAssistantMessagesByProviderId`.
 * Defined here to keep the sidekick-shared helper self-contained without
 * leaking the OpenCode db module into the public quota surface.
 */
export interface ZaiOpenCodeRow {
  timeCreated: number;
  modelId: string;
  providerId: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  errorMessage: string | null;
  errorCode: string | null;
}

/**
 * Converts raw OpenCode DB rows (filtered to z.ai providerIDs by the caller)
 * into the watcher's `ZaiAssistantTurn` shape, and surfaces any trapped
 * business errors.
 *
 * Returns `{ turns, errors }` so callers can replay them through
 * `ZaiQuotaWatcher.ingestAssistantTurns` and `ingestError`.
 */
export function rowsToZaiTurnsAndErrors(rows: readonly ZaiOpenCodeRow[]): {
  turns: ZaiAssistantTurn[];
  errors: ZaiQuotaError[];
} {
  const turns: ZaiAssistantTurn[] = [];
  const errors: ZaiQuotaError[] = [];

  for (const row of rows) {
    turns.push({
      timestampMs: row.timeCreated,
      model: row.modelId,
      inputTokens: row.inputTokens || 0,
      outputTokens: row.outputTokens || 0,
      cacheReadTokens: row.cacheReadTokens || 0,
      cacheWriteTokens: row.cacheWriteTokens || 0,
      reasoningTokens: row.reasoningTokens || 0,
    });

    if (row.errorCode != null || row.errorMessage) {
      const parsed = parseZaiQuotaError({
        code: row.errorCode ?? undefined,
        message: row.errorMessage ?? undefined,
      });
      if (parsed) errors.push(parsed);
    }
  }

  return { turns, errors };
}
