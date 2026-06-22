/**
 * Deprecated event-driven watcher that derives a z.ai coding-plan
 * `QuotaState` from observed OpenCode assistant turns.
 *
 * This watcher is retained for compatibility. Product code now uses
 * `zaiQuotaApi.ts` to call z.ai's authoritative quota endpoint. The legacy
 * watcher maintains rolling 5-hour / 7-day windows in memory and recomputes a
 * derived `QuotaState` whenever a new turn arrives. The consumer is
 * responsible for feeding it z.ai-routed assistant turns (and any trapped
 * error events) — typically by subscribing to `SessionMonitor.onSessionEvent`
 * and filtering on `providerID ∈ {zai, zai-coding-plan}`.
 *
 * Optionally writes snapshots + history samples for cross-session cache
 * and trend visualisation, mirroring `CodexQuotaWatcher`.
 */
import { appendQuotaHistorySample } from './quotaHistory';
import type { QuotaHistorySample } from './quotaHistory';
import { readQuotaSnapshot, writeQuotaSnapshot } from './quotaSnapshots';
import {
  accumulateZaiUsage,
  inferZaiQuotaState,
  makeUnavailableZaiQuotaState,
  parseZaiQuotaError,
  resolveZaiTier,
  type ZaiAccumulatedUsage,
  type ZaiAssistantTurn,
  type ZaiQuotaError,
  type ZaiTier,
} from './zaiQuota';
import type { QuotaState } from './quota';
import type { ProviderQuotaState } from './providerQuota';
import type { Disposable } from './quotaPoller';

/** Storage key wider than `AccountProviderId` — z.ai has no full account
 * management in v1, but we still need a stable key for snapshot/history. */
type ZaiSnapshotProvider = 'zai';

const DEFAULT_ACCOUNT_ID = 'default';
const DEFAULT_RECOMPUTE_DEBOUNCE_MS = 1_000;
const DEFAULT_PRUNE_INTERVAL_MS = 60_000;
const SEVEN_DAY_MS = 7 * 86_400_000;

type TierResolver = (configured: ZaiTier | 'auto', accumulated: ZaiAccumulatedUsage) => ZaiTier;
type SnapshotReader = (providerId: ZaiSnapshotProvider, accountId: string) => QuotaState | null;
type SnapshotWriter = (providerId: ZaiSnapshotProvider, accountId: string, quota: QuotaState) => void;
type HistoryAppender = (sample: QuotaHistorySample) => void | Promise<void>;

export interface ZaiQuotaWatcherOptions {
  /** Configured tier. Default: `'auto'` (heuristic from observed usage). */
  tier?: ZaiTier | 'auto';
  /** Override tier resolution (used by tests). Default: `resolveZaiTier`. */
  resolveTier?: TierResolver;
  /** Override snapshot read (used by tests). */
  readSnapshot?: SnapshotReader;
  /** Override snapshot write (used by tests). */
  writeSnapshot?: SnapshotWriter;
  /** Override history append (used by tests). */
  appendHistorySample?: HistoryAppender;
  /** Stable workspace identifier — when provided, samples are appended to per-workspace history. */
  workspaceId?: string;
  /** Account identifier for snapshot persistence. Default: `'default'`. */
  accountId?: string;
  /** Minimum time between recomputes (ms). Default: 1000. */
  recomputeDebounceMs?: number;
  /** Time between prunes of in-memory turn buffer (ms). Default: 60000. */
  pruneIntervalMs?: number;
  /** Internal clock for tests. */
  now?: () => number;
}

function enrichZaiState(state: QuotaState): ProviderQuotaState<'zai'> {
  return {
    ...state,
    runtimeProvider: 'zai',
    providerId: 'zai',
  };
}

/**
 * Watches z.ai-routed OpenCode activity and emits derived `QuotaState`.
 *
 * The watcher is event-driven (not a poller): call `ingestAssistantTurn`
 * for every observed z.ai assistant turn, and `ingestError` whenever a
 * z.ai business error is observed. The watcher debounces recompute and
 * emits via `onUpdate` / `onQuotaUpdate`.
 */
