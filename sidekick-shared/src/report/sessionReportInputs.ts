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

import { createActivityRecorder } from '../activity/recorder';
import { summarizeActivity } from '../activity/insights';
import { applyActivityRecords, createActivityState, snapshotActivity } from '../activity/state';
import { normalizeActivityRecords } from '../activity/timeline';
import type { ActivityInsights, ActivitySnapshot } from '../activity/types';
import { EventAggregator } from '../aggregation/EventAggregator';
import type { AggregatedMetrics } from '../aggregation/types';
import type { SessionProviderBase } from '../providers/types';
import { providerContextSizeFn } from '../sessionStats';
import type { SessionEvent, SubagentStats } from '../types/sessionEvent';
import { scanSessionSubagents } from '../sessionTokenTotals';
import { parseTranscriptFromEvents } from './transcriptParser';
import type { TranscriptEntry } from './types';

export interface SessionReportInputs {
  sessionPath: string;
  /** Canonical provider events, already flushed. */
  events: SessionEvent[];
  metrics: AggregatedMetrics;
  transcript: TranscriptEntry[];
  /** The session's subagents; pass as `HtmlReportOptions.subagents` for the session total. */
  subagents: SubagentStats[];
  /**
   * The session's activity map at its last event (main transcript only; use
   * `replayActivity` to merge subagent transcripts). Pass as
   * `HtmlReportOptions.activity`.
   */
  activity: { snapshot: ActivitySnapshot; insights: ActivityInsights };
}

/** Read a session once and build the aggregator metrics and report transcript from it. */
export function readSessionReportInputs(
  provider: SessionProviderBase,
  sessionPath: string,
): SessionReportInputs {
  // Hook runs and pushed memory feed the activity map; the aggregator and the
  // transcript skip those events.
  const reader = provider.createReader(sessionPath, { includeActivitySignals: true });
  const events = reader.readAll();
  reader.flush();

  const aggregator = new EventAggregator({
    providerId: provider.id,
    computeContextSize: providerContextSizeFn(provider),
  });
  for (const event of events) aggregator.processEvent(event);

  const recorder = createActivityRecorder({
    providerId: provider.id,
    sessionId: provider.getSessionId(sessionPath),
  });
  const activityState = createActivityState();
  applyActivityRecords(activityState, normalizeActivityRecords(recorder.observeMany(events)));

  return {
    sessionPath,
    events,
    metrics: aggregator.getMetrics(),
    transcript: parseTranscriptFromEvents(events),
    subagents: scanSessionSubagents(provider, sessionPath),
    activity: {
      snapshot: snapshotActivity(activityState),
      insights: summarizeActivity(activityState),
    },
  };
}
