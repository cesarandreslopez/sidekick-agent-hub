/**
 * Reader/writer for persisted plan history.
 */

import * as fs from 'fs';
import type { PersistedPlan, PlanHistoryStore } from '../types/plan';
import { PLAN_SCHEMA_VERSION, MAX_PLANS_PER_PROJECT } from '../types/plan';
import { getProjectDataPath } from '../paths';
import { readJsonStore } from './helpers';

export interface ReadPlansOptions {
  status?: 'in_progress' | 'completed' | 'failed' | 'abandoned' | 'all';
  source?: 'claude-code' | 'opencode' | 'codex';
  limit?: number;
}

export async function readPlans(slug: string, opts?: ReadPlansOptions): Promise<PersistedPlan[]> {
  const filePath = getProjectDataPath(slug, 'plans');
  const store = await readJsonStore<PlanHistoryStore>(filePath);
  if (!store) return [];

  let plans = [...store.plans];

  const status = opts?.status ?? 'all';
  if (status !== 'all') {
    plans = plans.filter(p => p.status === status);
  }

  if (opts?.source) {
    plans = plans.filter(p => p.source === opts.source);
  }

  // Already sorted by createdAt desc in storage
  if (opts?.limit && opts.limit > 0) {
    plans = plans.slice(0, opts.limit);
  }

  return plans;
}

export async function getLatestPlan(slug: string): Promise<PersistedPlan | null> {
  const plans = await readPlans(slug, { limit: 1 });
  return plans[0] ?? null;
}

export interface PlanAnalytics {
  totalPlans: number;
  completedPlans: number;
  failedPlans: number;
  abandonedPlans: number;
  avgCompletionRate: number;
  avgDurationMs: number;
  avgStepsPerPlan: number;
  avgTokensPerPlan: number;
  avgCostPerPlan: number;
  plansBySource: Record<string, number>;
  mostCommonFailureStep: string | null;
  completionTrend: Array<{ date: string; rate: number }>;
}

export function getPlanAnalytics(plans: PersistedPlan[]): PlanAnalytics {
  const totalPlans = plans.length;

  if (totalPlans === 0) {
    return {
      totalPlans: 0, completedPlans: 0, failedPlans: 0, abandonedPlans: 0,
      avgCompletionRate: 0, avgDurationMs: 0, avgStepsPerPlan: 0,
      avgTokensPerPlan: 0, avgCostPerPlan: 0,
      plansBySource: {}, mostCommonFailureStep: null, completionTrend: [],
    };
  }

  const completedPlans = plans.filter(p => p.status === 'completed').length;
  const failedPlans = plans.filter(p => p.status === 'failed').length;
  const abandonedPlans = plans.filter(p => p.status === 'abandoned').length;

  const avgCompletionRate = plans.reduce((s, p) => s + p.completionRate, 0) / totalPlans;

  const plansWithDuration = plans.filter(p => p.totalDurationMs != null && p.totalDurationMs > 0);
  const avgDurationMs = plansWithDuration.length > 0
    ? plansWithDuration.reduce((s, p) => s + (p.totalDurationMs || 0), 0) / plansWithDuration.length
    : 0;

  const avgStepsPerPlan = plans.reduce((s, p) => s + p.steps.length, 0) / totalPlans;

  const plansWithTokens = plans.filter(p => p.totalTokensUsed != null && p.totalTokensUsed > 0);
  const avgTokensPerPlan = plansWithTokens.length > 0
    ? plansWithTokens.reduce((s, p) => s + (p.totalTokensUsed || 0), 0) / plansWithTokens.length
    : 0;

  const plansWithCost = plans.filter(p => p.totalCostUsd != null && p.totalCostUsd > 0);
  const avgCostPerPlan = plansWithCost.length > 0
    ? plansWithCost.reduce((s, p) => s + (p.totalCostUsd || 0), 0) / plansWithCost.length
    : 0;

  // Plans by source
  const plansBySource: Record<string, number> = {};
  for (const p of plans) {
    plansBySource[p.source] = (plansBySource[p.source] || 0) + 1;
  }

  // Most common failure step (which step index fails most)
  const failureCounts = new Map<number, number>();
  for (const p of plans) {
    for (let i = 0; i < p.steps.length; i++) {
      if (p.steps[i].status === 'failed') {
        failureCounts.set(i, (failureCounts.get(i) || 0) + 1);
      }
    }
  }
  let mostCommonFailureStep: string | null = null;
  if (failureCounts.size > 0) {
    let maxCount = 0;
    let maxIdx = 0;
    for (const [idx, count] of failureCounts) {
      if (count > maxCount) { maxCount = count; maxIdx = idx; }
    }
    mostCommonFailureStep = `Step ${maxIdx + 1}`;
  }

  // Completion trend (grouped by date)
  const byDate = new Map<string, { sum: number; count: number }>();
  for (const p of plans) {
    const date = p.createdAt.substring(0, 10); // YYYY-MM-DD
    const existing = byDate.get(date) || { sum: 0, count: 0 };
    existing.sum += p.completionRate;
    existing.count += 1;
    byDate.set(date, existing);
  }
  const completionTrend = Array.from(byDate.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, { sum, count }]) => ({ date, rate: sum / count }));

  return {
    totalPlans, completedPlans, failedPlans, abandonedPlans,
    avgCompletionRate, avgDurationMs, avgStepsPerPlan,
    avgTokensPerPlan, avgCostPerPlan,
    plansBySource, mostCommonFailureStep, completionTrend,
  };
}

export async function writePlans(slug: string, plans: PersistedPlan[]): Promise<void> {
  const filePath = getProjectDataPath(slug, 'plans');

  // Sort by createdAt desc and cap
  const sorted = [...plans].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );
  const capped = sorted.slice(0, MAX_PLANS_PER_PROJECT);

  const store: PlanHistoryStore = {
    schemaVersion: PLAN_SCHEMA_VERSION,
    plans: capped,
    lastSaved: new Date().toISOString(),
  };

  // Ensure directory exists
  const dir = filePath.replace(/[/\\][^/\\]+$/, '');
  await fs.promises.mkdir(dir, { recursive: true });

  await fs.promises.writeFile(filePath, JSON.stringify(store, null, 2), 'utf-8');
}
