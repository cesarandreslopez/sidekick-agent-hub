/**
 * Session dump formatters — text, markdown, and JSON output.
 *
 * Extracted from sidekick-cli's dump command so both the CLI and VS Code
 * extension can produce identical session reports from AggregatedMetrics.
 *
 * @module formatters/sessionDump
 */

import type { AggregatedMetrics } from '../aggregation/types';
import { describeCostProvenance } from '../aggregation/costProvenance';
import { formatDurationMs, formatTokenCount } from '../formatting';
import {
  formatTokenBreakdown,
  TOKEN_MAIN_THREAD_LABEL,
  TOKEN_SESSION_TOTAL_LABEL,
  TOKEN_SUBAGENTS_LABEL,
  TOKEN_TOTAL_LABEL,
} from '../tokenSummary';
import { combineSessionTokenTotals, type SessionTokenTotals } from '../sessionTokenTotals';
import type { SubagentStats } from '../types/sessionEvent';

/** Options for text and markdown formatters. */
export interface SessionDumpOptions {
  /** Terminal width for text output (default 120). */
  width?: number;
  /** Show noise-classified events (default false hides them). */
  expand?: boolean;
  /** Session file name to display in markdown summary table. */
  sessionFileName?: string;
  /**
   * The session's subagents (`provider.scanSubagents()`). Their tokens are
   * reported beside the main thread and added to the session total.
   */
  subagents?: readonly SubagentStats[];
}

/** Main thread (the aggregated transcript) plus the session's subagents. */
function sessionTokens(
  metrics: AggregatedMetrics,
  options: SessionDumpOptions,
): SessionTokenTotals {
  return combineSessionTokenTotals(metrics.tokens, options.subagents ?? []);
}

// ── JSON output ──

/**
 * Serialize aggregated metrics as pretty-printed JSON, plus a `tokenSummary`
 * block in the shared vocabulary: `mainThread`, per-subagent summaries,
 * `subagentTotal`, and `combined` (main thread plus subagents).
 */
export function formatSessionJson(
  metrics: AggregatedMetrics,
  options: Pick<SessionDumpOptions, 'subagents'> = {},
): string {
  return (
    JSON.stringify({ ...metrics, tokenSummary: sessionTokens(metrics, options) }, null, 2) + '\n'
  );
}

// ── Text output ──

/**
 * Format aggregated metrics as a plain-text report.
 */
export function formatSessionText(
  metrics: AggregatedMetrics,
  options: SessionDumpOptions = {},
): string {
  const width = options.width ?? 120;
  const expand = options.expand ?? false;
  const lines: string[] = [];
  const hr = '\u2500'.repeat(Math.min(width, 80));

  // Header
  lines.push(hr);
  lines.push(formatHeader(metrics));
  lines.push(hr);
  lines.push('');

  // Token summary
  lines.push(...formatTokenSummary(metrics, sessionTokens(metrics, options)));
  lines.push('');

  // Model stats
  if (metrics.modelStats.length > 0) {
    lines.push('Models:');
    for (const m of metrics.modelStats) {
      lines.push(
        `  ${m.model}: ${m.calls} calls, ${fmtTokens(m.tokens)} total incl. cache, ${fmtCost(m.cost)}`,
      );
    }
    lines.push('');
  }

  // Tool stats
  if (metrics.toolStats.length > 0) {
    lines.push('Tools:');
    const sorted = [...metrics.toolStats].sort(
      (a, b) => b.successCount + b.failureCount - (a.successCount + a.failureCount),
    );
    for (const t of sorted) {
      const total = t.successCount + t.failureCount;
      const failStr = t.failureCount > 0 ? ` (${t.failureCount} failed)` : '';
      const avgMs = t.completedCount > 0 ? Math.round(t.totalDuration / t.completedCount) : 0;
      const durationStr = avgMs > 0 ? ` avg ${avgMs}ms` : '';
      lines.push(`  ${t.name}: ${total}${failStr}${durationStr}`);
    }
    lines.push('');
  }

  // Compaction / truncation
  if (metrics.compactionCount > 0 || metrics.truncationCount > 0) {
    const parts: string[] = [];
    if (metrics.compactionCount > 0) parts.push(`${metrics.compactionCount} compaction(s)`);
    if (metrics.truncationCount > 0) parts.push(`${metrics.truncationCount} truncation(s)`);
    lines.push(`Context management: ${parts.join(', ')}`);
    lines.push('');
  }

  // Timeline
  lines.push(hr);
  lines.push('Timeline:');
  lines.push(hr);

  const filteredEvents = expand
    ? metrics.timeline
    : metrics.timeline.filter((e) => e.noiseLevel !== 'noise');

  if (filteredEvents.length === 0) {
    lines.push('  (no events)');
  } else {
    for (const event of filteredEvents) {
      const ts = formatTimestamp(event.timestamp);
      const icon = getTimelineEventIcon(event.type);
      const summary = truncateToWidth(event.description, width - ts.length - 4);
      lines.push(`${ts} ${icon} ${summary}`);
    }
  }

  lines.push('');
  return lines.join('\n');
}

// ── Markdown output ──

