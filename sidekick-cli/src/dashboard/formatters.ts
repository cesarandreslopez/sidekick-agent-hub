/**
 * Shared formatting utilities for the TUI dashboard.
 * Consolidates duplicated helpers from panels and MindMapBuilder.
 */

import { formatDurationMs, formatTokenCount } from 'sidekick-shared';
import { displayWidth, stripTagged, truncateTagged, wrapTaggedLines } from './blessedText';

/** Shorten a file path to show only the last 3 segments. */
export function shortenPath(p: string): string {
  const parts = p.replace(/\\/g, '/').split('/');
  if (parts.length <= 3) return p;
  return '.../' + parts.slice(-3).join('/');
}

/** Format a count compactly (12.3k, 4.5M) — the same vocabulary as VS Code. */
export function fmtNum(n: number): string {
  return formatTokenCount(n);
}

/** Format a duration in ms to a human-readable string. */
export function formatDuration(ms: number): string {
  return formatDurationMs(ms, {
    style: 'compact',
    includeMilliseconds: true,
    secondsFractionDigits: 1,
  });
}

/**
 * Strip blessed-style tags like `{cyan-fg}` or `{/bold}` from text. The
 * escapes `{open}` and `{close}` (see {@link escapeBlessed}) become the
 * literal braces they stand for.
 */
export function stripBlessedTags(text: string): string {
  return stripTagged(text);
}

/**
 * Escape text for a blessed-tagged string: `{` and `}` become `{open}` and
 * `{close}`, which the tag parser renders as literal braces. Anything built
 * from data (labels, file names, command names) must pass through this, or a
 * `{red-fg}` inside it would be read as a tag.
 */
export function escapeBlessed(text: string): string {
  return text.replace(/[{}]/g, (brace) => (brace === '{' ? '{open}' : '{close}'));
}

/**
 * Return the visible width, in terminal columns, of text containing blessed
 * tags (emoji and CJK count as two).
 */
export function visibleLength(text: string): number {
  return displayWidth(stripBlessedTags(text));
}

/**
 * Truncate plain text to `maxLength` terminal columns, appending "..." if
 * truncated. Braces in the text are escaped by the cut, so pass plain text.
 */
export function truncate(text: string, maxLength: number): string {
  if (displayWidth(text) <= maxLength) return text;
  return stripTagged(truncateTagged(escapeForCut(text), maxLength, '...'));
}

function escapeForCut(text: string): string {
  return text.replace(/[{}]/g, (brace) => (brace === '{' ? '{open}' : '{close}'));
}

