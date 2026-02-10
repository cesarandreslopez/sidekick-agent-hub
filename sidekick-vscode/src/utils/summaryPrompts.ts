/**
 * @fileoverview Prompt template for AI-generated session narrative.
 *
 * Used by SessionSummaryService to generate a natural language summary
 * of a completed Claude Code session via the opt-in "Generate AI Narrative" button.
 *
 * @module utils/summaryPrompts
 */

import type { SessionSummaryData } from '../types/sessionSummary';
import { ModelPricingService } from '../services/ModelPricingService';

/**
 * Builds a prompt for generating a narrative summary of a session.
 *
 * @param summary - Structured session summary data
 * @returns Prompt string for Claude
 */
export function buildNarrativePrompt(summary: SessionSummaryData): string {
  const durationMin = Math.round(summary.duration / 60000);
  const costStr = ModelPricingService.formatCost(summary.totalCost);

  const taskLines = summary.tasks.length > 0
    ? summary.tasks.map(t => `  - "${t.subject}" (${t.status}, ${t.toolCallCount} tool calls)`).join('\n')
    : '  (no tasks tracked)';

  const fileLines = summary.filesChanged.length > 0
    ? summary.filesChanged.slice(0, 10).map(f => `  - ${f.path}: +${f.additions}/-${f.deletions}`).join('\n')
    : '  (no file changes)';

  const modelLines = summary.costByModel.length > 0
    ? summary.costByModel.map(m => `  - ${m.model}: ${ModelPricingService.formatCost(m.cost)} (${Math.round(m.percentage)}%)`).join('\n')
    : '  (no model data)';

  const errorLines = summary.errors.length > 0
    ? summary.errors.map(e => `  - ${e.category}: ${e.count} occurrences${e.recovered ? ' (recovered)' : ''}`).join('\n')
    : '  (no errors)';

  return `You are a helpful assistant summarizing a Claude Code session. Write a concise 2-3 paragraph natural language summary based on this data. Focus on what was accomplished, notable patterns, and any suggestions for future sessions.

Session Data:
- Duration: ${durationMin} minutes
- Total tokens: ${summary.totalTokens.toLocaleString()}
- Cost: ${costStr}
- API calls: ${summary.apiCalls}
- Context peak: ${Math.round(summary.contextPeak)}%
- Task completion rate: ${Math.round(summary.taskCompletionRate * 100)}%
- Files changed: ${summary.totalFilesChanged} (+${summary.totalAdditions}/-${summary.totalDeletions} lines)
- Recovery rate: ${Math.round(summary.recoveryRate * 100)}%

Tasks:
${taskLines}

Files Changed:
${fileLines}

Cost by Model:
${modelLines}

Errors:
${errorLines}

Write a brief, informative summary in plain English. Do not use bullet points or headers. Be specific about what was accomplished based on the task subjects and file changes.`;
}
