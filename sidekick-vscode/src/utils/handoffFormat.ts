/**
 * @fileoverview Markdown formatter for session context handoff documents.
 *
 * Generates slim, actionable markdown that an agent can use to resume
 * work from a previous session. Deliberately excludes verbose data
 * (token counts, cost, tool stats) that isn't useful for agent context.
 *
 * @module utils/handoffFormat
 */

import type { RecoveryPattern } from '../types/analysis';

/**
 * Input data for building a handoff document.
 * Extracted and filtered from SessionSummaryData + SessionAnalysisData.
 */
export interface HandoffInput {
  /** Project path */
  projectPath: string;
  /** ISO date string */
  date: string;
  /** Session duration in milliseconds */
  duration: number;
  /** Unfinished tasks only */
  pendingTasks: Array<{ name: string; description?: string }>;
  /** Files actively being modified at session end */
  filesInProgress: string[];
  /** Recovery patterns (failed → succeeded pairs) */
  recoveryPatterns: RecoveryPattern[];
  /** Commands/paths that consistently failed */
  failedCommands: string[];

  /** Context health score (0-100) */
  contextHealth?: number;

  /** Number of compaction events */
  compactionCount?: number;

  /** Number of truncation events */
  truncationCount?: number;

  /** Per-tool truncation breakdown */
  truncationsByTool?: Array<{ tool: string; count: number }>;

  /** Incomplete goal gate task names */
  goalGates?: string[];
}

/**
 * Formats a duration in milliseconds to a human-readable string.
 */
function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) {
    return `${hours}h ${minutes % 60}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  }
  return `${seconds}s`;
}

/**
 * Builds a slim, actionable handoff markdown document.
 *
 * Sections with no data are omitted entirely. Target is ~50-100 lines max.
 *
 * @param input - Filtered handoff data
 * @returns Markdown string
 */
export function buildHandoffMarkdown(input: HandoffInput): string {
  const projectName = input.projectPath.split('/').pop() || input.projectPath;
  const lines: string[] = [];

  lines.push(`# Session Handoff: ${projectName}`);
  lines.push(`**Date:** ${input.date} | **Duration:** ${formatDuration(input.duration)}`);
  lines.push('');

  // Context Health Warning
  if (input.contextHealth !== undefined && input.contextHealth < 50) {
    lines.push('## Context Health Warning');
    lines.push(`Context at ${input.contextHealth}% fidelity after ${input.compactionCount ?? 0} compactions. Decisions in the latter half of this session should be re-verified.`);
    lines.push('');
  }

  // Truncation Summary
  if (input.truncationCount && input.truncationCount > 0) {
    lines.push('## Truncated Outputs');
    lines.push(`Session had ${input.truncationCount} truncated tool output${input.truncationCount === 1 ? '' : 's'}.`);
    if (input.truncationsByTool && input.truncationsByTool.length > 0) {
      for (const { tool, count } of input.truncationsByTool) {
        lines.push(`- **${tool}**: ${count}`);
      }
    }
    lines.push('');
  }

  // Incomplete Goal Gates
  if (input.goalGates && input.goalGates.length > 0) {
    lines.push('## CRITICAL: Incomplete Goal Gates');
    for (const gate of input.goalGates) {
      lines.push(`- **${gate}** was NOT completed`);
    }
    lines.push('');
  }

  // Pending Tasks
  if (input.pendingTasks.length > 0) {
    lines.push('## Pending Tasks');
    for (const task of input.pendingTasks) {
      if (task.description) {
        lines.push(`- **${task.name}** — ${task.description}`);
      } else {
        lines.push(`- ${task.name}`);
      }
    }
    lines.push('');
  }

  // Files In Progress
  if (input.filesInProgress.length > 0) {
    lines.push('## Files In Progress');
    for (const file of input.filesInProgress) {
      lines.push(`- ${file}`);
    }
    lines.push('');
  }

  // Recovery Patterns
  if (input.recoveryPatterns.length > 0) {
    lines.push('## What Worked (Recovery Patterns)');
    for (const p of input.recoveryPatterns) {
      lines.push(`- "${p.failedApproach}" failed → use "${p.successfulApproach}" instead`);
    }
    lines.push('');
  }

  // Failed Commands
  if (input.failedCommands.length > 0) {
    lines.push('## Avoid');
    for (const cmd of input.failedCommands) {
      lines.push(`- ${cmd}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}
