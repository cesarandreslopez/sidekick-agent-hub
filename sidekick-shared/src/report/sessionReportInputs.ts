/**
 * Everything an HTML session report needs, from one read of the session.
 *
 * `sidekick report`, the CLI dashboard's report action, and the extension used
 * to replay a session through a watcher for metrics and then parse the file a
 * second time for the transcript. This reads the provider's canonical events
 * once and derives both.
 *
 * @module report/sessionReportInputs
 */

import { EventAggregator } from '../aggregation/EventAggregator';
import type { AggregatedMetrics } from '../aggregation/types';
import type { SessionProviderBase } from '../providers/types';
import { providerContextSizeFn } from '../sessionStats';
import type { SessionEvent } from '../types/sessionEvent';
import { parseTranscriptFromEvents } from './transcriptParser';
import type { TranscriptEntry } from './types';

export interface SessionReportInputs {
  sessionPath: string;
  /** Canonical provider events, already flushed. */
  events: SessionEvent[];
  metrics: AggregatedMetrics;
  transcript: TranscriptEntry[];
}

/** Read a session once and build the aggregator metrics and report transcript from it. */
export function readSessionReportInputs(
  provider: SessionProviderBase,
  sessionPath: string,
): SessionReportInputs {
  const reader = provider.createReader(sessionPath);
  const events = reader.readAll();
  reader.flush();

  const aggregator = new EventAggregator({
    providerId: provider.id,
    computeContextSize: providerContextSizeFn(provider),
  });
  for (const event of events) aggregator.processEvent(event);

  return {
    sessionPath,
    events,
    metrics: aggregator.getMetrics(),
    transcript: parseTranscriptFromEvents(events),
  };
}