export class ZaiQuotaWatcher implements Disposable {
  private readonly tier: ZaiTier | 'auto';
  private readonly resolveTier: TierResolver;
  private readonly readSnapshot: SnapshotReader;
  private readonly writeSnapshot: SnapshotWriter;
  private readonly appendHistorySample: HistoryAppender;
  private readonly workspaceId: string | undefined;
  private readonly accountId: string;
  private readonly recomputeDebounceMs: number;
  private readonly pruneIntervalMs: number;
  private readonly now: () => number;
  private readonly listeners: Array<(state: ProviderQuotaState<'zai'>) => void> = [];

  /** In-memory rolling 7-day buffer of observed turns. */
  private turns: ZaiAssistantTurn[] = [];
  /** Most recent authoritative 5h reset (parsed from a z.ai error event). */
  private authoritativeFiveHourResetAt: string | undefined;
  /** Most recent authoritative weekly reset (parsed from a z.ai error event). */
  private authoritativeWeeklyResetAt: string | undefined;
  /** Most recent trapped error (so consumers can show "rate-limited until X"). */
  private lastError: ZaiQuotaError | null = null;
  private lastEmissionKey: string | null = null;
  private pendingRecomputeTimer: ReturnType<typeof setTimeout> | undefined;
  private pruneTimer: ReturnType<typeof setInterval> | undefined;
  private running = false;

