/**
 * @fileoverview Aggregation service for session summary and richer dashboard panels.
 *
 * Computes derived data from SessionMonitor, SessionAnalyzer, BurnRateCalculator,
 * and ModelPricingService for display in the Summary tab and enhanced Session panels.
 *
 * @module services/SessionSummaryService
 */

import type { SessionStats, TaskState, ToolCall } from '../types/claudeSession';
import type { SessionAnalysisData } from './SessionAnalyzer';
import type { QuotaState } from '../types/dashboard';
import type { AuthService } from './AuthService';
import { resolveModel } from './ModelResolver';
import type { BurnRateCalculator } from './BurnRateCalculator';
import type {
  SessionSummaryData,
  TaskSummaryItem,
  FileChangeItem,
  TaskPerformanceData,
  CacheEffectivenessData,
  RecoveryPatternData,
  AdvancedBurnRateData,
  ToolEfficiencyData
} from '../types/sessionSummary';
import { ModelPricingService } from './ModelPricingService';
import { calculateLineChanges } from '../utils/lineChangeCalculator';
import { buildNarrativePrompt } from '../utils/summaryPrompts';

/**
 * Weights for tool cost attribution.
 *
 * Tools that produce output tokens (Write, Edit, Bash) are weighted higher
 * since they trigger more expensive output generation.
 */
const TOOL_COST_WEIGHTS: Record<string, number> = {
  Write: 3,
  Edit: 3,
  MultiEdit: 3,
  Bash: 2.5,
  Task: 2,
  Read: 1,
  Glob: 0.5,
  Grep: 0.5,
};

const DEFAULT_TOOL_WEIGHT = 1;

/**
 * Computes a task's duration based on its status.
 *
 * - Completed: time between creation and last update
 * - In progress: time from creation until now
 * - Other (pending/deleted): 0
 */
function computeTaskDuration(
  status: string,
  createdAt: Date,
  updatedAt: Date,
  now: number
): number {
  switch (status) {
    case 'completed':
      return updatedAt.getTime() - createdAt.getTime();
    case 'in_progress':
      return now - createdAt.getTime();
    default:
      return 0;
  }
}

/**
 * Service that aggregates session data into summary and panel formats.
 */
export class SessionSummaryService {
  /**
   * Builds a complete session summary from stats and analysis data.
   */
  generateSummary(stats: SessionStats, analysisData: SessionAnalysisData, contextWindowLimit: number = 200_000): SessionSummaryData {
    const duration = stats.sessionStartTime
      ? Date.now() - stats.sessionStartTime.getTime()
      : 0;

    const totalTokens = stats.totalInputTokens + stats.totalOutputTokens;
    const totalCost = this._computeTotalCost(stats);
    const apiCalls = stats.messageCount;
    const contextPeak = (stats.currentContextSize / contextWindowLimit) * 100;

    // Tasks
    const tasks = this._buildTaskSummaries(stats.taskState, totalCost, stats.toolCalls);
    const taskCompletionRate = this._computeTaskCompletionRate(stats.taskState);

    // File changes
    const { filesChanged, totalFilesChanged, totalAdditions, totalDeletions } =
      this._buildFileChanges(stats.toolCalls);

    // Cost by model
    const costByModel = this._buildCostByModel(stats);

    // Cost by tool
    const costByTool = this._buildCostByTool(stats.toolCalls, totalCost);

    // Errors & recovery
    const errors = this._buildErrorSummary(analysisData);
    const recoveryRate = analysisData.recoveryPatterns.length > 0
      ? analysisData.recoveryPatterns.reduce((sum, p) => sum + p.occurrences, 0) /
        Math.max(analysisData.errors.reduce((sum, e) => sum + e.count, 0), 1)
      : 0;

    return {
      duration,
      totalTokens,
      totalCost,
      contextPeak,
      apiCalls,
      tasks,
      taskCompletionRate,
      filesChanged,
      totalFilesChanged,
      totalAdditions,
      totalDeletions,
      costByModel,
      costByTool,
      errors,
      recoveryRate: Math.min(recoveryRate, 1),
    };
  }

