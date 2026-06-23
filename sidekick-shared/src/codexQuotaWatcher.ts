import * as fs from 'fs';
import type { FSWatcher } from 'fs';
import { getActiveCodexAccount } from './codexProfiles';
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

const DEFAULT_DISCOVERY_POLL_INTERVAL_MS = 30_000;

type CodexAccountReader = () => SavedAccountProfile | null;
type SnapshotReader = (providerId: 'codex', accountId: string) => QuotaState | null;
type SnapshotWriter = (providerId: 'codex', accountId: string, quota: QuotaState) => void;
type HistoryAppender = (sample: QuotaHistorySample) => void | Promise<void>;
type WatchFile = (filename: fs.PathLike, listener: fs.WatchListener<string>) => FSWatcher;

export interface CodexQuotaWatcherOptions {
  discoveryPollIntervalMs?: number;
  maxTailBytes?: number;
  maxSessionFiles?: number;
  providerFactory?: () => CodexProvider;
  getActiveAccount?: CodexAccountReader;
  readSnapshot?: SnapshotReader;
  writeSnapshot?: SnapshotWriter;
  watchFile?: WatchFile;
  /** Stable workspace identifier. When provided, live quotas are appended to the per-workspace history JSONL. */
  workspaceId?: string;
  /** Override the history append function (used by tests). Default: `appendQuotaHistorySample`. */
  appendHistorySample?: HistoryAppender;
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
  private readonly workspaceId: string | undefined;
  private readonly appendHistorySample: HistoryAppender;
  private readonly listeners: Array<(state: ProviderQuotaState<'codex'>) => void> = [];

  private discoveryTimer: ReturnType<typeof setInterval> | undefined;
  private provider: CodexProvider | null = null;
  private reader: SessionReader | null = null;
  private fileWatcher: FSWatcher | null = null;
  private sessionPath: string | null = null;
  private lastEmissionKey: string | null = null;
  private running = false;

  constructor(workspacePath: string, options: CodexQuotaWatcherOptions = {}) {
    this.workspacePath = workspacePath;
    this.discoveryPollIntervalMs =
      options.discoveryPollIntervalMs ?? DEFAULT_DISCOVERY_POLL_INTERVAL_MS;
    this.providerFactory = options.providerFactory ?? (() => new CodexProvider());
    this.getActiveAccount = options.getActiveAccount ?? getActiveCodexAccount;
    this.readSnapshot = options.readSnapshot ?? readQuotaSnapshot;
    this.writeSnapshot = options.writeSnapshot ?? writeQuotaSnapshot;
    this.watchFile = options.watchFile ?? fs.watch;
    this.maxTailBytes = options.maxTailBytes;
    this.maxSessionFiles = options.maxSessionFiles;
    this.workspaceId = options.workspaceId;
    this.appendHistorySample = options.appendHistorySample ?? appendQuotaHistorySample;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.refreshActiveSession();
    this.discoveryTimer = setInterval(() => {
      this.refreshActiveSession();
    }, this.discoveryPollIntervalMs);
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.discoveryTimer) {
      clearInterval(this.discoveryTimer);
      this.discoveryTimer = undefined;
    }
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
    this.refreshActiveSession();
  }

  private refreshActiveSession(): void {
    const provider = this.getProvider();
    const nextSessionPath = provider.findActiveSession(this.workspacePath);

    if (!nextSessionPath) {
      this.teardownActiveSession();
      this.emitCachedOrUnavailable();
      return;
    }

    if (nextSessionPath !== this.sessionPath || this.reader == null) {
      this.attachToSession(nextSessionPath);
      return;
    }

    this.ingestSessionUpdate('readNew');
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
    } catch {
      this.emitCachedOrUnavailable();
    }
  }

  private ingestSessionUpdate(mode: 'readAll' | 'readNew'): void {
    if (!this.provider || !this.reader) {
      this.emitCachedOrUnavailable();
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
      this.emitCachedOrUnavailable();
      return;
    }

    const account = this.getActiveAccount();
    if (account) {
      this.writeSnapshot('codex', account.id, liveQuota);
      if (this.workspaceId) {
        const sample: QuotaHistorySample = {
          timestamp: liveQuota.capturedAt ?? new Date().toISOString(),
          runtimeProvider: 'codex',
          providerId: account.id,
          workspaceId: this.workspaceId,
          fiveHour: {
            utilization: liveQuota.fiveHour.utilization,
            resetsAt: liveQuota.fiveHour.resetsAt,
          },
          sevenDay: {
            utilization: liveQuota.sevenDay.utilization,
            resetsAt: liveQuota.sevenDay.resetsAt,
          },
          available: liveQuota.available,
          error: liveQuota.error,
          source: liveQuota.source,
          stale: liveQuota.stale,
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
    }

    this.emitState(
      enrichQuotaState(
        {
          ...liveQuota,
          runtimeProvider: 'codex',
          providerId: 'codex',
        },
        account,
      ),
    );
  }

  private emitCachedOrUnavailable(): void {
    const account = this.getActiveAccount();
    let localProvider: CodexProvider | null = null;
    try {
      localProvider = this.providerFactory();
      const local = resolveCodexQuotaFromLocalSources({
        workspacePath: this.workspacePath,
        activeAccount: account,
        readSnapshot: this.readSnapshot,
        writeSnapshot: this.writeSnapshot,
        provider: localProvider,
        maxTailBytes: this.maxTailBytes,
        maxSessionFiles: this.maxSessionFiles,
      });
      if (local) {
        this.emitState(local);
        return;
      }
    } catch {
      // Fall through to account-scoped cache or unavailable state.
    } finally {
      localProvider?.dispose();
    }

    const cached = account ? this.readSnapshot('codex', account.id) : null;
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
