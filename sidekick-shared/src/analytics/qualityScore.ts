import type { AggregatedMetrics } from '../aggregation/types';
import type { SessionHistoryRecord } from '../types/historicalData';

export type QualityFactorId =
  | 'latency'
  | 'reliability'
  | 'context'
  | 'permission_safety'
  | 'outcomes';

export interface QualityFactorContribution {
  id: QualityFactorId;
  label: string;
  contribution: number;
  maximum: number;
  detail: string;
}

export interface SessionQualityScore {
  /** Composite score. Beta until weights are calibrated against durable history. */
  score: number;
  beta: true;
  factors: QualityFactorContribution[];
}

export interface QualityTrend {
  currentWeekAverage: number | null;
  previousWeekAverage: number | null;
  delta: number | null;
  direction: 'improving' | 'declining' | 'flat' | 'insufficient';
  currentWeekSessions: number;
  previousWeekSessions: number;
}

function awarded(maximum: number, ratio: number): number {
  return Math.round(maximum * Math.max(0, Math.min(1, ratio)) * 10) / 10;
}

export function scoreSessionQuality(metrics: AggregatedMetrics): SessionQualityScore {
  const latencyMs = metrics.latencyStats?.avgFirstTokenLatencyMs ?? 0;
  const latencyRatio = latencyMs > 0 ? 1 - Math.min(1, latencyMs / 15_000) : 1;

  const completedCalls = metrics.toolStats.reduce((sum, tool) => sum + tool.completedCount, 0);
  const errorRate = completedCalls > 0 ? metrics.errorRollup.totalFailures / completedCalls : 0;

  const contextTokens = Math.max(
    1,
    metrics.tokens.inputTokens + metrics.tokens.cacheReadTokens + metrics.tokens.cacheWriteTokens,
  );
  const evicted = metrics.compactionEvents.reduce((sum, event) => sum + event.tokensReclaimed, 0);
  const contextRatio = 1 - Math.min(1, evicted / contextTokens);

  const start = metrics.sessionStartTime ? Date.parse(metrics.sessionStartTime) : NaN;
  const end = metrics.lastEventTime ? Date.parse(metrics.lastEventTime) : NaN;
  let bypassMs = 0;
  for (let index = 0; index < metrics.permissionModeHistory.length; index++) {
    const change = metrics.permissionModeHistory[index];
    if (change.mode !== 'bypassPermissions') continue;
    const from = Date.parse(change.timestamp);
    const to = Date.parse(
      metrics.permissionModeHistory[index + 1]?.timestamp ?? metrics.lastEventTime ?? '',
    );
    if (Number.isFinite(from) && Number.isFinite(to)) bypassMs += Math.max(0, to - from);
  }
  const sessionMs = Number.isFinite(start) && Number.isFinite(end) ? Math.max(1, end - start) : 1;
  const bypassRatio = Math.min(1, bypassMs / sessionMs);

  const tasks = Array.from(metrics.taskState.tasks.values()).filter(
    (task) => task.status !== 'deleted',
  );
  const completedTasks = tasks.filter((task) => task.status === 'completed').length;
  const goalGates = tasks.filter((task) => task.isGoalGate);
  const completedGates = goalGates.filter((task) => task.status === 'completed').length;
  const taskRatio = tasks.length > 0 ? completedTasks / tasks.length : 1;
  const goalRatio = goalGates.length > 0 ? completedGates / goalGates.length : taskRatio;
  const outcomeRatio = taskRatio * 0.6 + goalRatio * 0.4;

  const factors: QualityFactorContribution[] = [
    {
      id: 'latency',
      label: 'Response latency',
      contribution: awarded(15, latencyRatio),
      maximum: 15,
      detail:
        latencyMs > 0 ? `${Math.round(latencyMs)}ms average first token` : 'No latency penalty',
    },
    {
      id: 'reliability',
      label: 'Tool reliability',
      contribution: awarded(30, 1 - Math.min(1, errorRate * 2)),
      maximum: 30,
      detail: `${metrics.errorRollup.totalFailures}/${completedCalls} completed tool calls failed`,
    },
    {
      id: 'context',
      label: 'Context stability',
      contribution: awarded(15, contextRatio),
      maximum: 15,
      detail: `${metrics.compactionCount} compactions, ${evicted} tokens evicted`,
    },
    {
      id: 'permission_safety',
      label: 'Permission safety',
      contribution: awarded(10, 1 - bypassRatio),
      maximum: 10,
      detail: `${Math.round(bypassRatio * 100)}% of observed time bypassing permissions`,
    },
    {
      id: 'outcomes',
      label: 'Task outcomes',
      contribution: awarded(30, outcomeRatio),
      maximum: 30,
      detail: `${completedTasks}/${tasks.length} tasks and ${completedGates}/${goalGates.length} goal gates completed`,
    },
  ];
  return {
    score: Math.round(factors.reduce((sum, factor) => sum + factor.contribution, 0)),
    beta: true,
    factors,
  };
}

export function calculateQualityTrend(
  records: SessionHistoryRecord[],
  now = new Date(),
): QualityTrend {
  const end = now.getTime();
  const week = 7 * 24 * 60 * 60 * 1000;
  const eligible = records.filter(
    (record) => record.qualityScore > 0 && Number.isFinite(Date.parse(record.endTime)),
  );
  const current = eligible.filter((record) => {
    const at = Date.parse(record.endTime);
    return at >= end - week && at <= end;
  });
  const previous = eligible.filter((record) => {
    const at = Date.parse(record.endTime);
    return at >= end - 2 * week && at < end - week;
  });
  const average = (items: SessionHistoryRecord[]): number | null =>
    items.length > 0
      ? Math.round((items.reduce((sum, item) => sum + item.qualityScore, 0) / items.length) * 10) /
        10
      : null;
  const currentWeekAverage = average(current);
  const previousWeekAverage = average(previous);
  const delta =
    currentWeekAverage != null && previousWeekAverage != null
      ? Math.round((currentWeekAverage - previousWeekAverage) * 10) / 10
      : null;
  return {
    currentWeekAverage,
    previousWeekAverage,
    delta,
    direction:
      delta == null
        ? 'insufficient'
        : delta > 0.5
          ? 'improving'
          : delta < -0.5
            ? 'declining'
            : 'flat',
    currentWeekSessions: current.length,
    previousWeekSessions: previous.length,
  };
}
