import { readActiveClaudeAccount } from './accounts';
import { CodexQuotaWatcher } from './codexQuotaWatcher';
import { readClaudeMaxCredentials } from './credentials';
import { fetchPeakHoursStatus } from './peakHours';
import { fetchQuota } from './quota';
import { describeQuotaFailure } from './quotaPresentation';
import type { ClaudeMaxCredentials } from './credentials';
import type { PeakHoursState } from './peakHours';
import type { QuotaState } from './quota';
import type { Disposable } from './quotaPoller';
import type { ProviderQuotaMap, ProviderQuotaState, RuntimeQuotaProvider } from './providerQuota';

const ACTIVE_POLL_INTERVAL_MS = 60_000;
const IDLE_POLL_INTERVAL_MS = 300_000;
const TRANSIENT_FAILURE_BACKOFF_MS = [30_000, 60_000, 120_000, 240_000, 300_000] as const;
const PEAK_HOURS_CACHE_MAX_AGE_MS = 10 * 60 * 1000;

type Logger = (message: string, error?: unknown) => void;

interface CodexWatcherLike extends Disposable {
  start(): void;
  stop(): void;
  onUpdate(cb: (state: ProviderQuotaState<'codex'>) => void): Disposable;
}

export interface MultiProviderQuotaServiceOptions {
  activeIntervalMs?: number;
  idleIntervalMs?: number;
  transientFailureBackoffMs?: readonly number[];
  peakHoursCacheMaxAgeMs?: number;
  includePeakHours?: boolean;
  codexWorkspacePath?: string;
  codexWatcher?: CodexWatcherLike | null;
  readClaudeCredentials?: () => Promise<ClaudeMaxCredentials | null>;
  readClaudeAccount?: typeof readActiveClaudeAccount;
  fetchClaudeQuota?: (accessToken: string) => Promise<QuotaState>;
  fetchPeakHours?: () => Promise<PeakHoursState>;
  log?: Logger;
}

function makeUnavailableClaudeState(
  error: string,
  failureKind?: ProviderQuotaState<'claude'>['failureKind'],
): ProviderQuotaState<'claude'> {
  return {
    runtimeProvider: 'claude',
    fiveHour: { utilization: 0, resetsAt: '' },
    sevenDay: { utilization: 0, resetsAt: '' },
    available: false,
    error,
    failureKind,
    providerId: 'claude-code',
    source: 'api',
  };
}

function formatDelay(ms: number): string {
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  if (ms % 1_000 === 0) return `${ms / 1_000}s`;
  return `${ms}ms`;
}

function unavailablePeakHoursState(): PeakHoursState {
  return {
    status: 'unknown',
    isPeak: false,
    sessionLimitSpeed: 'unknown',
    label: 'Peak hours unavailable',
    peakHoursDescription: '',
    nextChange: null,
    minutesUntilChange: null,
    note: '',
    updatedAt: new Date().toISOString(),
    unavailable: true,
  };
}

export class MultiProviderQuotaService implements Disposable {
  private readonly activeIntervalMs: number;
  private readonly idleIntervalMs: number;
  private readonly transientFailureBackoffMs: readonly number[];
  private readonly peakHoursCacheMaxAgeMs: number;
  private readonly includePeakHours: boolean;
  private readonly readClaudeCredentials: () => Promise<ClaudeMaxCredentials | null>;
  private readonly readClaudeAccount: typeof readActiveClaudeAccount;
  private readonly fetchClaudeQuota: (accessToken: string) => Promise<QuotaState>;
  private readonly fetchPeakHours: () => Promise<PeakHoursState>;
  private readonly log?: Logger;
  private readonly listeners: Array<(state: ProviderQuotaMap) => void> = [];
  private readonly codexWatcher: CodexWatcherLike | null;
  private readonly ownsCodexWatcher: boolean;
  private codexSubscription: Disposable | null = null;

  private timer: ReturnType<typeof setTimeout> | undefined;
  private polling = false;
  private quotaByProvider: ProviderQuotaMap = {};
  private lastEmittedClaudeState: ProviderQuotaState<'claude'> | null = null;
  private lastSuccessfulClaudeState: ProviderQuotaState<'claude'> | null = null;
  private pollingMode: 'active' | 'idle' = 'idle';
  private transientFailureStreak = 0;
  private cachedFallbackActive = false;
  private authUnavailableActive = false;
  private currentPeakHours: PeakHoursState | undefined;
  private lastFreshPeakHoursAt = 0;
  private peakHoursErrorLogged = false;

