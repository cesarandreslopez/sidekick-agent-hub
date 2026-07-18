import { EventAggregator } from './aggregation/EventAggregator';
import type { AggregatedMetrics, EventAggregatorOptions } from './aggregation/types';
import type { SessionProviderBase, SessionReader } from './providers/types';
import type { SessionEvent } from './types/sessionEvent';

export interface SessionMonitorOptions extends EventAggregatorOptions {
  replayOnAttach?: boolean;
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
    this.listeners.clear();
    this.reader = null;
    this.provider.dispose();
  }

  private consume(events: SessionEvent[]): void {
    for (const event of events) this.process(event);
  }
}
