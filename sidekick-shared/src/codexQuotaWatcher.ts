import * as fs from 'fs';
import type { FSWatcher } from 'fs';
import { getActiveCodexAccount, resolveActiveCodexAccount } from './codexProfiles';
import { quotaFromCodexRateLimits, resolveCodexQuotaFromLocalSources } from './codexQuota';
import { readQuotaSnapshot, writeQuotaSnapshot } from './quotaSnapshots';
import { appendQuotaHistorySample } from './quotaHistory';
import type { QuotaHistorySample } from './quotaHistory';
import { CodexProvider } from './providers/codex';
import type { SavedAccountProfile } from './accountRegistry';
import type { Disposable } from './quotaPoller';
import type { QuotaState } from './quota';
import type { SessionReader } from './providers/types';
import type { ProviderQuotaState } from './providerQuota';
import { onAccountsChanged, type AccountsChangedEvent } from './accountChanges';

const DEFAULT_DISCOVERY_POLL_INTERVAL_MS = 30_000;
const DEFAULT_LOCAL_SCAN_CACHE_MS = 5 * 60_000;

type CodexAccountReader = () => SavedAccountProfile | null;
type SnapshotReader = (providerId: 'codex', accountId: string) => QuotaState | null;
type SnapshotWriter = (providerId: 'codex', accountId: string, quota: QuotaState) => void;
type HistoryAppender = (sample: QuotaHistorySample) => void | Promise<void>;
type WatchFile = (filename: fs.PathLike, listener: fs.WatchListener<string>) => FSWatcher;

export interface CodexQuotaWatcherOptions {
  discoveryPollIntervalMs?: number;
  maxTailBytes?: number;
  maxSessionFiles?: number;
  /** Minimum interval between expensive rollout-tail fallback scans. */
  localScanCacheMs?: number;
  now?: () => number;
  providerFactory?: () => CodexProvider;
  getActiveAccount?: CodexAccountReader;
  readSnapshot?: SnapshotReader;
  writeSnapshot?: SnapshotWriter;
  watchFile?: WatchFile;
  /** Stable workspace identifier. When provided, live quotas are appended to the per-workspace history JSONL. */
  workspaceId?: string;
  /** Override the history append function (used by tests). Default: `appendQuotaHistorySample`. */
  appendHistorySample?: HistoryAppender;
  subscribeAccountsChanged?: (listener: (event: AccountsChangedEvent) => void) => Disposable;
}

function accountEmail(account: SavedAccountProfile | null): string | undefined {
  return account?.email ?? account?.metadata?.email;
}

function enrichQuotaState(
  state: ProviderQuotaState<'codex'>,
  account: SavedAccountProfile | null,
): ProviderQuotaState<'codex'> {
  return {
    ...state,
    runtimeProvider: 'codex',
    providerId: 'codex',
    accountLabel: account?.label,
    accountDetail: accountEmail(account),
  };
}

function makeUnavailableState(
  account: SavedAccountProfile | null,
  error = 'Run a Codex session to view rate limits',
): ProviderQuotaState<'codex'> {
  return {
    runtimeProvider: 'codex',
    fiveHour: { utilization: 0, resetsAt: '' },
    sevenDay: { utilization: 0, resetsAt: '' },
    available: false,
    error,
    providerId: 'codex',
    accountLabel: account?.label,
    accountDetail: accountEmail(account),
    fiveHourLabel: 'Primary',
    sevenDayLabel: 'Secondary',
  };
}

/**
 * Watches the active Codex rollout for quota snapshots and falls back to the
 * latest account-scoped cache when no live rate limits are present.
 */
export class CodexQuotaWatcher implements Disposable {
  private readonly workspacePath: string;
  private readonly discoveryPollIntervalMs: number;
  private readonly providerFactory: () => CodexProvider;
  private readonly getActiveAccount: CodexAccountReader;
  private readonly readSnapshot: SnapshotReader;
  private readonly writeSnapshot: SnapshotWriter;
  private readonly watchFile: WatchFile;
  private readonly maxTailBytes: number | undefined;
  private readonly maxSessionFiles: number | undefined;
  private readonly localScanCacheMs: number;
  private readonly now: () => number;
  private readonly workspaceId: string | undefined;
  private readonly appendHistorySample: HistoryAppender;
  private readonly subscribeAccountsChanged: NonNullable<
    CodexQuotaWatcherOptions['subscribeAccountsChanged']
  >;
  private readonly listeners: Array<(state: ProviderQuotaState<'codex'>) => void> = [];

  private discoveryTimer: ReturnType<typeof setInterval> | undefined;
  private provider: CodexProvider | null = null;
  private reader: SessionReader | null = null;
  private fileWatcher: FSWatcher | null = null;
  private sessionPath: string | null = null;
  private lastEmissionKey: string | null = null;
  private lastLocalScanAt = Number.NEGATIVE_INFINITY;
  private lastLocalScanState: ProviderQuotaState<'codex'> | null = null;
  private running = false;
  private accountSubscription: Disposable | null = null;