  constructor(options: MultiProviderQuotaServiceOptions = {}) {
    this.activeIntervalMs = options.activeIntervalMs ?? ACTIVE_POLL_INTERVAL_MS;
    this.idleIntervalMs = options.idleIntervalMs ?? IDLE_POLL_INTERVAL_MS;
    this.transientFailureBackoffMs = options.transientFailureBackoffMs ?? TRANSIENT_FAILURE_BACKOFF_MS;
    this.peakHoursCacheMaxAgeMs = options.peakHoursCacheMaxAgeMs ?? PEAK_HOURS_CACHE_MAX_AGE_MS;
    this.includePeakHours = options.includePeakHours ?? true;
    this.readClaudeCredentials = options.readClaudeCredentials ?? readClaudeMaxCredentials;
    this.readClaudeAccount = options.readClaudeAccount ?? readActiveClaudeAccount;
    this.fetchClaudeQuota = options.fetchClaudeQuota ?? fetchQuota;
    this.fetchPeakHours = options.fetchPeakHours ?? fetchPeakHoursStatus;
    this.log = options.log;

    if (options.codexWatcher !== undefined) {
      this.codexWatcher = options.codexWatcher;
      this.ownsCodexWatcher = false;
    } else if (options.codexWorkspacePath) {
      this.codexWatcher = new CodexQuotaWatcher(options.codexWorkspacePath);
      this.ownsCodexWatcher = true;
    } else {
      this.codexWatcher = null;
      this.ownsCodexWatcher = false;
    }

    this.codexSubscription = this.codexWatcher?.onUpdate((state) => {
      this.updateProviderQuota('codex', state);
    }) ?? null;
  }

  startPolling(): void {
    if (this.polling) return;
    this.polling = true;
    this.codexWatcher?.start();
    void this.poll();
    this.log?.('[Quota] Polling started');
  }

  stopPolling(): void {
    if (!this.polling) return;
    this.polling = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.codexWatcher?.stop();
    this.log?.('[Quota] Polling stopped');
  }

  setPollingMode(mode: 'active' | 'idle'): void {
    if (this.pollingMode === mode) return;
    this.pollingMode = mode;
    if (!this.polling) return;
    if (this.transientFailureStreak > 0 && this.timer) return;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.scheduleNextPoll();
  }

  onUpdate(cb: (state: ProviderQuotaMap) => void): Disposable {
    this.listeners.push(cb);
    return {
      dispose: () => {
        const index = this.listeners.indexOf(cb);
        if (index >= 0) this.listeners.splice(index, 1);
      },
    };
  }

  onQuotaUpdate(cb: (state: ProviderQuotaMap) => void): Disposable {
    return this.onUpdate(cb);
  }

  getLatest(): ProviderQuotaMap {
    return { ...this.quotaByProvider };
  }

  updateProviderQuota(provider: 'claude', state: ProviderQuotaState<'claude'>): void;
  updateProviderQuota(provider: 'codex', state: ProviderQuotaState<'codex'>): void;
  updateProviderQuota(provider: RuntimeQuotaProvider, state: ProviderQuotaState): void {
    if (provider === 'claude') {
      const nextState = this.withClaudeAccountDetails({
        ...state,
        runtimeProvider: 'claude',
        providerId: 'claude-code',
      });
      this.lastEmittedClaudeState = nextState;
      if (nextState.available) {
        this.lastSuccessfulClaudeState = nextState;
      }
      this.quotaByProvider = {
        ...this.quotaByProvider,
        claude: nextState,
      };
      this.emit();
      return;
    }

    const nextState: ProviderQuotaState<'codex'> = {
      ...state,
      runtimeProvider: 'codex',
      providerId: 'codex',
    };
    this.quotaByProvider = {
      ...this.quotaByProvider,
      codex: nextState,
    };
    this.emit();
  }

  dispose(): void {
    this.stopPolling();
    this.codexSubscription?.dispose();
    this.codexSubscription = null;
    if (this.ownsCodexWatcher) {
      this.codexWatcher?.dispose();
    }
    this.listeners.splice(0, this.listeners.length);
  }

  private async refreshPeakHours(): Promise<void> {
    if (!this.includePeakHours) return;

    let result: PeakHoursState;
    try {
      result = await this.fetchPeakHours();
    } catch (error) {
      if (!this.peakHoursErrorLogged) {
        this.log?.('[Quota] Peak-hours fetch threw unexpectedly', error);
        this.peakHoursErrorLogged = true;
      }
      result = unavailablePeakHoursState();
    }

    if (!result.unavailable) {
      this.currentPeakHours = result;
      this.lastFreshPeakHoursAt = Date.now();
      this.peakHoursErrorLogged = false;
      return;
    }

    const cachedIsFresh =
      this.currentPeakHours !== undefined &&
      !this.currentPeakHours.unavailable &&
      Date.now() - this.lastFreshPeakHoursAt < this.peakHoursCacheMaxAgeMs;

    if (cachedIsFresh) return;
    this.currentPeakHours = result;
  }

