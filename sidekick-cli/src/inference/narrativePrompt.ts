/**
 * Prompt template for AI-generated session narrative in the CLI dashboard.
 * Ported from sidekick-vscode/src/utils/summaryPrompts.ts,
 * adapted to use DashboardMetrics instead of SessionSummaryData.
 */

import type { DashboardMetrics } from '../dashboard/DashboardState';
import type { DiffStat } from '../dashboard/GitDiffCache';
import { fmtNum } from '../dashboard/formatters';

export function buildNarrativePrompt(
  metrics: DashboardMetrics,
  diffStats?: Map<string, DiffStat>,
): string {
  const durationMs = metrics.sessionStartTime
    ? Date.now() - new Date(metrics.sessionStartTime).getTime()
    : 0;
  const durationMin = Math.round(durationMs / 60_000);

  const t = metrics.tokens;
  const totalTokens = t.input + t.output + t.cacheRead + t.cacheWrite;
  const costStr = `$${t.cost.toFixed(4)}`;

  // Task summary
  const completed = metrics.tasks.filter(tk => tk.status === 'completed').length;
  const completionRate = metrics.tasks.length > 0
    ? completed / metrics.tasks.length
    : 0;
  const taskLines = metrics.tasks.length > 0
    ? metrics.tasks.map(tk => `  - "${tk.subject}" (${tk.status}, ${tk.toolCallCount} tool calls)`).join('\n')
    : '  (no tasks tracked)';

  // File changes
  let totalFilesChanged = 0;
  let totalAdditions = 0;
  let totalDeletions = 0;
  const fileLines: string[] = [];

  if (diffStats && diffStats.size > 0) {
    totalFilesChanged = diffStats.size;
    for (const [file, stat] of diffStats) {
      totalAdditions += stat.additions;
      totalDeletions += stat.deletions;
      if (fileLines.length < 10) {
        fileLines.push(`  - ${file}: +${stat.additions}/-${stat.deletions}`);
      }
    }
  } else if (metrics.fileTouches.length > 0) {
    totalFilesChanged = metrics.fileTouches.length;
    for (const f of metrics.fileTouches.slice(0, 10)) {
      const ops = [
        f.reads > 0 ? `${f.reads}R` : '',
        f.writes > 0 ? `${f.writes}W` : '',
        f.edits > 0 ? `${f.edits}E` : '',
      ].filter(Boolean).join('/');
      fileLines.push(`  - ${f.path}: ${ops}`);
    }
  }

  const fileSection = fileLines.length > 0
    ? fileLines.join('\n')
    : '  (no file changes)';

  // Model cost breakdown
  const modelLines = metrics.modelStats.length > 0
    ? metrics.modelStats.map(m => `  - ${m.model}: $${m.cost.toFixed(4)} (${m.calls} calls, ${fmtNum(m.tokens)} tokens)`).join('\n')
    : '  (no model data)';

  // Tool stats
  const totalToolCalls = metrics.toolStats.reduce((s, ts) => s + ts.calls, 0);
  const topTools = metrics.toolStats.slice(0, 5).map(ts => `${ts.name}(${ts.calls})`).join(', ');

  return `You are a helpful assistant summarizing a Claude Code session. Write a concise 2-3 paragraph natural language summary based on this data. Focus on what was accomplished, notable patterns, and any suggestions for future sessions.

Session Data:
- Duration: ${durationMin} minutes
- Total tokens: ${fmtNum(totalTokens)}
- Cost: ${costStr}
- Tool calls: ${totalToolCalls} (top: ${topTools})
- Context usage: ${metrics.context.percent}%
- Compactions: ${metrics.compactionCount}
- Subagents: ${metrics.subagents.length}
- Task completion rate: ${Math.round(completionRate * 100)}%
- Files touched: ${totalFilesChanged} (+${totalAdditions}/-${totalDeletions} lines)

Tasks:
${taskLines}

Files Changed:
${fileSection}

Cost by Model:
${modelLines}

Write a brief, informative summary in plain English. Do not use bullet points or headers. Be specific about what was accomplished based on the task subjects and file changes.`;
}
