/**
 * `sidekick history` — Recent user prompts across Codex sessions.
 *
 * Reads a bounded tail of Codex's global `history.jsonl` (one entry per user
 * prompt, across every workspace) and renders a newest-first table. With
 * `--path`, resolves one session id (or unique prefix) to its rollout
 * transcript file so the output composes with `less`, `$EDITOR`, or `jq`.
 *
 * Codex-only for now: Claude Code and OpenCode keep prompts inside their
 * per-session files rather than a global history. Not to be confused with
 * `sidekick quota history` (the utilization heatmap).
 */

import type { Command } from 'commander';
import { findCodexRolloutFile, readCodexHistory } from 'sidekick-shared';
import type { CodexHistoryEntry } from 'sidekick-shared';
import { formatRelativeTime } from '../dashboard/SessionPickerHelpers';
import { parseLimit } from '../utils/parseLimit';

export interface HistoryRow {
  sessionId: string;
  timestamp: string;
  age: string;
  prompt: string;
}

/** Session-id column width in the table (full ids appear in `--json`). */
const SESSION_DISPLAY_CHARS = 8;

/**
 * Size the history tail read to the requested entry count. Real history
 * entries average well under 1 KiB, so 4 KiB each is generous headroom —
 * without this, a `--limit` beyond what fits in the reader's default 512 KiB
 * tail would be silently truncated.
 */
export function tailBytesFor(limit: number): number {
  return Math.max(512 * 1024, limit * 4096);
}

/** Map one raw history entry onto a display row. */
export function toHistoryRow(entry: CodexHistoryEntry, now: Date = new Date()): HistoryRow {
  // Codex writes epoch seconds; tolerate a future switch to milliseconds.
  const ms = entry.ts > 1e12 ? entry.ts : entry.ts * 1000;
  const modified = new Date(ms);
  const prompt = entry.text
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return {
    sessionId: entry.sessionId,
    timestamp: modified.toISOString(),
    age: formatRelativeTime(modified, now),
    prompt,
  };
}

/** Render rows as an AGE / SESSION / PROMPT table sized to the terminal. */
export function formatHistoryTable(rows: HistoryRow[], width: number): string {
  const ageWidth = Math.max(3, ...rows.map((row) => row.age.length));
  const promptWidth = Math.max(20, width - ageWidth - SESSION_DISPLAY_CHARS - 4);

  const lines: string[] = [];
  lines.push(
    ['AGE'.padEnd(ageWidth), 'SESSION'.padEnd(SESSION_DISPLAY_CHARS), 'PROMPT'].join('  '),
  );
  lines.push('-'.repeat(Math.min(width, ageWidth + SESSION_DISPLAY_CHARS + promptWidth + 4)));

  for (const row of rows) {
    const prompt =
      row.prompt.length > promptWidth ? row.prompt.substring(0, promptWidth - 1) + '…' : row.prompt;
    lines.push(
      [
        row.age.padEnd(ageWidth),
        row.sessionId.substring(0, SESSION_DISPLAY_CHARS).padEnd(SESSION_DISPLAY_CHARS),
        prompt,
      ].join('  '),
    );
  }

  lines.push('');
  lines.push(
    `${rows.length} prompt(s) shown (Codex). Use --path <session> for the transcript file.`,
  );
  return lines.join('\n') + '\n';
}

interface ResolveHistorySessionDeps {
  readCodexHistory: typeof readCodexHistory;
  findCodexRolloutFile: typeof findCodexRolloutFile;
}

/**
 * Resolve a full session id or unique prefix to its rollout transcript path.
 *
 * Tries the id verbatim first (full ids work even when the entry has aged out
 * of the history tail), then falls back to a case-insensitive prefix match
 * over recent history.
 */
export function resolveHistorySession(
  query: string,
  deps: ResolveHistorySessionDeps = { readCodexHistory, findCodexRolloutFile },
): { sessionId: string; rolloutPath: string } | { error: string } {
  const trimmed = query.trim();
  if (!trimmed) return { error: 'no session id given' };

  const direct = deps.findCodexRolloutFile(trimmed);
  if (direct) return { sessionId: trimmed, rolloutPath: direct };

  const prefix = trimmed.toLowerCase();
  const matches = [
    ...new Set(
      deps
        .readCodexHistory({ limit: 1000, maxTailBytes: tailBytesFor(1000) })
        .map((entry) => entry.sessionId),
    ),
  ].filter((id) => id.toLowerCase().startsWith(prefix));

  if (matches.length > 1) {
    return {
      error: `session prefix "${trimmed}" is ambiguous; matches:\n  ${matches.join('\n  ')}`,
    };
  }
  const match = matches[0];
  const rolloutPath = match ? deps.findCodexRolloutFile(match) : null;
  if (!match || !rolloutPath) {
    return { error: `no rollout file found for session ${match ?? trimmed}` };
  }
  return { sessionId: match, rolloutPath };
}

export async function historyAction(_opts: Record<string, unknown>, cmd: Command): Promise<void> {
  const globalOpts = cmd.parent!.opts();
  const opts = cmd.opts();
  const asJson = !!globalOpts.json;

  if (globalOpts.provider && globalOpts.provider !== 'codex' && globalOpts.provider !== 'auto') {
    process.stderr.write('Prompt history is Codex-only for now; showing Codex entries.\n');
  }

  if (opts.path) {
    const resolved = resolveHistorySession(String(opts.path));
    if ('error' in resolved) {
      process.stderr.write(`Error: ${resolved.error}\n`);
      process.exitCode = 1;
      return;
    }
    if (asJson) {
      process.stdout.write(JSON.stringify(resolved, null, 2) + '\n');
    } else {
      process.stdout.write(resolved.rolloutPath + '\n');
    }
    return;
  }

  const limit = parseLimit(opts.limit as string | undefined) ?? 20;
  const entries = readCodexHistory({ limit, maxTailBytes: tailBytesFor(limit) });

  if (entries.length === 0) {
    if (asJson) {
      process.stdout.write('[]\n');
    } else {
      process.stderr.write(
        'No prompt history found. Codex records prompts in ~/.codex/history.jsonl; ' +
          'Claude Code and OpenCode are not yet supported.\n',
      );
    }
    return;
  }

  const rows = entries.map((entry) => toHistoryRow(entry));
  if (asJson) {
    process.stdout.write(JSON.stringify(rows, null, 2) + '\n');
    return;
  }
  process.stdout.write(formatHistoryTable(rows, process.stdout.columns || 120));
}
