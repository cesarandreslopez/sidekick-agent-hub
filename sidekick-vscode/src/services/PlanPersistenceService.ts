/**
 * @fileoverview Cross-session plan persistence service.
 *
 * Persists plan analytics to disk so plan history and metrics are available
 * across sessions. Follows the TaskPersistenceService pattern.
 *
 * Storage location: ~/.config/sidekick/plans/{projectSlug}.json
 *
 * @module services/PlanPersistenceService
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { PlanState, PlanStep } from '../types/claudeSession';
import type { PersistedPlan, PersistedPlanStep, PlanHistoryStore, PlanStatus } from '../types/plan';
import { PLAN_SCHEMA_VERSION, MAX_PLANS_PER_PROJECT } from '../types/plan';
import { log, logError } from './Logger';

/**
 * Service for persisting plan data across sessions.
 */
export class PlanPersistenceService implements vscode.Disposable {
  private store: PlanHistoryStore;
  private dataFilePath: string;
  private isDirty = false;
  private saveTimer: NodeJS.Timeout | null = null;
  private readonly SAVE_DEBOUNCE_MS = 5000;

  constructor(private readonly projectSlug: string) {
    this.store = { schemaVersion: PLAN_SCHEMA_VERSION, plans: [], lastSaved: new Date().toISOString() };
    this.dataFilePath = this.getDataFilePath();
  }

  private getDataFilePath(): string {
    let configDir: string;
    if (process.platform === 'win32') {
      configDir = path.join(process.env.APPDATA || os.homedir(), 'sidekick', 'plans');
    } else {
      configDir = path.join(os.homedir(), '.config', 'sidekick', 'plans');
    }
    return path.join(configDir, `${this.projectSlug}.json`);
  }

  async initialize(): Promise<void> {
    try {
      const dir = path.dirname(this.dataFilePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
        log(`Created plan persistence directory: ${dir}`);
      }

      if (fs.existsSync(this.dataFilePath)) {
        const content = await fs.promises.readFile(this.dataFilePath, 'utf-8');
        const loaded = JSON.parse(content) as PlanHistoryStore;
        this.store = loaded;
        log(`Loaded persisted plans: ${this.store.plans.length} plans`);
      }
    } catch (error) {
      logError('Failed to load persisted plans', error);
    }
  }

  /**
   * Persists a plan from the current session.
   */
  savePlan(sessionId: string, planState: PlanState): void {
    if (!planState.steps.length) return;

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

    this.isDirty = true;
    this.scheduleSave();
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

  private scheduleSave(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
    }
    this.saveTimer = setTimeout(() => {
      this.save();
    }, this.SAVE_DEBOUNCE_MS);
  }

  private async save(): Promise<void> {
    if (!this.isDirty) return;

    try {
      this.store.lastSaved = new Date().toISOString();
      const content = JSON.stringify(this.store, null, 2);
      await fs.promises.writeFile(this.dataFilePath, content, 'utf-8');
      this.isDirty = false;
      log('Plan persistence data saved to disk');
    } catch (error) {
      logError('Failed to save plan persistence data', error);
    }
  }

  dispose(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }

    if (this.isDirty) {
      try {
        this.store.lastSaved = new Date().toISOString();
        const content = JSON.stringify(this.store, null, 2);
        fs.writeFileSync(this.dataFilePath, content, 'utf-8');
        log('Plan persistence data saved on dispose');
      } catch (error) {
        logError('Failed to save plan persistence data on dispose', error);
      }
    }
  }
}