/**
 * Format aggregated metrics as a markdown report.
 */
export function formatSessionMarkdown(
  metrics: AggregatedMetrics,
  options: SessionDumpOptions = {},
): string {
  const expand = options.expand ?? false;
  const sessionFileName = options.sessionFileName;
  const lines: string[] = [];

  // Title
  lines.push('# Session Report');
  lines.push('');

  // Summary
  lines.push('## Summary');
  lines.push('');
  lines.push(`| Metric | Value |`);
  lines.push(`|--------|-------|`);
  if (sessionFileName) {
    lines.push(`| Session file | \`${sessionFileName}\` |`);
  }
  lines.push(`| Started | ${metrics.sessionStartTime || 'N/A'} |`);
  lines.push(`| Last event | ${metrics.lastEventTime || 'N/A'} |`);
  lines.push(`| Duration | ${formatDuration(metrics.sessionStartTime, metrics.lastEventTime)} |`);
  lines.push(`| Messages | ${metrics.messageCount} |`);
  lines.push(`| Events | ${metrics.eventCount} |`);
  lines.push(`| Model | ${metrics.currentModel || 'N/A'} |`);
  lines.push(`| Provider | ${metrics.providerId || 'N/A'} |`);
  lines.push('');

  // Tokens
  lines.push('## Tokens');
  lines.push('');
  lines.push(`| Category | Count |`);
  lines.push(`|----------|-------|`);
  lines.push(`| Input | ${fmtTokens(metrics.tokens.inputTokens)} |`);
  lines.push(`| Output | ${fmtTokens(metrics.tokens.outputTokens)} |`);
  lines.push(`| Cache write | ${fmtTokens(metrics.tokens.cacheWriteTokens)} |`);
  lines.push(`| Cache read | ${fmtTokens(metrics.tokens.cacheReadTokens)} |`);
  const tokens = sessionTokens(metrics, options);
  if (tokens.mainThread.billedOutsideBuckets > 0) {
    lines.push(
      `| Reasoning (billed separately) | ${fmtTokens(tokens.mainThread.billedOutsideBuckets)} |`,
    );
  }
  if (tokens.subagents.length > 0) {
    lines.push(
      `| ${TOKEN_MAIN_THREAD_LABEL} — ${TOKEN_TOTAL_LABEL} | ${fmtTokens(tokens.mainThread.total)} |`,
    );
    lines.push(
      `| ${TOKEN_SUBAGENTS_LABEL} (${tokens.subagents.length}) — ${TOKEN_TOTAL_LABEL} | ${fmtTokens(tokens.subagentTotal.total)} |`,
    );
    lines.push(`| **${TOKEN_SESSION_TOTAL_LABEL}** | **${fmtTokens(tokens.combined.total)}** |`);
  } else {
    lines.push(`| ${TOKEN_TOTAL_LABEL} | ${fmtTokens(tokens.mainThread.total)} |`);
  }
  if (metrics.tokens.costUsd > 0) {
    lines.push(
      `| Cost | ${fmtCost(metrics.tokens.costUsd)} (${describeCostProvenance(metrics.tokens)}) |`,
    );
  } else if (metrics.tokens.unpricedCalls > 0) {
    lines.push(`| Cost | — (${describeCostProvenance(metrics.tokens)}) |`);
  }
  lines.push('');

  // Model stats
  if (metrics.modelStats.length > 0) {
    lines.push('## Models');
    lines.push('');
    lines.push(`| Model | Calls | ${TOKEN_TOTAL_LABEL} | Cost |`);
    lines.push(`|-------|-------|--------|------|`);
    for (const m of metrics.modelStats) {
      lines.push(`| ${m.model} | ${m.calls} | ${fmtTokens(m.tokens)} | ${fmtCost(m.cost)} |`);
    }
    lines.push('');
  }

  // Tool calls
  if (metrics.toolStats.length > 0) {
    lines.push('## Tool Calls');
    lines.push('');
    lines.push(`| Tool | Total | Failed | Avg Duration |`);
    lines.push(`|------|-------|--------|--------------|`);
    const sorted = [...metrics.toolStats].sort(
      (a, b) => b.successCount + b.failureCount - (a.successCount + a.failureCount),
    );
    for (const t of sorted) {
      const total = t.successCount + t.failureCount;
      const avgMs = t.completedCount > 0 ? Math.round(t.totalDuration / t.completedCount) : 0;
      lines.push(
        `| ${t.name} | ${total} | ${t.failureCount} | ${avgMs > 0 ? `${avgMs}ms` : '-'} |`,
      );
    }
    lines.push('');
  }

  // Context events
  if (metrics.compactionCount > 0 || metrics.truncationCount > 0) {
    lines.push('## Context Management');
    lines.push('');
    if (metrics.compactionCount > 0) {
      lines.push(`- **Compactions:** ${metrics.compactionCount}`);
      for (const c of metrics.compactionEvents) {
        lines.push(
          `  - At ${formatTimestamp(c.timestamp instanceof Date ? c.timestamp.toISOString() : String(c.timestamp))}: ${fmtTokens(c.contextBefore)} -> ${fmtTokens(c.contextAfter)} tokens`,
        );
      }
    }
    if (metrics.truncationCount > 0) {
      lines.push(`- **Truncations:** ${metrics.truncationCount}`);
    }
    lines.push('');
  }

  // Subagents
  if (metrics.subagents.length > 0) {
    lines.push('## Subagents');
    lines.push('');
    lines.push(`| Type | Description | Status | Duration |`);
    lines.push(`|------|-------------|--------|----------|`);
    for (const s of metrics.subagents) {
      const dur = s.durationMs ? `${Math.round(s.durationMs / 1000)}s` : '-';
      lines.push(`| ${s.subagentType} | ${s.description} | ${s.status} | ${dur} |`);
    }
    lines.push('');
  }
  if (tokens.subagents.length > 0) {
    lines.push('## Subagent Tokens');
    lines.push('');
    lines.push(`| Agent | Type | Description | ${TOKEN_TOTAL_LABEL} |`);
    lines.push(`|-------|------|-------------|--------|`);
    for (const agent of tokens.subagents) {
      lines.push(
        `| ${agent.agentId} | ${agent.agentType ?? '-'} | ${agent.description ?? '-'} | ${fmtTokens(agent.summary.total)} |`,
      );
    }
    lines.push('');
  }

  // Timeline
  lines.push('## Timeline');
  lines.push('');

  const filteredEvents = expand
    ? metrics.timeline
    : metrics.timeline.filter((e) => e.noiseLevel !== 'noise');

  if (filteredEvents.length === 0) {
    lines.push('_(no events)_');
  } else {
    lines.push('```');
    for (const event of filteredEvents) {
      const ts = formatTimestamp(event.timestamp);
      const icon = getTimelineEventIcon(event.type);
      lines.push(`${ts} ${icon} ${event.description}`);
    }
    lines.push('```');
  }

  lines.push('');
  return lines.join('\n');
}