  /**
   * Computes task performance data from task state.
   */
  getTaskPerformance(taskState?: TaskState): TaskPerformanceData {
    if (!taskState || taskState.tasks.size === 0) {
      return {
        tasks: [],
        completionRate: 0,
        avgDuration: 0,
        totalTasks: 0,
        completedTasks: 0,
        inProgressTasks: 0,
        pendingTasks: 0,
      };
    }

    const now = Date.now();
    const taskList = Array.from(taskState.tasks.values())
      .filter(t => t.status !== 'deleted')
      .map(t => ({
        taskId: t.taskId,
        subject: t.subject,
        status: t.status,
        duration: computeTaskDuration(t.status, t.createdAt, t.updatedAt, now),
        toolCallCount: t.associatedToolCalls.length,
        blockedBy: [...t.blockedBy],
        blocks: [...t.blocks],
      }));

    const completed = taskList.filter(t => t.status === 'completed');
    const inProgress = taskList.filter(t => t.status === 'in_progress');
    const pending = taskList.filter(t => t.status === 'pending');

    const avgDuration = completed.length > 0
      ? completed.reduce((sum, t) => sum + t.duration, 0) / completed.length
      : 0;

    return {
      tasks: taskList,
      completionRate: taskList.length > 0 ? completed.length / taskList.length : 0,
      avgDuration,
      totalTasks: taskList.length,
      completedTasks: completed.length,
      inProgressTasks: inProgress.length,
      pendingTasks: pending.length,
    };
  }

  /**
   * Computes cache effectiveness metrics.
   */
  getCacheEffectiveness(stats: SessionStats): CacheEffectivenessData {
    const cacheReadTokens = stats.totalCacheReadTokens;
    const cacheWriteTokens = stats.totalCacheWriteTokens;
    const totalInputTokens = stats.totalInputTokens;

    const totalRelevant = cacheReadTokens + totalInputTokens;
    const cacheHitRate = totalRelevant > 0 ? cacheReadTokens / totalRelevant : 0;

    // Estimate cost savings: cache read is 0.1x input, so savings = cacheRead * 0.9 * avgInputPrice
    const avgInputPricePerToken = this._estimateAvgInputPrice(stats);
    const estimatedTokensSaved = cacheReadTokens;
    const estimatedCostSaved = (cacheReadTokens / 1_000_000) * avgInputPricePerToken * 0.9;

    return {
      cacheReadTokens,
      cacheWriteTokens,
      totalInputTokens,
      cacheHitRate,
      estimatedTokensSaved,
      estimatedCostSaved,
    };
  }

  /**
   * Wraps SessionAnalyzer recovery pattern output.
   */
  getRecoveryPatterns(analysisData: SessionAnalysisData): RecoveryPatternData {
    const totalErrors = analysisData.errors.reduce((sum, e) => sum + e.count, 0);
    const totalRecoveries = analysisData.recoveryPatterns.reduce((sum, p) => sum + p.occurrences, 0);

    return {
      patterns: analysisData.recoveryPatterns.map(p => ({
        type: p.type,
        description: p.description,
        failedApproach: p.failedApproach,
        successfulApproach: p.successfulApproach,
        occurrences: p.occurrences,
      })),
      totalErrors,
      totalRecoveries,
      recoveryRate: totalErrors > 0 ? Math.min(totalRecoveries / totalErrors, 1) : 0,
    };
  }

  /**
   * Computes advanced burn rate data with per-model breakdown and projections.
   */
  getAdvancedBurnRate(
    stats: SessionStats,
    burnRateCalculator: BurnRateCalculator,
    quotaState?: QuotaState
  ): AdvancedBurnRateData {
    const currentRate = burnRateCalculator.calculateBurnRate();
    const sessionDuration = stats.sessionStartTime
      ? Date.now() - stats.sessionStartTime.getTime()
      : 0;

    // Per-model rate approximation: distribute overall rate by model share
    const totalTokens = stats.totalInputTokens + stats.totalOutputTokens;
    const rateByModel: { model: string; tokensPerMin: number }[] = [];

    if (totalTokens > 0) {
      stats.modelUsage.forEach((usage, model) => {
        const share = usage.tokens / totalTokens;
        rateByModel.push({
          model,
          tokensPerMin: Math.round(currentRate * share),
        });
      });
    }

    // Trend direction based on recent usage events
    const trendDirection = this._computeTrend(stats.recentUsageEvents);

    // Project quota exhaustion
    let projectedQuotaExhaustion: string | null = null;
    if (quotaState?.available && currentRate > 0) {
      const fiveHourRemaining = 100 - quotaState.fiveHour.utilization;
      if (fiveHourRemaining > 0 && fiveHourRemaining < 50) {
        // Rough estimate: if consuming at current rate, when would we hit 100%
        const minutesRemaining = (fiveHourRemaining / quotaState.fiveHour.utilization) *
          (sessionDuration / 60000);
        if (minutesRemaining < 300) { // Only show if < 5 hours
          projectedQuotaExhaustion = new Date(Date.now() + minutesRemaining * 60000).toISOString();
        }
      }
    }

    return {
      currentRate,
      rateByModel: rateByModel.sort((a, b) => b.tokensPerMin - a.tokensPerMin),
      projectedQuotaExhaustion,
      trendDirection,
      sessionDuration,
    };
  }

