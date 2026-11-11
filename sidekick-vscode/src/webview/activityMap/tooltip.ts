/**
 * The station tooltip: what a station did this session, in a few lines.
 *
 * @module webview/activityMap/tooltip
 */

import { DEFAULT_ACTIVITY_STRINGS } from 'sidekick-shared/activity';
import type {
  ActivityInsights,
  ActivitySnapshot,
  ActivityStationId,
} from 'sidekick-shared/activity';
import { formatCount, formatDuration } from './format';

export function describeStation(
  station: ActivityStationId,
  snapshot: ActivitySnapshot,
  insights: ActivityInsights,
): string {
  const name = DEFAULT_ACTIVITY_STRINGS.stations[station];
  const now = snapshot.stations.find((s) => s.id === station);
  const stats = insights.stations.find((s) => s.id === station);
  const lines = [name];
  const calls = stats?.calls ?? now?.count ?? 0;
  const parts = [`${calls} ${calls === 1 ? 'call' : 'calls'}`];
  if (stats && stats.busyMs > 0) parts.push(`busy ${formatDuration(stats.busyMs)}`);
  if (stats?.p95Ms) parts.push(`p95 ${formatDuration(stats.p95Ms)}`);
  lines.push(parts.join(' · '));
  const faults: string[] = [];
  if (stats?.errors) faults.push(`${stats.errors} ${stats.errors === 1 ? 'error' : 'errors'}`);
  if (stats?.denials) faults.push(`${stats.denials} denied`);
  if (stats?.cancelled) faults.push(`${stats.cancelled} cancelled`);
  if (faults.length > 0) lines.push(faults.join(' · '));
  if (now?.pushed) lines.push(`${now.pushed} arrived unasked`);
  if (now && now.running > 0) lines.push(`${now.running} running now`);
  if (stats && stats.resultChars > 0) {
    lines.push(`~${formatCount(stats.estTokens)} tokens of output into context`);
  }
  if (stats && stats.topLabels.length > 0) {
    lines.push(
      `Top: ${stats.topLabels
        .slice(0, 3)
        .map((top) => (top.count > 1 ? `${top.label} ×${top.count}` : top.label))
        .join(', ')}`,
    );
  }
  return lines.join('\n');
}

/** Places a tooltip near the pointer, inside the viewport. */
export function placeTooltip(
  tooltip: HTMLElement,
  clientX: number,
  clientY: number,
  viewport: { width: number; height: number },
): void {
  const offset = 12;
  const rect = tooltip.getBoundingClientRect();
  let left = clientX + offset;
  let top = clientY + offset;
  if (left + rect.width > viewport.width - 4) left = Math.max(4, clientX - rect.width - offset);
  if (top + rect.height > viewport.height - 4) top = Math.max(4, clientY - rect.height - offset);
  tooltip.style.left = `${Math.round(left)}px`;
  tooltip.style.top = `${Math.round(top)}px`;
}
