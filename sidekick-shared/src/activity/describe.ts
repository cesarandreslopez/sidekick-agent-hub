/**
 * Plain-text descriptions of the map, for accessibility, terminals and MCP.
 *
 * Every sentence is built from names and numbers already in the snapshot or
 * insights, so it carries no more than the map itself.
 *
 * Pure.
 *
 * @module activity/describe
 */

import {
  activityEntryLabel,
  formatActivityCount,
  formatActivityDuration,
  shortActivityModel,
} from './render/format';
import { resolveActivityStrings } from './strings';
import type { ActivityStrings } from './strings';
import type {
  ActivityEntry,
  ActivityInsights,
  ActivityPattern,
  ActivitySnapshot,
  DescribeActivityInsightsOptions,
  DescribeActivityOptions,
} from './types';

function contextSuffix(snapshot: ActivitySnapshot, strings: ActivityStrings): string {
  return snapshot.context === undefined
    ? ''
    : ` · ${strings.context} ${Math.round(Math.max(0, Math.min(100, snapshot.context.percent)))}%`;
}

/** The running entry to name: the newest main-loop call, else the newest of any. */
function topRunning(running: readonly ActivityEntry[]): ActivityEntry | undefined {
  let best: ActivityEntry | undefined;
  for (const entry of running) {
    if (entry.endedAt !== undefined) continue;
    const isMain = entry.agentId === undefined;
    const bestMain = best !== undefined && best.agentId === undefined;
    if (
      best === undefined ||
      (isMain && !bestMain) ||
      (isMain === bestMain && entry.startedAt >= best.startedAt)
    ) {
      best = entry;
    }
  }
  return best;
}

/** One line: what is running now, and how full the context is. */
export function describeActivityNow(
  snapshot: ActivitySnapshot,
  options: DescribeActivityOptions = {},
): string {
  const strings = resolveActivityStrings(options.strings);
  const context = contextSuffix(snapshot, strings);
  const open = snapshot.running.filter((entry) => entry.endedAt === undefined);
  const top = topRunning(open);
  if (top !== undefined) {
    const more = open.length > 1 ? strings.andMore(open.length - 1) : '';
    return `${strings.stations[top.station]}: ${activityEntryLabel(top, strings)}${more}${context}`;
  }
  if (snapshot.turn.working && snapshot.turn.thinkingSince !== undefined) {
    return `${strings.stations.model}: ${strings.thinking}${context}`;
  }
  return `${strings.idle}${context}`;
}

export function describeActivityPattern(
  pattern: ActivityPattern,
  overrides?: Partial<ActivityStrings>,
): string {
  const strings = resolveActivityStrings(overrides);
  if (pattern.kind === 'retry-streak') {
    const base = strings.retryStreak(strings.stations[pattern.station], pattern.failures);
    if (pattern.state === 'recovered') return `${base}, then recovered`;
    if (pattern.state === 'abandoned') return `${base}, then moved on`;
    return base;
  }
  const [a, b] = pattern.stations;
  return pattern.flavor === 'edit-test'
    ? strings.editTestLoop(pattern.cycles)
    : strings.alternation(strings.stations[a], strings.stations[b], pattern.cycles);
}

function percent(share: number): string {
  return `${Math.round(Math.max(0, Math.min(1, share)) * 100)}%`;
}

