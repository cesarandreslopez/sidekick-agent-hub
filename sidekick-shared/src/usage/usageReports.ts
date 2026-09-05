/**
 * Daily, weekly, monthly, and per-session usage rows bucketed from usage
 * events by the time of each event, so a session that crosses midnight is
 * split across the days it actually ran in. Browser-safe: no Node imports.
 *
 * @module usage/usageReports
 */

import { classifyCostProvenance } from '../aggregation/costProvenance';
import type { AggregatedCostProvenance } from '../aggregation/types';
import { formatLocalDateKey } from '../formatting';
import type { ProviderId } from '../providers/types';
import type { TokenTotals } from '../types/historicalData';
import type { UsageEventRecord } from './usageEvents';

export type UsageGranularity = 'day' | 'week' | 'month' | 'session';

/** Extra dimensions a bucket is split by, beyond the time key. */
export type UsageGroupDimension = 'provider' | 'project' | 'model';

export interface BucketUsageOptions {
  granularity: UsageGranularity;
  /** Key by the UTC calendar instead of the local calendar (default false). */
  utc?: boolean;
  /** First day of the week for `week` keys: 0 = Sunday, 1 = Monday (default). */
  weekStartsOn?: 0 | 1;
  /** Dimensions to group by in addition to the time key (default `['provider']`). */
  groupBy?: readonly UsageGroupDimension[];
}

export interface UsageBucketRow {
  /** `YYYY-MM-DD` for days and week starts, `YYYY-MM` for months, the session id for sessions. */
  key: string;
  granularity: UsageGranularity;
  provider: ProviderId | null;
  project: string | null;
  /** Set when grouping by model; null for rows spanning every model. */
  model: string | null;
  /** Session id for `session` rows; null otherwise. */
  sessionId: string | null;
  /** Models seen in the row, most tokens first. */
  models: string[];
  calls: number;
  /** Distinct sessions contributing to the row. */
  sessions: number;
  tokens: TokenTotals;
  /** Provider-semantics-aware total (`summarizeTokens().total`). */
  totalTokens: number;
  /** Priced portion of the cost; read `costProvenance` before labelling it. */
  costUsd: number;
  costProvenance: AggregatedCostProvenance;
  unpricedCalls: number;
  /** First and last event in the row, ms since epoch. */
  firstTimestamp: number;
  lastTimestamp: number;
}

export interface UsageTotals {
  calls: number;
  sessions: number;
  tokens: TokenTotals;
  totalTokens: number;
  costUsd: number;
  costProvenance: AggregatedCostProvenance;
  unpricedCalls: number;
}

interface Accumulator {
  row: UsageBucketRow;
  sessionIds: Set<string>;
  modelTokens: Map<string, number>;
  reportedCalls: number;
  estimatedCalls: number;
}

interface DayParts {
  year: number;
  month: number;
  day: number;
  weekday: number;
}

