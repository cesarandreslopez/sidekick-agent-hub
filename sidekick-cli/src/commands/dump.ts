/**
 * `sidekick dump` — Dump session data as text timeline, JSON metrics, or markdown report.
 *
 * Reads a full session JSONL file, processes all events through EventAggregator,
 * and outputs in the requested format.
 */

import * as path from 'path';
import type { Command } from 'commander';
import {
  EventAggregator,
  createWatcher,
  isHardNoiseFollowEvent,
} from 'sidekick-shared';
import type {
  AggregatedMetrics,
  FollowEvent,
} from 'sidekick-shared';
import { resolveProvider } from '../cli';

type OutputFormat = 'text' | 'json' | 'markdown';

export async function dumpAction(_opts: Record<string, unknown>, cmd: Command): Promise<void> {
  const globalOpts = cmd.parent!.opts();
  const opts = cmd.opts();
  const provider = resolveProvider(globalOpts);
  const workspacePath = globalOpts.project || process.cwd();
  const sessionId: string | undefined = opts.session;
  const format: OutputFormat = (opts.format as OutputFormat) || 'text';
  const termWidth: number = opts.width ? parseInt(opts.width as string, 10) : (process.stdout.columns || 120);
  const expand: boolean = !!opts.expand;

  // Collect all events by replaying through the watcher
  const events: FollowEvent[] = [];
  let sessionPath: string;

  try {
    const result = createWatcher({
      provider,
      workspacePath,
      sessionId,
      callbacks: {
        onEvent: (event: FollowEvent) => {
          events.push(event);
        },
        onError: (_err: Error) => { /* ignore */ },
      },
    });
    sessionPath = result.sessionPath;

    // Synchronous replay of all existing events
    result.watcher.start(true);
    result.watcher.stop();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Error: ${msg}\n`);
    process.exit(1);
  }

  // Process all events through the aggregator
  const aggregator = new EventAggregator({ providerId: provider.id as 'claude-code' | 'opencode' | 'codex' });
  for (const event of events) {
    aggregator.processFollowEvent(event);
  }

  const metrics = aggregator.getMetrics();

  switch (format) {
    case 'json':
      outputJson(metrics);
      break;
    case 'markdown':
      outputMarkdown(metrics, sessionPath, events, expand);
      break;
    case 'text':
    default:
      outputText(metrics, events, termWidth, expand);
      break;
  }
}

// ── JSON output ──

function outputJson(metrics: AggregatedMetrics): void {
  process.stdout.write(JSON.stringify(metrics, null, 2) + '\n');
}

// ── Text output ──

function outputText(
  metrics: AggregatedMetrics,
  events: FollowEvent[],
  width: number,
  expand: boolean,
): void {
  const lines: string[] = [];
  const hr = '\u2500'.repeat(Math.min(width, 80));

  // Header
  lines.push(hr);
  lines.push(formatHeader(metrics));
  lines.push(hr);
  lines.push('');

  // Token summary
  lines.push(formatTokenSummary(metrics));
  lines.push('');

  // Model stats
  if (metrics.modelStats.length > 0) {
    lines.push('Models:');
    for (const m of metrics.modelStats) {
      lines.push(`  ${m.model}: ${m.calls} calls, ${fmtTokens(m.tokens)} tokens, ${fmtCost(m.cost)}`);
    }
    lines.push('');
  }

  // Tool stats
  if (metrics.toolStats.length > 0) {
    lines.push('Tools:');
    const sorted = [...metrics.toolStats].sort((a, b) => (b.successCount + b.failureCount) - (a.successCount + a.failureCount));
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
    lines.push(`Context: ${parts.join(', ')}`);
    lines.push('');
  }

  // Timeline
  lines.push(hr);
  lines.push('Timeline:');
  lines.push(hr);

  const filteredEvents = expand
    ? events
    : events.filter(e => !isHardNoiseFollowEvent(e));

  if (filteredEvents.length === 0) {
    lines.push('  (no events)');
  } else {
    for (const event of filteredEvents) {
      const ts = formatTimestamp(event.timestamp);
      const icon = getEventIcon(event.type);
      const summary = truncateToWidth(event.summary, width - ts.length - 4);
      lines.push(`${ts} ${icon} ${summary}`);
    }
  }

  lines.push('');
  process.stdout.write(lines.join('\n'));
}

// ── Markdown output ──

function outputMarkdown(
  metrics: AggregatedMetrics,
  sessionPath: string,
  events: FollowEvent[],
  expand: boolean,
): void {
  const lines: string[] = [];

  // Title
  lines.push('# Session Report');
  lines.push('');

  // Summary
  lines.push('## Summary');
  lines.push('');
  lines.push(`| Metric | Value |`);
  lines.push(`|--------|-------|`);
  lines.push(`| Session file | \`${path.basename(sessionPath)}\` |`);
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
  lines.push(`| Total | ${fmtTokens(metrics.tokens.inputTokens + metrics.tokens.outputTokens)} |`);
  if (metrics.tokens.reportedCost > 0) {
    lines.push(`| Cost | ${fmtCost(metrics.tokens.reportedCost)} |`);
  }
  lines.push('');

  // Model stats
  if (metrics.modelStats.length > 0) {
    lines.push('## Models');
    lines.push('');
    lines.push(`| Model | Calls | Tokens | Cost |`);
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
    const sorted = [...metrics.toolStats].sort((a, b) => (b.successCount + b.failureCount) - (a.successCount + a.failureCount));
    for (const t of sorted) {
      const total = t.successCount + t.failureCount;
      const avgMs = t.completedCount > 0 ? Math.round(t.totalDuration / t.completedCount) : 0;
      lines.push(`| ${t.name} | ${total} | ${t.failureCount} | ${avgMs > 0 ? `${avgMs}ms` : '-'} |`);
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
        lines.push(`  - At ${formatTimestamp(c.timestamp instanceof Date ? c.timestamp.toISOString() : String(c.timestamp))}: ${fmtTokens(c.contextBefore)} -> ${fmtTokens(c.contextAfter)} tokens`);
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

  // Timeline
  lines.push('## Timeline');
  lines.push('');

  const filteredEvents = expand
    ? events
    : events.filter(e => !isHardNoiseFollowEvent(e));

  if (filteredEvents.length === 0) {
    lines.push('_(no events)_');
  } else {
    lines.push('```');
    for (const event of filteredEvents) {
      const ts = formatTimestamp(event.timestamp);
      const icon = getEventIcon(event.type);
      lines.push(`${ts} ${icon} ${event.summary}`);
    }
    lines.push('```');
  }

  lines.push('');
  process.stdout.write(lines.join('\n'));
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

function formatTokenSummary(metrics: AggregatedMetrics): string {
  const t = metrics.tokens;
  const total = t.inputTokens + t.outputTokens;
  const parts = [
    `Tokens: ${fmtTokens(total)} total`,
    `(${fmtTokens(t.inputTokens)} in`,
    `${fmtTokens(t.outputTokens)} out`,
  ];
  if (t.cacheReadTokens > 0) parts.push(`${fmtTokens(t.cacheReadTokens)} cache-read`);
  if (t.cacheWriteTokens > 0) parts.push(`${fmtTokens(t.cacheWriteTokens)} cache-write`);
  const line = parts.join(', ');
  if (t.reportedCost > 0) return `${line})  Cost: ${fmtCost(t.reportedCost)}`;
  return line + ')';
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function fmtCost(cost: number): string {
  if (cost <= 0) return '$0.00';
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  return `$${cost.toFixed(2)}`;
}

function formatTimestamp(iso: string): string {
  try {
    const d = new Date(iso);
    const h = d.getHours().toString().padStart(2, '0');
    const m = d.getMinutes().toString().padStart(2, '0');
    const s = d.getSeconds().toString().padStart(2, '0');
    return `${h}:${m}:${s}`;
  } catch {
    return '??:??:??';
  }
}

function formatDuration(start: string | null, end: string | null): string {
  if (!start || !end) return 'N/A';
  try {
    const ms = new Date(end).getTime() - new Date(start).getTime();
    if (ms < 0) return 'N/A';
    const totalSec = Math.floor(ms / 1000);
    const hours = Math.floor(totalSec / 3600);
    const minutes = Math.floor((totalSec % 3600) / 60);
    const seconds = totalSec % 60;
    if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
    if (minutes > 0) return `${minutes}m ${seconds}s`;
    return `${seconds}s`;
  } catch {
    return 'N/A';
  }
}

function getEventIcon(type: string): string {
  switch (type) {
    case 'user': return '\u25b6';       // right-pointing triangle
    case 'assistant': return '\u2726';   // four-pointed star
    case 'tool_use': return '\u2699';    // gear
    case 'tool_result': return '\u2190'; // left arrow
    case 'summary': return '\u21bb';     // clockwise arrow
    case 'system': return '\u2022';      // bullet
    default: return ' ';
  }
}

function truncateToWidth(text: string, maxLen: number): string {
  if (maxLen < 10) maxLen = 10;
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= maxLen) return clean;
  return clean.substring(0, maxLen - 3) + '...';
}
