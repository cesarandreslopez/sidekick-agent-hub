/**
 * Parser for the JSON Claude Code pipes to its status-line command.
 *
 * Claude Code runs the configured `statusLine.command` after every response
 * (debounced at 300 ms) with a JSON document on stdin describing the session:
 * model, workspace, context-window usage, estimated session cost, and — for
 * Claude.ai Pro and Max subscribers — the *official* five-hour and seven-day
 * rate-limit windows. That last block is the same data `/usage` shows and
 * needs no network call, so Sidekick treats it as its most authoritative
 * quota source whenever the status line is installed.
 *
 * Only the fields Sidekick reads are typed here; the raw document is kept on
 * `raw` for callers that need more. Browser-safe: no Node imports.
 *
 * @module statusline/claudeStatuslinePayload
 */

import type { QuotaState } from '../quota';

/** One official rate-limit window. */
export interface ClaudeStatuslineRateLimitWindow {
  /** Percentage of the window consumed, 0–100 (spend limits may exceed 100). */
  usedPercentage: number;
  /** Unix epoch seconds when the window resets. */
  resetsAt: number;
}

export interface ClaudeStatuslinePayload {
  sessionId?: string;
  transcriptPath?: string;
  cwd?: string;
  model?: { id?: string; displayName?: string };
  workspace?: { currentDir?: string; projectDir?: string; gitWorktree?: string };
  contextWindow?: {
    usedPercentage?: number | null;
    remainingPercentage?: number | null;
    contextWindowSize?: number;
    totalInputTokens?: number;
    totalOutputTokens?: number;
  };
  cost?: {
    totalCostUsd?: number;
    totalDurationMs?: number;
    totalApiDurationMs?: number;
    totalLinesAdded?: number;
    totalLinesRemoved?: number;
  };
  rateLimits?: {
    fiveHour?: ClaudeStatuslineRateLimitWindow;
    sevenDay?: ClaudeStatuslineRateLimitWindow;
    spendLimit?: ClaudeStatuslineRateLimitWindow;
  };
  promptCache?: {
    warm?: boolean;
    cachingObserved?: boolean;
    hitRatio?: number | null;
    requests?: number;
    misses?: number;
    expectedRebuilds?: number;
  };
  /** The parsed document as received. */
  raw: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function nullableNum(value: unknown): number | null | undefined {
  if (value === null) return null;
  return num(value);
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function bool(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function window(value: unknown): ClaudeStatuslineRateLimitWindow | undefined {
  if (!isRecord(value)) return undefined;
  const usedPercentage = num(value.used_percentage);
  const resetsAt = num(value.resets_at);
  if (usedPercentage === undefined || resetsAt === undefined) return undefined;
  return { usedPercentage, resetsAt };
}

function defined<T extends object>(value: T): T | undefined {
  return Object.values(value).some((entry) => entry !== undefined) ? value : undefined;
}

/**
 * Parse a status-line document. Returns `null` for empty input, non-JSON, or
 * JSON that is not an object; never throws.
 */
export function parseClaudeStatuslinePayload(text: string): ClaudeStatuslinePayload | null {
  if (typeof text !== 'string' || !text.trim()) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(raw)) return null;

  const model = isRecord(raw.model) ? raw.model : undefined;
  const workspace = isRecord(raw.workspace) ? raw.workspace : undefined;
  const contextWindow = isRecord(raw.context_window) ? raw.context_window : undefined;
  const cost = isRecord(raw.cost) ? raw.cost : undefined;
  const rateLimits = isRecord(raw.rate_limits) ? raw.rate_limits : undefined;
  const promptCache = isRecord(raw.prompt_cache) ? raw.prompt_cache : undefined;

  return {
    sessionId: str(raw.session_id),
    transcriptPath: str(raw.transcript_path),
    cwd: str(raw.cwd),
    model: model ? defined({ id: str(model.id), displayName: str(model.display_name) }) : undefined,
    workspace: workspace
      ? defined({
          currentDir: str(workspace.current_dir),
          projectDir: str(workspace.project_dir),
          gitWorktree: str(workspace.git_worktree),
        })
      : undefined,
    contextWindow: contextWindow
      ? defined({
          usedPercentage: nullableNum(contextWindow.used_percentage),
          remainingPercentage: nullableNum(contextWindow.remaining_percentage),
          contextWindowSize: num(contextWindow.context_window_size),
          totalInputTokens: num(contextWindow.total_input_tokens),
          totalOutputTokens: num(contextWindow.total_output_tokens),
        })
      : undefined,
    cost: cost
      ? defined({
          totalCostUsd: num(cost.total_cost_usd),
          totalDurationMs: num(cost.total_duration_ms),
          totalApiDurationMs: num(cost.total_api_duration_ms),
          totalLinesAdded: num(cost.total_lines_added),
          totalLinesRemoved: num(cost.total_lines_removed),
        })
      : undefined,
    rateLimits: rateLimits
      ? defined({
          fiveHour: window(rateLimits.five_hour),
          sevenDay: window(rateLimits.seven_day),
          spendLimit: window(rateLimits.spend_limit),
        })
      : undefined,
    promptCache: promptCache
      ? defined({
          warm: bool(promptCache.warm),
          cachingObserved: bool(promptCache.caching_observed),
          hitRatio: nullableNum(promptCache.hit_ratio),
          requests: num(promptCache.requests),
          misses: num(promptCache.misses),
          expectedRebuilds: num(promptCache.expected_rebuilds),
        })
      : undefined,
    raw,
  };
}

export interface QuotaFromStatuslineOptions {
  /** Capture time; defaults to now. */
  now?: Date;
  /**
   * A previously known quota (typically the persisted snapshot). Windows the
   * payload omits are carried over from it, since Claude Code drops a window
   * from the document once its reset time has passed.
   */
  fallback?: QuotaState | null;
}

function toWindow(
  live: ClaudeStatuslineRateLimitWindow | undefined,
  fallback: QuotaState['fiveHour'] | undefined,
): QuotaState['fiveHour'] {
  if (live) {
    return {
      utilization: Math.max(0, live.usedPercentage),
      resetsAt: new Date(live.resetsAt * 1000).toISOString(),
    };
  }
  return fallback ?? { utilization: 0, resetsAt: '' };
}

/**
 * Build a `QuotaState` from the official rate-limit block. Returns `null`
 * when the payload carries no rate limits at all (API-key users, or before
 * the first response of a session), so callers fall back to their other
 * sources.
 */
export function quotaFromStatuslinePayload(
  payload: ClaudeStatuslinePayload,
  options: QuotaFromStatuslineOptions = {},
): QuotaState | null {
  const limits = payload.rateLimits;
  if (!limits?.fiveHour && !limits?.sevenDay) return null;
  const now = options.now ?? new Date();
  const fallback = options.fallback ?? undefined;
  return {
    fiveHour: toWindow(limits.fiveHour, fallback?.fiveHour),
    sevenDay: toWindow(limits.sevenDay, fallback?.sevenDay),
    available: true,
    providerId: 'claude-code',
    source: 'statusline',
    capturedAt: now.toISOString(),
    stale: false,
  };
}