  /**
   * Computes extended tool efficiency data with cost attribution.
   */
  getToolEfficiency(stats: SessionStats): ToolEfficiencyData[] {
    const totalCost = this._computeTotalCost(stats);
    const toolCostMap = this._distributeToolCosts(stats.toolCalls, totalCost);

    const results: ToolEfficiencyData[] = [];
    for (const [name, analytics] of stats.toolAnalytics) {
      const totalCalls = analytics.completedCount;
      if (totalCalls === 0) continue;

      const estimatedCost = toolCostMap.get(name) ?? 0;
      const failureRate = totalCalls > 0 ? analytics.failureCount / totalCalls : 0;
      const avgDuration = totalCalls > 0 ? Math.round(analytics.totalDuration / totalCalls) : 0;

      results.push({
        name,
        totalCalls,
        successRate: totalCalls > 0 ? (analytics.successCount / totalCalls) * 100 : 0,
        avgDuration,
        pendingCount: analytics.pendingCount,
        estimatedCost,
        failureRate,
        avgDurationFormatted: this._formatDuration(avgDuration),
        costPerCall: totalCalls > 0 ? estimatedCost / totalCalls : 0,
      });
    }

    return results.sort((a, b) => b.totalCalls - a.totalCalls);
  }

  /**
   * Generates an AI narrative summary of the session.
   *
   * @param summary - Session summary data
   * @param authService - Auth service for inference
   * @param options - Optional overrides (e.g. timeout)
   */
  async generateNarrative(
    summary: SessionSummaryData,
    authService: AuthService,
    options?: { timeout?: number }
  ): Promise<string> {
    const prompt = buildNarrativePrompt(summary);
    const model = resolveModel('fast', authService.getProviderId(), 'inlineModel');
    return authService.complete(prompt, { model, maxTokens: 1024, ...options });
  }

  // ── Private helpers ──

  private _computeTotalCost(stats: SessionStats): number {
    if (stats.totalReportedCost !== undefined && stats.totalReportedCost > 0) {
      return stats.totalReportedCost;
    }
    let cost = 0;
    stats.modelUsage.forEach((usage, model) => {
      const pricing = ModelPricingService.getPricing(model);
      cost += ModelPricingService.calculateCost({
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheWriteTokens: usage.cacheWriteTokens,
        cacheReadTokens: usage.cacheReadTokens,
      }, pricing);
    });
    return cost;
  }

  private _buildTaskSummaries(
    taskState: TaskState | undefined,
    totalCost: number,
    toolCalls: ToolCall[]
  ): TaskSummaryItem[] {
    if (!taskState) return [];

    const totalToolCalls = toolCalls.length;
    const now = Date.now();

    return Array.from(taskState.tasks.values())
      .filter(t => t.status !== 'deleted')
      .map(t => {
        const duration = computeTaskDuration(t.status, t.createdAt, t.updatedAt, now);
        const toolCallCount = t.associatedToolCalls.length;
        const costShare = totalToolCalls > 0 ? toolCallCount / totalToolCalls : 0;

        return {
          subject: t.subject,
          status: t.status,
          duration,
          toolCallCount,
          estimatedCost: totalCost * costShare,
        };
      });
  }

  private _computeTaskCompletionRate(taskState?: TaskState): number {
    if (!taskState || taskState.tasks.size === 0) return 0;
    const tasks = Array.from(taskState.tasks.values()).filter(t => t.status !== 'deleted');
    if (tasks.length === 0) return 0;
    return tasks.filter(t => t.status === 'completed').length / tasks.length;
  }

  private _buildFileChanges(toolCalls: ToolCall[]): {
    filesChanged: FileChangeItem[];
    totalFilesChanged: number;
    totalAdditions: number;
    totalDeletions: number;
  } {
    const FILE_TOOLS = ['Write', 'Edit', 'MultiEdit'];
    const fileMap = new Map<string, { additions: number; deletions: number }>();

    for (const call of toolCalls) {
      if (!FILE_TOOLS.includes(call.name)) continue;
      const filePath = call.input.file_path as string;
      if (!filePath) continue;

      const changes = calculateLineChanges(call.name, call.input);
      const existing = fileMap.get(filePath) ?? { additions: 0, deletions: 0 };
      existing.additions += changes.additions;
      existing.deletions += changes.deletions;
      fileMap.set(filePath, existing);
    }

    const filesChanged: FileChangeItem[] = Array.from(fileMap.entries())
      .map(([fullPath, changes]) => ({
        path: this._shortenPath(fullPath),
        additions: changes.additions,
        deletions: changes.deletions,
      }))
      .sort((a, b) => (b.additions + b.deletions) - (a.additions + a.deletions));

    const totalAdditions = filesChanged.reduce((sum, f) => sum + f.additions, 0);
    const totalDeletions = filesChanged.reduce((sum, f) => sum + f.deletions, 0);

    return {
      filesChanged,
      totalFilesChanged: filesChanged.length,
      totalAdditions,
      totalDeletions,
    };
  }

