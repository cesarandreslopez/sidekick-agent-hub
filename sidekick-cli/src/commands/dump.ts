/**
 * `sidekick dump` — Dump session data as text timeline, JSON metrics, or markdown report.
 *
 * Reads a full session JSONL file, processes all events through EventAggregator,
 * and outputs in the requested format.
 *
 * With `--list`, enumerates available session IDs for the current project.
 */

import * as path from 'path';
import type { Command } from 'commander';
import {
  EventAggregator,
  createWatcher,
  formatSessionText,
  formatSessionMarkdown,
  formatSessionJson,
  listSessionPreviews,
} from 'sidekick-shared';
import type { FollowEvent, SessionPreview } from 'sidekick-shared';
import { resolveProvider } from '../cli';
import { toCsv, type CsvColumn } from '../csv';
import { parseLimit } from '../utils/parseLimit';

type OutputFormat = 'text' | 'json' | 'markdown';

/**
 * Format a Date as a compact ISO-like string: YYYY-MM-DD HH:MM.
 */
function formatTimestamp(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Format a relative time string from a Date.
 */
function formatAge(mtime: Date): string {
  const diffMs = Date.now() - mtime.getTime();
  if (diffMs < 0) return 'just now';

  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return 'just now';

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/**
 * Map bounded session previews onto the `--list` row shape.
 *
 * The `id` is the provider-canonical session id (what `--session` accepts),
 * falling back to the file basename when a preview carries no id.
 */
export function buildSessionListRows(previews: SessionPreview[]): Array<{
  id: string;
  timestamp: string;
  age: string;
  label: string;
  size: number;
}> {
  return previews.map((preview) => {
    const modified = new Date(preview.modifiedAt);
    return {
      id: preview.sessionId || path.basename(preview.filePath, path.extname(preview.filePath)),
      timestamp: formatTimestamp(modified),
      age: formatAge(modified),
      label: preview.firstUserPrompt || '',
      size: preview.sizeBytes,
    };
  });
}

const SESSION_LIST_CSV_COLUMNS: CsvColumn<ReturnType<typeof buildSessionListRows>[number]>[] = [
  { header: 'id', value: (row) => row.id },
  { header: 'modified', value: (row) => row.timestamp },
  { header: 'age', value: (row) => row.age },
  { header: 'label', value: (row) => row.label },
  { header: 'size_bytes', value: (row) => row.size },
];

/**
 * List available sessions for the current project and output as table, JSON,
 * or CSV. Bounded: labels are read only for the `limit` most recent sessions.
 */
function listSessions(
  provider: ReturnType<typeof resolveProvider>,
  workspacePath: string,
  output: 'table' | 'json' | 'csv',
  limit: number,
): void {
  const previews = listSessionPreviews([provider], { workspacePath, limit });

  if (previews.length === 0) {
    if (output === 'json') {
      process.stdout.write('[]\n');
    } else if (output === 'csv') {
      process.stdout.write(toCsv([], SESSION_LIST_CSV_COLUMNS));
    } else {
      process.stderr.write('No sessions found for this project.\n');
    }
    return;
  }

  const sessions = buildSessionListRows(previews);

  if (output === 'json') {
    process.stdout.write(JSON.stringify(sessions, null, 2) + '\n');
    return;
  }
  if (output === 'csv') {
    process.stdout.write(toCsv(sessions, SESSION_LIST_CSV_COLUMNS));
    return;
  }

  // Table output
  // Determine column widths
  const idWidth = Math.max(10, ...sessions.map((s) => s.id.length));
  const tsWidth = 16; // "YYYY-MM-DD HH:MM"
  const ageWidth = Math.max(3, ...sessions.map((s) => s.age.length));
  const labelWidth = Math.min(50, Math.max(5, ...sessions.map((s) => s.label.length)));

  const header = [
    'ID'.padEnd(idWidth),
    'MODIFIED'.padEnd(tsWidth),
    'AGE'.padEnd(ageWidth),
    'LABEL',
  ].join('  ');

  process.stdout.write(header + '\n');
  process.stdout.write('-'.repeat(header.length) + '\n');

  for (const s of sessions) {
    const truncatedLabel =
      s.label.length > labelWidth ? s.label.substring(0, labelWidth - 1) + '\u2026' : s.label;
    const row = [
      s.id.padEnd(idWidth),
      s.timestamp.padEnd(tsWidth),
      s.age.padEnd(ageWidth),
      truncatedLabel,
    ].join('  ');
    process.stdout.write(row + '\n');
  }

  if (sessions.length === limit) {
    process.stdout.write(
      `\n${sessions.length} most recent session(s) shown (raise --limit for more).\n`,
    );
  } else {
    process.stdout.write(`\n${sessions.length} session(s) found.\n`);
  }
}

export async function dumpAction(_opts: Record<string, unknown>, cmd: Command): Promise<void> {
  const globalOpts = cmd.parent!.opts();
  const opts = cmd.opts();
  const provider = resolveProvider(globalOpts);
  const workspacePath = globalOpts.project || process.cwd();

  // Handle --list: enumerate sessions and exit
  if (opts.list) {
    try {
      const limit = parseLimit(opts.limit as string | undefined) ?? 50;
      listSessions(
        provider,
        workspacePath,
        globalOpts.json ? 'json' : opts.csv ? 'csv' : 'table',
        limit,
      );
    } finally {
      try {
        provider.dispose();
      } catch {
        /* ignore */
      }
    }
    return;
  }

  const sessionId: string | undefined = opts.session;
  // The global --json flag means JSON here too, so `sidekick --json dump` and
  // `sidekick dump --format json` are the same request.
  const format: OutputFormat = globalOpts.json ? 'json' : (opts.format as OutputFormat) || 'text';
  const termWidth: number = opts.width
    ? parseInt(opts.width as string, 10)
    : process.stdout.columns || 120;
  const expand: boolean = !!opts.expand;

  // Collect all events by replaying through the watcher
  const events: FollowEvent[] = [];
  let sessionPath: string;

  try {
    try {
      const result = createWatcher({
        provider,
        workspacePath,
        sessionId,
        callbacks: {
          onEvent: (event: FollowEvent) => {
            events.push(event);
          },
          onError: (_err: Error) => {
            /* ignore */
          },
        },
      });
      sessionPath = result.sessionPath;

      // Synchronous replay of all existing events
      result.watcher.start(true);
      result.watcher.stop();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`Error: ${msg}\n`);
      process.exitCode = 1;
      return;
    }

    // Process all events through the aggregator
    const aggregator = new EventAggregator({
      providerId: provider.id as 'claude-code' | 'opencode' | 'codex',
    });
    for (const event of events) {
      aggregator.processFollowEvent(event);
    }

    const metrics = aggregator.getMetrics();
    const sessionFileName = path.basename(sessionPath);

    switch (format) {
      case 'json':
        process.stdout.write(formatSessionJson(metrics));
        break;
      case 'markdown':
        process.stdout.write(formatSessionMarkdown(metrics, { expand, sessionFileName }));
        break;
      case 'text':
      default:
        process.stdout.write(formatSessionText(metrics, { width: termWidth, expand }));
        break;
    }
  } finally {
    try {
      provider.dispose();
    } catch {
      /* ignore */
    }
  }
}
