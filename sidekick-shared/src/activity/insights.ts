/**
 * Full-session statistics: where the time, the faults and the context went.
 *
 * Read from the reducer state, never from a snapshot (a snapshot keeps only
 * the newest entries). Busy time is wall-clock time with at least one call
 * open at a station, so parallel calls are not counted twice; `callMs` adds
 * call durations up. Percentiles come from a log₂ histogram and are upper
 * bounds of their bucket.
 *
 * Pure.
 *
 * @module activity/insights
 */

import { ACTIVITY_STATIONS } from './stations';
import {
  bucketUpperMs,
  copyPattern,
  type InternalActivityState,
  type StationAccumulator,
} from './state';
import type { ActivityInsights, ActivityState, ActivityStationInsight } from './types';

function openBusyMs(acc: { busySince?: number; busyOpen?: number }, at: number): number {
  return acc.busyOpen && acc.busyOpen > 0 && acc.busySince !== undefined
    ? Math.max(0, at - acc.busySince)
    : 0;
}

function percentile(histogram: readonly number[], share: number): number | undefined {
  const total = histogram.reduce((sum, count) => sum + count, 0);
  if (total === 0) return undefined;
  const target = Math.ceil(total * share);
  let seen = 0;
  for (let bucket = 0; bucket < histogram.length; bucket++) {
    seen += histogram[bucket];
    if (seen >= target) return bucketUpperMs(bucket);
  }
  return bucketUpperMs(histogram.length - 1);
}

function stationInsight(
  id: ActivityStationInsight['id'],
  acc: StationAccumulator,
  at: number,
  totalBusy: number,
): ActivityStationInsight {
  const busyMs = acc.busyMs + openBusyMs(acc, at);
  const avgMs = acc.timed > 0 ? Math.round(acc.callMs / acc.timed) : undefined;
  const p95Ms = percentile(acc.histogram, 0.95);
  const topLabels = [...acc.labels]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .slice(0, 5)
    .map(([label, count]) => ({ label, count }));
  return {
    id,
    calls: acc.calls,
    errors: acc.errors,
    denials: acc.denials,
    cancelled: acc.cancelled,
    busyMs,
    callMs: acc.callMs,
    shareOfBusy: totalBusy > 0 ? Math.min(1, busyMs / totalBusy) : 0,
    resultChars: acc.resultChars,
    estTokens: Math.round(acc.resultChars / 4),
    ...(avgMs !== undefined ? { avgMs } : {}),
    ...(p95Ms !== undefined ? { p95Ms } : {}),
    topLabels,
  };
}

export function summarizeActivity(state: ActivityState): ActivityInsights {
  const s = state as InternalActivityState;
  const at = s.at;
  const activeMs =
    s.globalBusy.busyMs +
    openBusyMs({ busyOpen: s.globalBusy.open, busySince: s.globalBusy.since }, at);
  const stations = ACTIVITY_STATIONS.map((id) => stationInsight(id, s.stations[id], at, activeMs));
  const models = Object.entries(s.models)
    .map(([model, value]) => ({
      model,
      steps: value.steps,
      firstAt: value.firstAt,
      lastAt: value.lastAt,
    }))
    .sort((a, b) => a.firstAt - b.firstAt || (a.model < b.model ? -1 : 1));
  return {
    schemaVersion: 1,
    ...(s.providerId ? { providerId: s.providerId } : {}),
    ...(s.sessionId ? { sessionId: s.sessionId } : {}),
    span: {
      ...(s.startedAt !== undefined ? { startAt: s.startedAt } : {}),
      ...(s.startedAt !== undefined ? { endAt: at } : {}),
      activeMs,
    },
    totals: {
      prompts: s.totals.prompts,
      turns: s.totals.turns,
      steps: s.totals.steps,
      calls: s.totals.calls,
      errors: s.totals.errors,
      denials: s.totals.denials,
      cancelled: s.totals.cancelled,
      asks: s.totals.asks,
      resultChars: s.totals.resultChars,
      hookRuns: s.totals.hookRuns,
      hookMs: s.totals.hookMs,
      pushed: s.totals.pushed,
      compactions: s.compactions,
      subagents: s.totals.subagents,
    },
    stations,
    transitions: {
      stations: [...ACTIVITY_STATIONS],
      counts: s.transitions.map((row) => [...row]),
    },
    patterns: s.patterns.map(copyPattern),
    models,
    slowest: s.slowest.map((call) => ({ ...call })),
  };
}
