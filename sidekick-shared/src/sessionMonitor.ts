import * as fs from 'node:fs';
import { EventAggregator } from './aggregation/EventAggregator';
import type { AggregatedMetrics, EventAggregatorOptions } from './aggregation/types';
import type { SessionProviderBase, SessionReader } from './providers/types';
import type { SessionEvent } from './types/sessionEvent';
import { ObservedSessionCollector, fileFingerprintParts } from './observedSessionCollector';
import type {
  ObservedSessionChangeBatch,
  ObservedSessionCollectionSource,
} from './observedSessionCollector';

export interface SessionMonitorOptions extends EventAggregatorOptions {
  replayOnAttach?: boolean;
}

export interface SessionMonitorSubscribeOptions {
  debounceMs?: number;
  pollIntervalMs?: number;
  onChange?: (batch: ObservedSessionChangeBatch) => void;
}

/**
 * UI-independent session monitor for library consumers. It owns one provider
 * reader and the canonical aggregator; hosts decide how often to call `poll()`.
 */
export class SessionMonitor {
  private readonly aggregator: EventAggregator;
  private reader: SessionReader | null = null;
  private sessionPath: string | null = null;
  private readonly listeners = new Set<(event: SessionEvent) => void>();
  private readonly subscriptions = new Set<{ dispose(): void }>();
  private readonly replayOnAttach: boolean;

  constructor(
    private readonly provider: SessionProviderBase,
    options: SessionMonitorOptions = {},
  ) {
    this.replayOnAttach = options.replayOnAttach ?? true;
    this.aggregator = new EventAggregator({ ...options, providerId: provider.id });
  }

  attach(sessionPath: string, replay = this.replayOnAttach): AggregatedMetrics {
    this.aggregator.reset();
    this.reader = this.provider.createReader(sessionPath);
    this.sessionPath = sessionPath;
    if (replay) this.consume(this.reader.readAll());
    return this.getMetrics();
  }

  attachLatest(workspacePath: string, replay = this.replayOnAttach): AggregatedMetrics | null {
    const sessionPath = this.provider.findActiveSession(workspacePath);
    return sessionPath ? this.attach(sessionPath, replay) : null;
  }

  poll(): SessionEvent[] {
    if (!this.reader) return [];
    if (this.reader.wasTruncated()) this.aggregator.reset();
    const events = this.reader.readNew();
    this.consume(events);
    return events;
  }

  process(event: SessionEvent): void {
    this.aggregator.processEvent(event);
    for (const listener of this.listeners) listener(event);
  }

  onEvent(listener: (event: SessionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Watches the attached session with debouncing and catch-up polling. Matching
   * fingerprint changes automatically call poll(); parsed events still flow
   * through onEvent.
   */
  subscribe(options: SessionMonitorSubscribeOptions = {}): { dispose(): void } {
    const source: ObservedSessionCollectionSource<null> = {
      providerId: this.provider.id,
      discover: async () => {
        if (!this.sessionPath) return [];
        let parts = fileFingerprintParts(this.sessionPath);
        if (!parts) {
          try {
            const metadata = this.provider.getSessionMetadataAsync
              ? await this.provider.getSessionMetadataAsync(this.sessionPath)
              : this.provider.getSessionMetadata?.(this.sessionPath);
            parts = metadata ? { sizeBytes: 0, mtimeMs: metadata.mtime.getTime() } : null;
          } catch {
            parts = null;
          }
        }
        if (!parts) return [];
        return [
          {
            sessionId: this.provider.getSessionId(this.sessionPath),
            sourceKey: this.sessionPath,
            fingerprintHint: `${parts.sizeBytes}:${parts.mtimeMs}`,
            fingerprintParts: parts,
          },
        ];
      },
      read: () => null,
      subscribe: (listener, sourceOptions) => {
        const watchers = new Set<fs.FSWatcher>();
        let pollTimer: ReturnType<typeof setInterval> | null = null;
        let roots: string[];
        try {
          roots = this.provider.getWatchRoots?.() ?? [this.provider.getProjectsBaseDir()];
        } catch {
          roots = [];
        }
        for (const root of new Set(roots)) {
          try {
            const watcher = fs.watch(root, { persistent: false, recursive: true }, listener);
            watchers.add(watcher);
            watcher.on('error', () => {
              watchers.delete(watcher);
              try {
                watcher.close();
              } catch {
                // Collector catch-up polling remains active.
              }
            });
          } catch {
            // Collector catch-up polling remains active.
          }
        }
        const pollIntervalMs = sourceOptions?.pollIntervalMs ?? 0;
        if (pollIntervalMs > 0) {
          pollTimer = setInterval(listener, pollIntervalMs);
          pollTimer.unref?.();
        }
        return {
          dispose: () => {
            for (const watcher of watchers) watcher.close();
            watchers.clear();
            if (pollTimer) clearInterval(pollTimer);
          },
        };
      },
    };
    const collector = new ObservedSessionCollector({ sources: [source] });
    const changeSubscription = collector.subscribe(
      (batch) => {
        if (batch.changes.some((change) => change.reference.sourceKey === this.sessionPath)) {
          this.poll();
        }
        try {
          options.onChange?.(batch);
        } catch {
          // Change callbacks are observational.
        }
      },
      {
        debounceMs: options.debounceMs,
        pollIntervalMs: options.pollIntervalMs,
      },
    );
    const disposable = {
      dispose: (): void => {
        changeSubscription.dispose();
        collector.dispose();
        this.subscriptions.delete(disposable);
      },
    };
    this.subscriptions.add(disposable);
    return disposable;
  }

  getMetrics(): AggregatedMetrics {
    return this.aggregator.getMetrics();
  }

  getSessionPath(): string | null {
    return this.sessionPath;
  }

  reset(): void {
    this.reader?.reset();
    this.aggregator.reset();
  }

  dispose(): void {
    for (const subscription of [...this.subscriptions]) subscription.dispose();
    this.listeners.clear();
    this.reader = null;
    this.provider.dispose();
  }

  private consume(events: SessionEvent[]): void {
    for (const event of events) this.process(event);
  }
}