  private _buildCostByModel(stats: SessionStats): { model: string; cost: number; percentage: number }[] {
    const entries: { model: string; cost: number }[] = [];
    let total = 0;

    stats.modelUsage.forEach((usage, model) => {
      const pricing = ModelPricingService.getPricing(model);
      const cost = ModelPricingService.calculateCost({
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheWriteTokens: usage.cacheWriteTokens,
        cacheReadTokens: usage.cacheReadTokens,
      }, pricing);
      entries.push({ model, cost });
      total += cost;
    });

    return entries
      .map(e => ({ ...e, percentage: total > 0 ? (e.cost / total) * 100 : 0 }))
      .sort((a, b) => b.cost - a.cost);
  }

  private _buildCostByTool(toolCalls: ToolCall[], totalCost: number): { tool: string; estimatedCost: number; calls: number }[] {
    const costMap = this._distributeToolCosts(toolCalls, totalCost);
    const callCounts = new Map<string, number>();

    for (const call of toolCalls) {
      callCounts.set(call.name, (callCounts.get(call.name) ?? 0) + 1);
    }

    return Array.from(costMap.entries())
      .map(([tool, estimatedCost]) => ({
        tool,
        estimatedCost,
        calls: callCounts.get(tool) ?? 0,
      }))
      .sort((a, b) => b.estimatedCost - a.estimatedCost);
  }

  private _buildErrorSummary(analysisData: SessionAnalysisData): { category: string; count: number; recovered: boolean }[] {
    const recoveredCategories = new Set<string>();

    // Mark categories as recovered if we have recovery patterns for tools that match
    for (const pattern of analysisData.recoveryPatterns) {
      if (pattern.occurrences > 0) {
        recoveredCategories.add(pattern.type);
      }
    }

    return analysisData.errors.map(e => ({
      category: e.category,
      count: e.count,
      recovered: recoveredCategories.size > 0, // Simplified: if any recovery, consider partially recovered
    }));
  }

  /**
   * Distributes total session cost across tools proportionally by weighted call count.
   */
  private _distributeToolCosts(toolCalls: ToolCall[], totalCost: number): Map<string, number> {
    const weightedCounts = new Map<string, number>();
    let totalWeight = 0;

    for (const call of toolCalls) {
      const weight = TOOL_COST_WEIGHTS[call.name] ?? DEFAULT_TOOL_WEIGHT;
      weightedCounts.set(call.name, (weightedCounts.get(call.name) ?? 0) + weight);
      totalWeight += weight;
    }

    const costMap = new Map<string, number>();
    if (totalWeight > 0) {
      for (const [tool, weight] of weightedCounts) {
        costMap.set(tool, totalCost * (weight / totalWeight));
      }
    }

    return costMap;
  }

  private _estimateAvgInputPrice(stats: SessionStats): number {
    let totalWeight = 0;
    let weightedPrice = 0;

    stats.modelUsage.forEach((usage, model) => {
      const pricing = ModelPricingService.getPricing(model);
      weightedPrice += pricing.inputCostPerMillion * usage.calls;
      totalWeight += usage.calls;
    });

    return totalWeight > 0 ? weightedPrice / totalWeight : 3.0; // Default to sonnet pricing
  }

  private _computeTrend(
    recentEvents: Array<{ timestamp: Date; tokens: number }>
  ): 'increasing' | 'stable' | 'decreasing' {
    if (recentEvents.length < 4) return 'stable';

    const mid = Math.floor(recentEvents.length / 2);
    const firstHalf = recentEvents.slice(0, mid);
    const secondHalf = recentEvents.slice(mid);

    const firstAvg = firstHalf.reduce((s, e) => s + e.tokens, 0) / firstHalf.length;
    const secondAvg = secondHalf.reduce((s, e) => s + e.tokens, 0) / secondHalf.length;

    const ratio = secondAvg / Math.max(firstAvg, 1);
    if (ratio > 1.2) return 'increasing';
    if (ratio < 0.8) return 'decreasing';
    return 'stable';
  }

  private _formatDuration(ms: number): string {
    const seconds = ms / 1000;
    if (seconds < 1) return `${seconds.toFixed(1)}s`;
    if (seconds < 60) return `${Math.round(seconds)}s`;
    const minutes = Math.floor(seconds / 60);
    const remaining = Math.round(seconds % 60);
    return remaining > 0 ? `${minutes}m ${remaining}s` : `${minutes}m`;
  }

  private _shortenPath(filePath: string): string {
    const parts = filePath.split('/').filter(Boolean);
    if (parts.length <= 3) return filePath;
    return '.../' + parts.slice(-3).join('/');
  }
}