/** Format a timestamp to HH:MM:SS. */
export function formatTime(ts: string): string {
  try {
    const d = new Date(ts);
    return d.toLocaleTimeString('en-US', {
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    return '??:??:??';
  }
}

/** Format elapsed time from a start timestamp. */
export function formatElapsed(startTime: string): string {
  const start = new Date(startTime).getTime();
  const diffMs = Date.now() - start;
  if (isNaN(diffMs) || diffMs < 0) return '--:--:--';
  const secs = Math.floor(diffMs / 1000);
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/** Build a section divider line: ── Title ──────── */
export function sectionHeader(title: string, width = 40): string {
  const prefix = '\u2500\u2500 ';
  const suffix = ' ';
  const fillLen = Math.max(0, width - prefix.length - title.length - suffix.length);
  const fill = '\u2500'.repeat(fillLen);
  return `{grey-fg}${prefix}{/grey-fg}{bold}${title}{/bold}{grey-fg}${suffix}${fill}{/grey-fg}`;
}

/** Build a progress bar with blessed color tags. */
export function makeColorBar(percent: number, width: number, color = 'green'): string {
  const clamped = Math.max(0, Math.min(100, percent));
  const filled = Math.round((clamped / 100) * width);
  const empty = width - filled;
  return `{${color}-fg}${'\u2588'.repeat(filled)}{/${color}-fg}{grey-fg}${'\u2591'.repeat(empty)}{/grey-fg}`;
}

/**
 * Build a sparkline from numeric data and return metadata.
 * Returns { spark, max, latest } for inline display with annotations.
 */
export function makeSparkline(
  data: number[],
  maxWidth = 25,
): { spark: string; max: number; latest: number } {
  const trimmed = data.slice(-maxWidth);
  if (trimmed.length === 0) return { spark: '', max: 0, latest: 0 };
  const max = Math.max(...trimmed, 1);
  const latest = trimmed[trimmed.length - 1];
  const chars = [
    ' ',
    '\u2581',
    '\u2582',
    '\u2583',
    '\u2584',
    '\u2585',
    '\u2586',
    '\u2587',
    '\u2588',
  ];
  const spark = trimmed.map((v) => chars[Math.min(8, Math.round((v / max) * 8))]).join('');
  return { spark, max, latest };
}

/**
 * Build an ASCII heatmap from count data.
 * Uses ░▒▓█ intensity characters, with time labels every 5 columns.
 */
export function makeHeatmap(
  buckets: { timestamp: string; count: number }[],
  maxWidth = 60,
): string {
  if (buckets.length === 0) return '{grey-fg}(no activity data){/grey-fg}';
  const maxCount = Math.max(...buckets.map((b) => b.count), 1);
  const chars = [' ', '\u2591', '\u2592', '\u2593', '\u2588'];
  const trimmed = buckets.slice(-maxWidth);

  const heatLine = trimmed
    .map((b) => {
      const intensity = Math.min(4, Math.round((b.count / maxCount) * 4));
      return chars[intensity];
    })
    .join('');

  return `{cyan-fg}${heatLine}{/cyan-fg}\n{grey-fg}${heatmapAxis(trimmed)}{/grey-fg}`;
}

/**
 * Time axis under a heatmap: exactly as wide as the heat line, with an
 * HH:MM label at fixed columns (every 10, starting at 0) so labels sit above
 * the minute they name and never push the axis past the heat line.
 */
export function heatmapAxis(buckets: { timestamp: string }[]): string {
  const axis = Array.from({ length: buckets.length }, () => ' ');
  for (let i = 0; i + 5 <= buckets.length; i += 10) {
    const ts = new Date(buckets[i].timestamp);
    const label = `${ts.getHours().toString().padStart(2, '0')}:${ts
      .getMinutes()
      .toString()
      .padStart(2, '0')}`;
    for (let j = 0; j < label.length; j++) axis[i + j] = label[j];
  }
  return axis.join('').trimEnd();
}

/** Build a progress bar of given width. */
export function makeBar(percent: number, width: number): string {
  const clamped = Math.max(0, Math.min(100, percent));
  const filled = Math.round((clamped / 100) * width);
  return '\u2588'.repeat(filled) + '\u2591'.repeat(width - filled);
}

/** Estimate the detail pane width (terminal minus side panel and borders).
 *  Side panel 26 + border 2 + padding 1 = 29. Fallback to 80 cols when unknown.
 *  @deprecated Assumes the default 26-column side panel, which is wrong in
 *  narrow/wide-side/expanded layouts — prefer the DetailRenderContext width
 *  threaded into DetailTab.render; this remains as a fallback only. */
export function detailWidth(): number {
  return Math.max(40, (process.stdout.columns || 80) - 29);
}

/** Word-wrap text to a given column width, preserving existing line breaks.
 *  Tag-aware: blessed tags like `{cyan-fg}` are not counted toward visible width,
 *  widths are terminal columns, and words longer than the width (paths, URLs)
 *  are hard-broken instead of overflowing.
 *  @param continuationIndent Optional string prepended to continuation lines (hanging indent). */
export function wordWrap(text: string, width: number, continuationIndent = ''): string {
  const indentLen = visibleLength(continuationIndent);
  const w = Math.max(1, width);
  return text
    .split('\n')
    .map((line) => {
      if (visibleLength(line) <= w) return line;
      // First row at full width; the rest leave room for the indent.
      const [first, ...rest] = wrapTaggedLines(line, w);
      if (rest.length === 0) return first;
      const restRows =
        indentLen > 0 ? wrapTaggedLines(rest.join(' '), Math.max(1, w - indentLen)) : rest;
      return [first, ...restRows.map((row) => continuationIndent + row)].join('\n');
    })
    .join('\n');
}
