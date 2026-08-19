/**
 * Reader for Codex's append-only `~/.codex/history.jsonl` (Node-only).
 *
 * Each line is `{"session_id","ts","text"}` — one entry per user prompt. The
 * file grows without bound, so this reader takes a bounded tail instead of the
 * whole file, drops the leading partial line, and parses tolerantly. Pair an
 * entry with {@link findCodexRolloutFile} (providers/codex) to jump from a
 * history row to its full rollout transcript.
 *
 * @module codexHistory
 */

import * as fs from 'fs';
import * as path from 'path';
import { getSystemCodexHome } from '../codexProfiles';

export interface CodexHistoryEntry {
  sessionId: string;
  /** Timestamp exactly as Codex recorded it (epoch seconds). */
  ts: number;
  /** Normalized epoch milliseconds, ready for Date construction. */
  tsMs: number;
  text: string;
}

export interface ReadCodexHistoryOptions {
  /** Codex home containing `history.jsonl` (default: `$CODEX_HOME` or `~/.codex`). */
  codexHome?: string;
  /** Maximum entries returned, newest first (default 100). */
  limit?: number;
  /** Bytes read from the end. Defaults to max(512 KiB, limit × 4096). */
  maxTailBytes?: number;
}

const DEFAULT_LIMIT = 100;
const DEFAULT_TAIL_BYTES = 512 * 1024;

/**
 * Returns the newest history entries, newest first. A missing or unreadable
 * file yields `[]`; malformed lines are skipped. Never throws.
 */
export function readCodexHistory(options: ReadCodexHistoryOptions = {}): CodexHistoryEntry[] {
  const limit = Math.max(0, options.limit ?? DEFAULT_LIMIT);
  if (limit === 0) return [];
  const maxTailBytes = Math.max(
    1,
    options.maxTailBytes ?? Math.max(DEFAULT_TAIL_BYTES, limit * 4096),
  );
  const historyPath = path.join(options.codexHome ?? getSystemCodexHome(), 'history.jsonl');

  let descriptor: number;
  try {
    descriptor = fs.openSync(historyPath, 'r');
  } catch {
    return [];
  }

  try {
    const size = fs.fstatSync(descriptor).size;
    const readBytes = Math.min(size, maxTailBytes);
    const buffer = Buffer.alloc(readBytes);
    fs.readSync(descriptor, buffer, 0, readBytes, size - readBytes);
    let content = buffer.toString('utf8');

    if (readBytes < size) {
      // The tail almost certainly starts mid-line; a multibyte character
      // straddling the boundary decodes as replacement garbage inside that
      // same partial line, so dropping through the first newline handles both.
      const firstNewline = content.indexOf('\n');
      content = firstNewline === -1 ? '' : content.slice(firstNewline + 1);
    }

    const entries: CodexHistoryEntry[] = [];
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let parsed: { session_id?: unknown; ts?: unknown; text?: unknown };
      try {
        parsed = JSON.parse(trimmed) as { session_id?: unknown; ts?: unknown; text?: unknown };
      } catch {
        continue;
      }
      if (
        typeof parsed.session_id !== 'string' ||
        typeof parsed.ts !== 'number' ||
        // JSON.parse('1e400') yields Infinity, which would later RangeError
        // out of Date serialization in consumers.
        !Number.isFinite(parsed.ts) ||
        typeof parsed.text !== 'string'
      ) {
        continue;
      }
      entries.push({
        sessionId: parsed.session_id,
        ts: parsed.ts,
        tsMs: parsed.ts * 1000,
        text: parsed.text,
      });
    }

    // The file is append-only, so on-disk order is oldest first.
    entries.reverse();
    return entries.slice(0, limit);
  } catch {
    return [];
  } finally {
    try {
      fs.closeSync(descriptor);
    } catch {
      // Already closed or invalid; nothing to release.
    }
  }
}
