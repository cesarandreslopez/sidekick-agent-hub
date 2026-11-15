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
  /** A raw plan file with no recorded run: it has no meaningful status. */
  rawOnly?: boolean;
  /** Host-formatted metrics (shared formatters). */
  durationLabel?: string;
  tokensLabel?: string;
  costLabel?: string;
}

export interface PlanBoardState {
  activePlan: ActivePlanDisplay | null;
  historicalPlans: PlanHistoryEntry[];
  sessionActive: boolean;
  /** Live / Viewing / No session label for the attached session. */
  sessionStatus?: string;
}

export type PlanBoardMessage =
  | { type: 'updatePlanBoard'; state: PlanBoardState }
  | { type: 'sessionStart'; sessionPath: string }
  | { type: 'sessionEnd' }
  | { type: 'copied'; planId: string };

export type WebviewPlanBoardMessage =
  | { type: 'webviewReady' }
  | { type: 'refresh' }
  | { type: 'copyPlanMarkdown'; planId: string };