/** A few lines: where the session's time, faults and context went, and any patterns. */
export function describeActivityInsights(
  insights: ActivityInsights,
  options: DescribeActivityInsightsOptions = {},
): string {
  const strings = resolveActivityStrings(options.strings);
  const maxLines = Math.max(1, Math.floor(options.maxLines ?? 12));
  const name = (id: keyof ActivityStrings['stations']) => strings.stations[id];
  const t = insights.totals;
  const lines: string[] = [];

  const used = insights.stations.filter((s) => s.calls > 0);
  const span =
    insights.span.activeMs > 0
      ? insights.span.activeMs
      : insights.span.startAt !== undefined && insights.span.endAt !== undefined
        ? insights.span.endAt - insights.span.startAt
        : 0;
  const faults: string[] = [];
  if (t.errors > 0) faults.push(`${t.errors} error${t.errors === 1 ? '' : 's'}`);
  if (t.denials > 0) faults.push(`${t.denials} denied`);
  if (t.cancelled > 0) faults.push(`${t.cancelled} cancelled`);
  lines.push(
    `${t.calls} call${t.calls === 1 ? '' : 's'} at ${used.length} station${used.length === 1 ? '' : 's'}` +
      (span > 0 ? ` over ${formatActivityDuration(span)}` : '') +
      ` · ${t.prompts} prompt${t.prompts === 1 ? '' : 's'}, ${t.steps} model step${t.steps === 1 ? '' : 's'}` +
      (faults.length > 0 ? ` · ${faults.join(', ')}` : '') +
      '.',
  );

  const busiest = [...insights.stations]
    .filter((s) => s.busyMs > 0)
    .sort((a, b) => b.busyMs - a.busyMs || a.id.localeCompare(b.id))
    .slice(0, 3);
  if (busiest.length > 0) {
    lines.push(
      `Busiest: ${busiest
        .map((s) => `${name(s.id)} ${formatActivityDuration(s.busyMs)} (${percent(s.shareOfBusy)})`)
        .join(', ')}.`,
    );
  }

  const heaviest = [...insights.stations]
    .filter((s) => s.estTokens > 0)
    .sort((a, b) => b.estTokens - a.estTokens || a.id.localeCompare(b.id))
    .slice(0, 3);
  if (heaviest.length > 0) {
    lines.push(
      `Most context: ${heaviest
        .map((s) => `${name(s.id)} ~${formatActivityCount(s.estTokens)} tokens`)
        .join(', ')}.`,
    );
  }

  const faulty = insights.stations
    .filter((s) => s.errors + s.denials > 0)
    .sort((a, b) => b.errors + b.denials - (a.errors + a.denials) || a.id.localeCompare(b.id))
    .slice(0, 4);
  if (faulty.length > 0) {
    lines.push(
      `Faults: ${faulty
        .map((s) => {
          const parts: string[] = [];
          if (s.errors > 0) parts.push(`${s.errors} error${s.errors === 1 ? '' : 's'}`);
          if (s.denials > 0) parts.push(`${s.denials} denied`);
          return `${name(s.id)} ${parts.join(', ')}`;
        })
        .join('; ')}.`,
    );
  }

  for (const pattern of insights.patterns.slice(-4)) {
    lines.push(`Pattern: ${describeActivityPattern(pattern, options.strings)}.`);
  }

  if (insights.models.length > 0) {
    lines.push(
      `Models: ${insights.models
        .map((m) => `${shortActivityModel(m.model)} (${m.steps} step${m.steps === 1 ? '' : 's'})`)
        .join(', ')}.`,
    );
  }

  const slow = insights.slowest[0];
  if (slow !== undefined) {
    lines.push(
      `Slowest: ${name(slow.station)} ${slow.label} ${formatActivityDuration(slow.durationMs)}.`,
    );
  }

  const extras: string[] = [];
  if (t.subagents > 0) extras.push(`${t.subagents} subagent${t.subagents === 1 ? '' : 's'}`);
  if (t.hookRuns > 0) {
    extras.push(
      `${t.hookRuns} hook run${t.hookRuns === 1 ? '' : 's'} (${formatActivityDuration(t.hookMs)})`,
    );
  }
  if (t.pushed > 0) extras.push(`${t.pushed} memory push${t.pushed === 1 ? '' : 'es'}`);
  if (t.compactions > 0) {
    extras.push(`${t.compactions} compaction${t.compactions === 1 ? '' : 's'}`);
  }
  if (extras.length > 0) lines.push(`${extras.join(' · ')}.`);

  return lines.slice(0, maxLines).join('\n');
}