  constructor(workspacePath: string, options: CodexQuotaWatcherOptions = {}) {
    this.workspacePath = workspacePath;
    this.discoveryPollIntervalMs =
      options.discoveryPollIntervalMs ?? DEFAULT_DISCOVERY_POLL_INTERVAL_MS;
    this.providerFactory = options.providerFactory ?? (() => new CodexProvider());
    // Self-heal the registry pointer to the live login before reading it, so the
    // history key (account.id) and the display label track the currently
    // logged-in account even after a native `codex login`. Overridable for tests.
    this.getActiveAccount =
      options.getActiveAccount ??
      (() => {
        resolveActiveCodexAccount();
        return getActiveCodexAccount();
      });
    this.readSnapshot = options.readSnapshot ?? readQuotaSnapshot;
    this.writeSnapshot = options.writeSnapshot ?? writeQuotaSnapshot;
    this.watchFile = options.watchFile ?? fs.watch;
    this.maxTailBytes = options.maxTailBytes;
    this.maxSessionFiles = options.maxSessionFiles;
    this.localScanCacheMs = options.localScanCacheMs ?? DEFAULT_LOCAL_SCAN_CACHE_MS;
    this.now = options.now ?? Date.now;
    this.workspaceId = options.workspaceId;
    this.appendHistorySample = options.appendHistorySample ?? appendQuotaHistorySample;
    this.subscribeAccountsChanged = options.subscribeAccountsChanged ?? onAccountsChanged;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.accountSubscription ??= this.subscribeAccountsChanged(() => this.handleAccountsChanged());
    this.handleAccountsChanged();
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.discoveryTimer) {
      clearInterval(this.discoveryTimer);
      this.discoveryTimer = undefined;
    }
    this.accountSubscription?.dispose();
    this.accountSubscription = null;
    this.teardownActiveSession();
  }

  dispose(): void {
    this.stop();
    this.listeners.splice(0, this.listeners.length);
  }

  onUpdate(cb: (state: ProviderQuotaState<'codex'>) => void): Disposable {
    this.listeners.push(cb);
    return {
      dispose: () => {
        const index = this.listeners.indexOf(cb);
        if (index >= 0) this.listeners.splice(index, 1);
      },
    };
  }

  onQuotaUpdate(cb: (state: ProviderQuotaState<'codex'>) => void): Disposable {
    return this.onUpdate(cb);
  }

  refresh(): void {
    this.handleAccountsChanged();
  }

  private handleAccountsChanged(): void {
    if (!this.running) return;
    const account = this.safeGetActiveAccount();
    if (!account) {
      if (this.discoveryTimer) {
        clearInterval(this.discoveryTimer);
        this.discoveryTimer = undefined;
      }
      this.teardownActiveSession();
      this.emitState(makeUnavailableState(null, 'No Codex account configured'));
      return;
    }
    if (!this.discoveryTimer) {
      this.discoveryTimer = setInterval(() => {
        this.refreshActiveSession();
      }, this.discoveryPollIntervalMs);
      this.discoveryTimer.unref?.();
    }
    this.refreshActiveSession(account);
  }

  private refreshActiveSession(account = this.safeGetActiveAccount()): void {
    if (!account) {
      this.handleAccountsChanged();
      return;
    }
    const provider = this.getProvider();
    const nextSessionPath = provider.findActiveSession(this.workspacePath);

    if (!nextSessionPath) {
      this.teardownActiveSession();
      this.emitCachedOrUnavailable(account);
      return;
    }

    if (nextSessionPath !== this.sessionPath || this.reader == null) {
      this.attachToSession(nextSessionPath);
      return;
    }

    this.ingestSessionUpdate('readNew', account);
  }

  private attachToSession(nextSessionPath: string): void {
    this.teardownActiveSession();
    this.provider = this.providerFactory();
    this.reader = this.provider.createReader(nextSessionPath);
    this.sessionPath = nextSessionPath;

    this.ingestSessionUpdate('readAll');

    try {
      this.fileWatcher = this.watchFile(nextSessionPath, (eventType) => {
        if (!this.running) return;
        if (eventType === 'change') {
          this.ingestSessionUpdate('readNew');
          return;
        }
        this.refreshActiveSession();
      });
      if (typeof this.fileWatcher.on === 'function') {
        this.fileWatcher.on('error', () => {
          try {
            this.fileWatcher?.close();
          } catch {
            // Discovery polling remains active.
          }
          this.fileWatcher = null;
        });
      }
    } catch {
      this.emitCachedOrUnavailable();
    }
  }

  private ingestSessionUpdate(
    mode: 'readAll' | 'readNew',
    knownAccount?: SavedAccountProfile,
  ): void {
    const account = knownAccount ?? this.safeGetActiveAccount();
    if (!account) {
      this.handleAccountsChanged();
      return;
    }
    if (!this.provider || !this.reader) {
      this.emitCachedOrUnavailable(account);
      return;
    }

    if (!this.reader.exists()) {
      this.refreshActiveSession();
      return;
    }

    if (mode === 'readAll') {
      this.reader.readAll();
    } else {
      this.reader.readNew();
    }

    const liveQuota = quotaFromCodexRateLimits(this.provider.getLastRateLimits(), 'session');
    if (!liveQuota) {
      this.emitCachedOrUnavailable(account);
      return;
    }

    const cached = this.readSnapshot('codex', account.id);
    const liveQuotaWithResetCredits: QuotaState = {
      ...liveQuota,
      resetCredits: liveQuota.resetCredits ?? cached?.resetCredits,
    };
    this.writeSnapshot('codex', account.id, liveQuotaWithResetCredits);
    if (this.workspaceId) {
      const sample: QuotaHistorySample = {
        timestamp: liveQuotaWithResetCredits.capturedAt ?? new Date().toISOString(),
        runtimeProvider: 'codex',
        providerId: account.id,
        workspaceId: this.workspaceId,
        fiveHour: {
          utilization: liveQuotaWithResetCredits.fiveHour.utilization,
          resetsAt: liveQuotaWithResetCredits.fiveHour.resetsAt,
        },
        sevenDay: {
          utilization: liveQuotaWithResetCredits.sevenDay.utilization,
          resetsAt: liveQuotaWithResetCredits.sevenDay.resetsAt,
        },
        available: liveQuotaWithResetCredits.available,
        error: liveQuotaWithResetCredits.error,
        source: liveQuotaWithResetCredits.source,
        stale: liveQuotaWithResetCredits.stale,
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

    this.emitState(
      enrichQuotaState(
        {
          ...liveQuotaWithResetCredits,
          runtimeProvider: 'codex',
          providerId: 'codex',
        },
        account,
      ),
    );
  }

  private emitCachedOrUnavailable(knownAccount?: SavedAccountProfile): void {
    const account = knownAccount ?? this.safeGetActiveAccount();
    if (!account) {
      this.emitState(makeUnavailableState(null, 'No Codex account configured'));
      return;
    }
    const scanNow = this.now();
    if (scanNow - this.lastLocalScanAt < this.localScanCacheMs) {
      if (this.lastLocalScanState) {
        this.emitState(this.lastLocalScanState);
        return;
      }
    } else {
      let localProvider: CodexProvider | null = null;
      this.lastLocalScanAt = scanNow;
      this.lastLocalScanState = null;
      try {
        localProvider = this.providerFactory();
        this.lastLocalScanState = resolveCodexQuotaFromLocalSources({
          workspacePath: this.workspacePath,
          activeAccount: account,
          readSnapshot: this.readSnapshot,
          writeSnapshot: this.writeSnapshot,
          provider: localProvider,
          maxTailBytes: this.maxTailBytes,
          maxSessionFiles: this.maxSessionFiles,
        });
        if (this.lastLocalScanState) {
          this.emitState(this.lastLocalScanState);
          return;
        }
      } catch {
        // Fall through to account-scoped cache or unavailable state.
      } finally {
        localProvider?.dispose();
      }
    }

    const cached = this.readSnapshot('codex', account.id);
    if (cached) {
      this.emitState(
        enrichQuotaState(
          {
            ...cached,
            runtimeProvider: 'codex',
            providerId: 'codex',
            source: 'cache',
            stale: true,
            fiveHourLabel: cached.fiveHourLabel ?? 'Primary',
            sevenDayLabel: cached.sevenDayLabel ?? 'Secondary',
          },
          account,
        ),
      );
      return;
    }

    this.emitState(makeUnavailableState(account));
  }

  private emitState(state: ProviderQuotaState<'codex'>): void {
    const nextKey = JSON.stringify(state);
    if (this.lastEmissionKey === nextKey) return;
    this.lastEmissionKey = nextKey;

    for (const listener of this.listeners) {
      try {
        listener(state);
      } catch {
        // Listener failures should not stop session watching.
      }
    }
  }

  private getProvider(): CodexProvider {
    if (!this.provider) {
      this.provider = this.providerFactory();
    }
    return this.provider;
  }

  private safeGetActiveAccount(): SavedAccountProfile | null {
    try {
      return this.getActiveAccount();
    } catch {
      return null;
    }
  }

  private teardownActiveSession(): void {
    if (this.fileWatcher) {
      this.fileWatcher.close();
      this.fileWatcher = null;
    }
    this.reader?.flush();
    this.reader = null;
    this.provider?.dispose();
    this.provider = null;
    this.sessionPath = null;
  }
}
