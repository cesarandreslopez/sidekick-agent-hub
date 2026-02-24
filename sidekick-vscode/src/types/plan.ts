/**
 * Types for plan persistence. Mirrors sidekick-shared/src/types/plan.ts.
 */

export const PLAN_SCHEMA_VERSION = 1;
export const MAX_PLANS_PER_PROJECT = 50;

export type PlanStepStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'skipped';
export type PlanStatus = 'in_progress' | 'completed' | 'failed' | 'abandoned';
export type PlanSource = 'claude-code' | 'opencode' | 'codex';
export type PlanStepComplexity = 'low' | 'medium' | 'high';

export interface PersistedPlanStep {
  id: string;
  description: string;
  status: PlanStepStatus;
  phase?: string;
  complexity?: PlanStepComplexity;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  output?: string;
  tokensUsed?: number;
  toolCalls?: number;
  errorMessage?: string;
  costUsd?: number;
}

export interface PersistedPlan {
  id: string;
  projectSlug: string;
  sessionId: string;
  title: string;
  source: PlanSource;
  prompt?: string;
  createdAt: string;
  completedAt?: string;
  status: PlanStatus;
  steps: PersistedPlanStep[];
  completionRate: number;
  totalDurationMs?: number;
  totalTokensUsed?: number;
  totalToolCalls?: number;
  totalCostUsd?: number;
  rawMarkdown?: string;
}

export interface PlanHistoryStore {
  schemaVersion: number;
  plans: PersistedPlan[];
  lastSaved: string;
}
