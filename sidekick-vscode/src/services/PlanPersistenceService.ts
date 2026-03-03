/**
 * @fileoverview Cross-session plan persistence service.
 *
 * Persists plan analytics to disk so plan history and metrics are available
 * across sessions.
 *
 * Storage location: ~/.config/sidekick/plans/{projectSlug}.json
 *
 * @module services/PlanPersistenceService
 */

import type { PlanState, PlanStep } from '../types/claudeSession';
import type { PersistedPlan, PersistedPlanStep, PlanHistoryStore, PlanStatus } from '../types/plan';
import { PLAN_SCHEMA_VERSION, MAX_PLANS_PER_PROJECT } from '../types/plan';
import { PersistenceService, resolveSidekickDataPath } from './PersistenceService';
import { log } from './Logger';

function createEmptyStore(): PlanHistoryStore {
  return {
    schemaVersion: PLAN_SCHEMA_VERSION,
    plans: [],
    lastSaved: new Date().toISOString(),
  };
}

/**
 * Service for persisting plan data across sessions.
 */
export class PlanPersistenceService extends PersistenceService<PlanHistoryStore> {
  constructor(private readonly projectSlug: string) {
    super(
      resolveSidekickDataPath('plans', `${projectSlug}.json`),
      'Plan persistence',
      PLAN_SCHEMA_VERSION,
      createEmptyStore,
    );
  }

  protected override onStoreLoaded(): void {
    log(`Loaded persisted plans: ${this.store.plans.length} plans`);
  }

  /**
   * Persists a plan from the current session.
   */
  savePlan(sessionId: string, planState: PlanState): void {
    if (!planState.steps.length && !planState.rawMarkdown) return;

    const planId = `${sessionId.slice(0, 8)}-${Date.now()}`;
    const completedSteps = planState.steps.filter(s => s.status === 'completed').length;
    const failedSteps = planState.steps.filter(s => s.status === 'failed').length;
    const totalSteps = planState.steps.length;

    let status: PlanStatus;
    if (planState.active) {
      status = 'in_progress';
    } else if (completedSteps === totalSteps) {
      status = 'completed';
    } else if (failedSteps > 0 || planState.steps.some(s => s.status === 'in_progress')) {
      status = 'failed';
    } else if (planState.steps.every(s => s.status === 'skipped' || s.status === 'pending')) {
      status = 'abandoned';
    } else {
      status = completedSteps > 0 ? 'completed' : 'abandoned';
    }

    const persistedSteps: PersistedPlanStep[] = planState.steps.map(step => this.convertStep(step));

    const totalTokensUsed = persistedSteps.reduce((sum, s) => sum + (s.tokensUsed ?? 0), 0);
    const totalToolCalls = persistedSteps.reduce((sum, s) => sum + (s.toolCalls ?? 0), 0);
    const totalCostUsd = persistedSteps.reduce((sum, s) => sum + (s.costUsd ?? 0), 0);

    const persisted: PersistedPlan = {
      id: planId,
      projectSlug: this.projectSlug,
      sessionId,
      title: planState.title || 'Untitled Plan',
      source: planState.source,
      prompt: planState.prompt,
      createdAt: planState.enteredAt?.toISOString() ?? new Date().toISOString(),
      completedAt: planState.exitedAt?.toISOString(),
      status,
      steps: persistedSteps,
      completionRate: totalSteps > 0 ? completedSteps / totalSteps : 0,
      totalDurationMs: planState.totalDurationMs,
      totalTokensUsed: totalTokensUsed > 0 ? totalTokensUsed : undefined,
      totalToolCalls: totalToolCalls > 0 ? totalToolCalls : undefined,
      totalCostUsd: totalCostUsd > 0 ? totalCostUsd : undefined,
      rawMarkdown: planState.rawMarkdown,
    };

    // Check if plan already exists (update) or new (insert)
    const existingIdx = this.store.plans.findIndex(p => p.sessionId === sessionId && p.title === planState.title);
    if (existingIdx >= 0) {
      this.store.plans[existingIdx] = persisted;
    } else {
      this.store.plans.unshift(persisted);
    }

    // Cap stored plans
    if (this.store.plans.length > MAX_PLANS_PER_PROJECT) {
      this.store.plans = this.store.plans.slice(0, MAX_PLANS_PER_PROJECT);
    }

    this.markDirty();
    log(`Persisted plan "${persisted.title}" (${status}, ${completedSteps}/${totalSteps} steps) for session ${sessionId.slice(0, 8)}`);
  }

  private convertStep(step: PlanStep): PersistedPlanStep {
    return {
      id: step.id,
      description: step.description,
      status: step.status,
      phase: step.phase,
      complexity: step.complexity,
      startedAt: step.startedAt,
      completedAt: step.completedAt,
      durationMs: step.durationMs,
      output: step.output,
      tokensUsed: step.tokensUsed,
      toolCalls: step.toolCalls,
      errorMessage: step.errorMessage,
      costUsd: step.costUsd,
    };
  }

  /**
   * Returns all persisted plans, sorted by createdAt descending.
   */
  getPlans(): PersistedPlan[] {
    return [...this.store.plans];
  }
}
