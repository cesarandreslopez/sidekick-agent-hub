/**
 * Types for the Plans webview panel.
 */

import type { PlanStepStatus, PlanStepComplexity, PlanStatus, PlanSource } from './plan';

export interface PlanStepCard {
  id: string;
  description: string;
  status: PlanStepStatus;
  phase?: string;
  complexity?: PlanStepComplexity;
}

export interface ActivePlanDisplay {
  title: string;
  active: boolean;
  completionRate: number;
  steps: PlanStepCard[];
  source?: PlanSource;
  rawMarkdown?: string;
}

export interface PlanHistoryEntry {
  id: string;
  title: string;
  status: PlanStatus;
  source: PlanSource;
  completionRate: number;
  createdAt: string;
  completedAt?: string;
  steps: PlanStepCard[];
  totalDurationMs?: number;
  totalTokensUsed?: number;
  totalToolCalls?: number;
  totalCostUsd?: number;
  rawMarkdown?: string;
}

export interface PlanBoardState {
  activePlan: ActivePlanDisplay | null;
  historicalPlans: PlanHistoryEntry[];
  sessionActive: boolean;
}

export type PlanBoardMessage =
  | { type: 'updatePlanBoard'; state: PlanBoardState }
  | { type: 'sessionStart'; sessionPath: string }
  | { type: 'sessionEnd' };

export type WebviewPlanBoardMessage =
  | { type: 'webviewReady' }
  | { type: 'refresh' }
  | { type: 'copyPlanMarkdown'; planId: string };