function dayParts(ms: number, utc: boolean): DayParts {
  const date = new Date(ms);
  return utc
    ? {
        year: date.getUTCFullYear(),
        month: date.getUTCMonth(),
        day: date.getUTCDate(),
        weekday: date.getUTCDay(),
      }
    : {
        year: date.getFullYear(),
        month: date.getMonth(),
        day: date.getDate(),
        weekday: date.getDay(),
      };
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** The `YYYY-MM-DD` key of the week containing `ms`, starting on `weekStartsOn`. */
export function weekKey(ms: number, options: { utc?: boolean; weekStartsOn?: 0 | 1 } = {}): string {
  const utc = options.utc ?? false;
  const start = options.weekStartsOn ?? 1;
  const parts = dayParts(ms, utc);
  const offset = (parts.weekday - start + 7) % 7;
  if (utc) {
    return new Date(Date.UTC(parts.year, parts.month, parts.day - offset))
      .toISOString()
      .slice(0, 10);
  }
  return formatLocalDateKey(new Date(parts.year, parts.month, parts.day - offset));
}

/** The time key for one event at the requested granularity. */
export function usageBucketKey(
  event: Pick<UsageEventRecord, 'timestamp' | 'sessionId'>,
  options: BucketUsageOptions,
): string {
  const utc = options.utc ?? false;
  switch (options.granularity) {
    case 'session':
      return event.sessionId;
    case 'week':
      return weekKey(event.timestamp, { utc, weekStartsOn: options.weekStartsOn });
    case 'month': {
      const parts = dayParts(event.timestamp, utc);
      return `${parts.year}-${pad(parts.month + 1)}`;
    }
    case 'day':
    default:
      return utc
        ? new Date(event.timestamp).toISOString().slice(0, 10)
        : formatLocalDateKey(event.timestamp);
  }
}

function emptyTokens(): TokenTotals {
  return { inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0 };
}

function addTokens(target: TokenTotals, source: TokenTotals): void {
  target.inputTokens += source.inputTokens;
  target.outputTokens += source.outputTokens;
  target.cacheWriteTokens += source.cacheWriteTokens;
  target.cacheReadTokens += source.cacheReadTokens;
}

/**
 * Group usage events into rows. Rows are sorted by key (sessions by first
 * event), then provider, project, and model, so tables read oldest first.
 */
export function bucketUsage(
  events: readonly UsageEventRecord[],
  options: BucketUsageOptions,
): UsageBucketRow[] {
  const groupBy = new Set(options.groupBy ?? ['provider']);
  const isSession = options.granularity === 'session';
  const byProvider = isSession || groupBy.has('provider');
  const byProject = isSession || groupBy.has('project');
  const byModel = groupBy.has('model');
  const buckets = new Map<string, Accumulator>();

  for (const event of events) {
    const key = usageBucketKey(event, options);
    const provider = byProvider ? event.provider : null;
    const project = byProject ? event.project : null;
    const model = byModel ? event.model : null;
    const id = [key, provider ?? '', project ?? '', model ?? ''].join('|');

    let acc = buckets.get(id);
    if (!acc) {
      acc = {
        row: {
          key,
          granularity: options.granularity,
          provider,
          project,
          model,
          sessionId: isSession ? event.sessionId : null,
          models: [],
          calls: 0,
          sessions: 0,
          tokens: emptyTokens(),
          totalTokens: 0,
          costUsd: 0,
          costProvenance: 'none',
          unpricedCalls: 0,
          firstTimestamp: event.timestamp,
          lastTimestamp: event.timestamp,
        },
        sessionIds: new Set(),
        modelTokens: new Map(),
        reportedCalls: 0,
        estimatedCalls: 0,
      };
      buckets.set(id, acc);
    }

    const { row } = acc;
    row.calls += 1;
    addTokens(row.tokens, event.tokens);
    row.totalTokens += event.tokens.totalTokens;
    row.firstTimestamp = Math.min(row.firstTimestamp, event.timestamp);
    row.lastTimestamp = Math.max(row.lastTimestamp, event.timestamp);
    acc.sessionIds.add(event.sessionId);
    acc.modelTokens.set(
      event.model,
      (acc.modelTokens.get(event.model) ?? 0) + event.tokens.totalTokens,
    );
    if (event.costUsd !== null) {
      row.costUsd += event.costUsd;
      if (event.costProvenance === 'provider-reported') acc.reportedCalls += 1;
      else acc.estimatedCalls += 1;
    } else {
      row.unpricedCalls += 1;
    }
  }

  const rows: UsageBucketRow[] = [];
  for (const acc of buckets.values()) {
    acc.row.sessions = acc.sessionIds.size;
    acc.row.models = [...acc.modelTokens.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([model]) => model);
    acc.row.costProvenance = classifyCostProvenance({
      reportedCalls: acc.reportedCalls,
      estimatedCalls: acc.estimatedCalls,
      unpricedCalls: acc.row.unpricedCalls,
    });
    rows.push(acc.row);
  }
  return rows.sort(
    (a, b) =>
      (isSession ? a.firstTimestamp - b.firstTimestamp : a.key.localeCompare(b.key)) ||
      (a.provider ?? '').localeCompare(b.provider ?? '') ||
      (a.project ?? '').localeCompare(b.project ?? '') ||
      (a.model ?? '').localeCompare(b.model ?? ''),
  );
}

/**
 * Sum rows that do not overlap (for example every row of one `bucketUsage`
 * call). Pass the events too when rows are not per-session, so distinct
 * sessions are counted once instead of once per row they appear in.
 */
export function summarizeUsageRows(
  rows: readonly UsageBucketRow[],
  events?: readonly UsageEventRecord[],
): UsageTotals {
  const totals: UsageTotals = {
    calls: 0,
    sessions: 0,
    tokens: emptyTokens(),
    totalTokens: 0,
    costUsd: 0,
    costProvenance: 'none',
    unpricedCalls: 0,
  };
  let reportedCalls = 0;
  let estimatedCalls = 0;
  const sessionIds = new Set<string>();
  for (const row of rows) {
    totals.calls += row.calls;
    addTokens(totals.tokens, row.tokens);
    totals.totalTokens += row.totalTokens;
    totals.costUsd += row.costUsd;
    totals.unpricedCalls += row.unpricedCalls;
    const priced = row.calls - row.unpricedCalls;
    if (row.costProvenance === 'reported') reportedCalls += priced;
    else if (row.costProvenance === 'estimated') estimatedCalls += priced;
    else if (row.costProvenance === 'mixed') {
      reportedCalls += 1;
      estimatedCalls += 1;
    }
    if (row.sessionId) sessionIds.add(row.sessionId);
  }
  if (events) {
    for (const event of events) sessionIds.add(event.sessionId);
    totals.sessions = sessionIds.size;
  } else {
    totals.sessions = sessionIds.size || rows.reduce((sum, row) => sum + row.sessions, 0);
  }
  totals.costProvenance = classifyCostProvenance({
    reportedCalls,
    estimatedCalls,
    unpricedCalls: totals.unpricedCalls,
  });
  return totals;
}