  constructor(options: ZaiQuotaWatcherOptions = {}) {
    this.tier = options.tier ?? 'auto';
    this.resolveTier = options.resolveTier ?? resolveZaiTier;
    this.readSnapshot = options.readSnapshot ?? readQuotaSnapshot;
    this.writeSnapshot = options.writeSnapshot ?? writeQuotaSnapshot;
    this.appendHistorySample = options.appendHistorySample ?? appendQuotaHistorySample;
    this.workspaceId = options.workspaceId;
    this.accountId = options.accountId ?? DEFAULT_ACCOUNT_ID;
    this.recomputeDebounceMs = options.recomputeDebounceMs ?? DEFAULT_RECOMPUTE_DEBOUNCE_MS;
    this.pruneIntervalMs = options.pruneIntervalMs ?? DEFAULT_PRUNE_INTERVAL_MS;
    this.now = options.now ?? Date.now;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    // Emit cached state immediately so consumers don't show "unavailable"
    // during the gap before the first z.ai turn arrives.
    this.emitCachedOrUnavailable();
    this.pruneTimer = setInterval(() => this.pruneOldTurns(), this.pruneIntervalMs);
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.pendingRecomputeTimer) {
      clearTimeout(this.pendingRecomputeTimer);
      this.pendingRecomputeTimer = undefined;
    }
    if (this.pruneTimer) {
      clearInterval(this.pruneTimer);
      this.pruneTimer = undefined;
    }
  }

  dispose(): void {
    this.stop();
    this.listeners.splice(0, this.listeners.length);
  }

  onUpdate(cb: (state: ProviderQuotaState<'zai'>) => void): Disposable {
    this.listeners.push(cb);
    return {
      dispose: () => {
        const index = this.listeners.indexOf(cb);
        if (index >= 0) this.listeners.splice(index, 1);
      },
    };
  }

  onQuotaUpdate(cb: (state: ProviderQuotaState<'zai'>) => void): Disposable {
    return this.onUpdate(cb);
  }

  /** Feed an observed z.ai assistant turn. Schedules a debounced recompute. */
  ingestAssistantTurn(turn: ZaiAssistantTurn): void {
    this.turns.push(turn);
    this.scheduleRecompute();
  }

  /**
   * Feed multiple turns at once (used for cold-start seeding from the DB).
   * Schedules a single debounced recompute.
   */
  ingestAssistantTurns(turns: readonly ZaiAssistantTurn[]): void {
    for (const turn of turns) this.turns.push(turn);
    this.scheduleRecompute();
  }

  /** Feed a z.ai error event. Triggers an immediate recompute + emit. */
  ingestError(error: { code?: string | number; message?: string; type?: string }): boolean {
    const parsed = parseZaiQuotaError(error);
    if (!parsed) return false;
    this.lastError = parsed;
    if (parsed.resetsAt) {
      // The first observed error after the user crosses a threshold tells
      // us the authoritative window boundary. Apply to whichever window
      // the kind maps to.
      if (parsed.kind === 'exhausted') {
        this.authoritativeFiveHourResetAt = parsed.resetsAt;
        // 1310 is "weekly/monthly exhausted" — also pin the weekly window.
        if (String(parsed.code) === '1310') {
          this.authoritativeWeeklyResetAt = parsed.resetsAt;
        }
      }
    }
    this.scheduleRecompute();
    return true;
  }

  /** Force a recompute+emit now (skipping the debounce). Used by tests. */
  refresh(): void {
    this.recomputeAndEmit();
  }

  /** Current in-memory turn count (testing/diagnostics). */
  get bufferedTurnCount(): number {
    return this.turns.length;
  }

  // ── internals ──

  private scheduleRecompute(): void {
    if (!this.running) return;
    if (this.pendingRecomputeTimer) clearTimeout(this.pendingRecomputeTimer);
    this.pendingRecomputeTimer = setTimeout(() => {
      this.pendingRecomputeTimer = undefined;
      this.recomputeAndEmit();
    }, this.recomputeDebounceMs);
  }

  private recomputeAndEmit(): void {
    const nowMs = this.now();
    const accumulated = accumulateZaiUsage(this.turns, nowMs);
    const tier = this.resolveTier(this.tier, accumulated);

    const state: QuotaState = accumulated.fiveHourTurns > 0 || accumulated.weeklyTurns > 0
      ? inferZaiQuotaState(accumulated, tier, {
        capturedAt: new Date(nowMs).toISOString(),
        stale: false,
        authoritativeFiveHourResetAt: this.authoritativeFiveHourResetAt,
        authoritativeWeeklyResetAt: this.authoritativeWeeklyResetAt,
      })
      : makeUnavailableZaiQuotaState(undefined, tier, new Date(nowMs).toISOString());

    // If we recently saw an error, override availability so the UI shows it.
    if (this.lastError) {
      state.error = this.lastError.message;
      state.failureKind = this.lastError.kind === 'expired' ? 'auth' : 'rate_limit';
      state.rateLimitReachedType = this.lastError.kind;
    }

    this.writeSnapshot('zai', this.accountId, state);
    this.maybeAppendHistory(state);

    this.emitState(enrichZaiState(state));
  }

  private maybeAppendHistory(state: QuotaState): void {
    if (!this.workspaceId) return;
    const sample: QuotaHistorySample = {
      timestamp: state.capturedAt ?? new Date(this.now()).toISOString(),
      runtimeProvider: 'zai',
      providerId: this.accountId,
      workspaceId: this.workspaceId,
      fiveHour: { utilization: state.fiveHour.utilization, resetsAt: state.fiveHour.resetsAt },
      sevenDay: { utilization: state.sevenDay.utilization, resetsAt: state.sevenDay.resetsAt },
      available: state.available,
      error: state.error,
      source: 'session',
      stale: state.stale,
    };
    try {
      const result = this.appendHistorySample(sample);
      if (result && typeof (result as Promise<void>).catch === 'function') {
        (result as Promise<void>).catch(() => {
          // History append must never break the live emission path.
        });
      }
    } catch {
      // Synchronous errors swallowed for the same reason.
    }
  }

  private emitCachedOrUnavailable(): void {
    const cached = this.readSnapshot('zai', this.accountId);
    if (cached) {
      this.emitState(enrichZaiState({
        ...cached,
        providerId: 'zai',
        source: 'cache',
        stale: true,
        fiveHourLabel: cached.fiveHourLabel ?? '5-Hour',
        sevenDayLabel: cached.sevenDayLabel ?? 'Weekly',
      }));
      return;
    }
    // Initial state with no observations yet.
    const tier = this.tier === 'auto' ? 'lite' : this.tier;
    this.emitState(enrichZaiState(makeUnavailableZaiQuotaState(undefined, tier)));
  }

  private emitState(state: ProviderQuotaState<'zai'>): void {
    const nextKey = JSON.stringify(state);
    if (this.lastEmissionKey === nextKey) return;
    this.lastEmissionKey = nextKey;

    for (const listener of this.listeners) {
      try {
        listener(state);
      } catch {
        // Listener failures must not stop the watcher.
      }
    }
  }

  private pruneOldTurns(): void {
    const cutoff = this.now() - SEVEN_DAY_MS;
    if (this.turns.length === 0) return;
    const next = this.turns.filter(turn => turn.timestampMs >= cutoff);
    if (next.length !== this.turns.length) {
      this.turns = next;
    }
  }
}