  private async poll(): Promise<void> {
    await this.refreshPeakHours();

    try {
      const creds = await this.readClaudeCredentials();
      if (!creds) {
        this.handleUnavailableState(
          makeUnavailableClaudeState('Renew your Claude Max OAuth to view quota', 'auth'),
        );
        return;
      }

      const state = await this.fetchClaudeQuota(creds.accessToken);
      if (!state.available) {
        this.handleUnavailableState({
          ...state,
          runtimeProvider: 'claude',
          providerId: 'claude-code',
          source: state.source ?? 'api',
        });
        return;
      }

      const recoveredAttempts = this.transientFailureStreak;
      const recoveredFromFallback = recoveredAttempts > 0;
      this.resetTransientFailureState();
      this.authUnavailableActive = false;
      if (recoveredFromFallback) {
        this.log?.(`[Quota] Fetch recovered after ${recoveredAttempts} failed attempt(s)`);
      }
      this.emitClaudeState({
        ...state,
        runtimeProvider: 'claude',
        providerId: 'claude-code',
        source: state.source ?? 'api',
      });
    } catch (error) {
      if (this.transientFailureStreak === 0) {
        this.log?.('[Quota] Poll error', error);
      }
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.handleTransientFailure(makeUnavailableClaudeState(message));
    } finally {
      this.scheduleNextPoll();
    }
  }

  private emitClaudeState(state: ProviderQuotaState<'claude'>): void {
    const withPeakHours =
      this.currentPeakHours !== undefined ? { ...state, peakHours: this.currentPeakHours } : state;
    const withFailure = {
      ...withPeakHours,
      failure: describeQuotaFailure(withPeakHours),
    };
    this.updateProviderQuota('claude', withFailure);
  }

  private handleUnavailableState(state: ProviderQuotaState<'claude'>): void {
    if (state.failureKind === 'auth') {
      this.resetTransientFailureState();
      this.authUnavailableActive = true;
      this.emitClaudeState(state);
      return;
    }

    this.handleTransientFailure(state);
  }

  private handleTransientFailure(state: ProviderQuotaState<'claude'>): void {
    this.authUnavailableActive = false;
    this.transientFailureStreak += 1;
    const retryDelay = this.getTransientFailureDelay();
    const hasVisibleCachedSuccess =
      this.lastSuccessfulClaudeState !== null && this.lastEmittedClaudeState?.available === true;

    if (this.transientFailureStreak === 1) {
      if (hasVisibleCachedSuccess) {
        this.log?.(`[Quota] Fetch failed, using cached data; retrying in ${formatDelay(retryDelay)}`);
      } else {
        this.log?.(`[Quota] Fetch unavailable; retrying in ${formatDelay(retryDelay)}`);
      }
    }

    this.cachedFallbackActive = hasVisibleCachedSuccess;
    if (!hasVisibleCachedSuccess) {
      this.emitClaudeState(state);
    }
  }

  private getTransientFailureDelay(): number {
    return this.transientFailureBackoffMs[
      Math.min(this.transientFailureStreak - 1, this.transientFailureBackoffMs.length - 1)
    ];
  }

  private resetTransientFailureState(): void {
    this.transientFailureStreak = 0;
    this.cachedFallbackActive = false;
  }

  private scheduleNextPoll(): void {
    if (!this.polling) return;
    if (this.timer) {
      clearTimeout(this.timer);
    }

    let delay = this.pollingMode === 'active' ? this.activeIntervalMs : this.idleIntervalMs;
    if (this.transientFailureStreak > 0) {
      delay = this.getTransientFailureDelay();
    } else if (this.authUnavailableActive || this.lastEmittedClaudeState?.available !== true) {
      delay = this.idleIntervalMs;
    } else if (this.cachedFallbackActive) {
      delay = this.idleIntervalMs;
    }

    this.timer = setTimeout(() => void this.poll(), delay);
  }

  private withClaudeAccountDetails(state: ProviderQuotaState<'claude'>): ProviderQuotaState<'claude'> {
    const accountEmail = this.readClaudeAccount()?.email;
    if (!accountEmail) {
      const nextState = { ...state };
      delete nextState.accountLabel;
      delete nextState.accountDetail;
      return nextState;
    }

    return {
      ...state,
      accountLabel: accountEmail,
      accountDetail: accountEmail,
    };
  }

  private emit(): void {
    const snapshot = { ...this.quotaByProvider };
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch {
        // Listener failures should not break polling.
      }
    }
  }
}