// ── Formatting helpers ──

function formatHeader(metrics: AggregatedMetrics): string {
  const parts: string[] = [];
  if (metrics.providerId) parts.push(metrics.providerId);
  if (metrics.currentModel) parts.push(metrics.currentModel);
  const duration = formatDuration(metrics.sessionStartTime, metrics.lastEventTime);
  if (duration !== 'N/A') parts.push(duration);
  parts.push(`${metrics.messageCount} messages`);
  parts.push(`${metrics.eventCount} events`);
  return parts.join(' | ');
}

function formatTokenSummary(metrics: AggregatedMetrics, tokens: SessionTokenTotals): string[] {
  const t = metrics.tokens;
  let first = `Tokens: ${formatTokenBreakdown(tokens.mainThread, fmtTokens)}`;
  if (t.costUsd > 0) first += `  Cost: ${fmtCost(t.costUsd)} (${describeCostProvenance(t)})`;
  const lines = [first];
  if (tokens.subagents.length > 0) {
    lines.push(
      `${TOKEN_SUBAGENTS_LABEL} (${tokens.subagents.length}): ${formatTokenBreakdown(tokens.subagentTotal, fmtTokens)}`,
    );
    lines.push(`${TOKEN_SESSION_TOTAL_LABEL}: ${fmtTokens(tokens.combined.total)}`);
  }
  return lines;
}

/** @internal Exported for tests. */
export function fmtTokens(n: number): string {
  return formatTokenCount(n);
}

/** @internal Exported for tests. */
export function fmtCost(cost: number): string {
  if (cost <= 0) return '$0.00';
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  return `$${cost.toFixed(2)}`;
}

/** @internal Exported for tests. */
export function formatTimestamp(iso: string): string {
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '??:??:??';
    const h = d.getHours().toString().padStart(2, '0');
    const m = d.getMinutes().toString().padStart(2, '0');
    const s = d.getSeconds().toString().padStart(2, '0');
    return `${h}:${m}:${s}`;
  } catch {
    return '??:??:??';
  }
}

/** @internal Exported for tests. */
export function formatDuration(start: string | null, end: string | null): string {
  if (!start || !end) return 'N/A';
  try {
    const ms = new Date(end).getTime() - new Date(start).getTime();
    return formatDurationMs(ms);
  } catch {
    return 'N/A';
  }
}

/** Map TimelineEvent.type to a display icon. */
function getTimelineEventIcon(type: string): string {
  switch (type) {
    case 'user_prompt':
      return '\u25b6'; // right-pointing triangle
    case 'assistant_response':
      return '\u2726'; // four-pointed star
    case 'tool_call':
      return '\u2699'; // gear
    case 'tool_result':
      return '\u2190'; // left arrow
    case 'compaction':
      return '\u21bb'; // clockwise arrow
    case 'error':
      return '\u2718'; // heavy ballot X
    case 'session_start':
      return '\u25cf'; // black circle
    case 'session_end':
      return '\u25cb'; // white circle
    default:
      return ' ';
  }
}

function truncateToWidth(text: string, maxLen: number): string {
  if (maxLen < 10) maxLen = 10;
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= maxLen) return clean;
  return clean.substring(0, maxLen - 3) + '...';
}
