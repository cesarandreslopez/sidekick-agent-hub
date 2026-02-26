/**
 * Content-based session activity detection.
 *
 * Uses heuristics on the tail of a JSONL file to determine if a session
 * is genuinely ongoing (AI thinking/calling tools), ended (final output
 * delivered), or stale (no updates for >5 minutes).
 *
 * Inspired by tail-claude's ending-event classification and grace periods.
 *
 * @module parsers/sessionActivityDetector
 */

import * as fs from 'fs';

// ── Types ──

export type SessionActivityState = 'ongoing' | 'ended' | 'stale';

export interface SessionActivityResult {
  state: SessionActivityState;
  /** Timestamp of the last meaningful event */
  lastActivityTime: Date | null;
  /** Reason for the classification */
  reason: string;
}

// ── Constants ──

/** How many bytes to read from the end of the file for analysis */
const TAIL_BYTES = 32 * 1024;

/** Grace period to prevent spinner flicker (ms) */
const GRACE_PERIOD_MS = 5_000;

/** If mtime is older than this, session is stale regardless of content */
const STALENESS_THRESHOLD_MS = 5 * 60 * 1000;

// ── Event Classification Patterns ──

/** Patterns indicating the AI is actively working */
const AI_ACTIVITY_PATTERNS = [
  '"type":"assistant"',
  '"type":"tool_use"',
  '"type":"tool_result"',
  '"stop_reason":"tool_use"',
];

/** Patterns indicating the session has ended (final output delivered) */
const ENDING_PATTERNS = [
  '"stop_reason":"end_turn"',
  '"type":"result"',
  '"type":"user"', // User typing means AI is done with its turn
];

/** Patterns that definitely mean the session is done */
const TERMINAL_PATTERNS = [
  '"type":"result"',
];

// ── Public API ──

/**
 * Determines whether a session is ongoing, ended, or stale.
 *
 * Uses a multi-signal approach:
 * 1. File mtime staleness check (>5min → stale)
 * 2. Content-based: reads last ~32KB and classifies the ending pattern
 * 3. Grace period: prevents flicker by requiring 5s of inactivity before "ended"
 *
 * @param sessionPath - Path to the JSONL session file
 * @returns Activity state with classification reason
 */
export function detectSessionActivity(sessionPath: string): SessionActivityResult {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(sessionPath);
  } catch {
    return { state: 'ended', lastActivityTime: null, reason: 'file-not-found' };
  }

  const now = Date.now();
  const mtimeAge = now - stat.mtimeMs;

  // Staleness check: if file hasn't been touched in >5 minutes, it's stale
  if (mtimeAge > STALENESS_THRESHOLD_MS) {
    return { state: 'stale', lastActivityTime: new Date(stat.mtimeMs), reason: 'mtime-stale' };
  }

  // Read the tail of the file for content analysis
  const tail = readTail(sessionPath, stat.size);
  if (!tail) {
    return { state: 'ended', lastActivityTime: new Date(stat.mtimeMs), reason: 'empty-file' };
  }

  // Parse the last few JSONL lines
  const lines = tail.split('\n').filter(l => l.trim().length > 0);
  if (lines.length === 0) {
    return { state: 'ended', lastActivityTime: new Date(stat.mtimeMs), reason: 'no-events' };
  }

  // Find the last line that matches each category
  let lastAiActivityIndex = -1;
  let lastEndingIndex = -1;
  let hasTerminal = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    for (const pattern of AI_ACTIVITY_PATTERNS) {
      if (line.includes(pattern)) {
        lastAiActivityIndex = i;
        break;
      }
    }

    for (const pattern of TERMINAL_PATTERNS) {
      if (line.includes(pattern)) {
        hasTerminal = true;
        lastEndingIndex = i;
        break;
      }
    }

    if (!hasTerminal) {
      for (const pattern of ENDING_PATTERNS) {
        if (line.includes(pattern)) {
          lastEndingIndex = i;
          break;
        }
      }
    }
  }

  // Terminal patterns mean the session is definitely done
  if (hasTerminal) {
    return { state: 'ended', lastActivityTime: new Date(stat.mtimeMs), reason: 'terminal-event' };
  }

  // AI activity after the last ending event → ongoing
  if (lastAiActivityIndex > lastEndingIndex) {
    return { state: 'ongoing', lastActivityTime: new Date(stat.mtimeMs), reason: 'ai-activity-after-ending' };
  }

  // Ending event with no subsequent AI activity
  if (lastEndingIndex >= 0) {
    // Apply grace period to prevent flicker
    if (mtimeAge < GRACE_PERIOD_MS) {
      return { state: 'ongoing', lastActivityTime: new Date(stat.mtimeMs), reason: 'grace-period' };
    }
    return { state: 'ended', lastActivityTime: new Date(stat.mtimeMs), reason: 'ending-event' };
  }

  // No clear signal — if recently modified, assume ongoing
  if (mtimeAge < GRACE_PERIOD_MS) {
    return { state: 'ongoing', lastActivityTime: new Date(stat.mtimeMs), reason: 'recent-mtime' };
  }

  return { state: 'ended', lastActivityTime: new Date(stat.mtimeMs), reason: 'no-activity-signal' };
}

// ── Helpers ──

function readTail(filePath: string, fileSize: number): string | null {
  const bytesToRead = Math.min(TAIL_BYTES, fileSize);
  if (bytesToRead <= 0) return null;

  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, 'r');
    const buffer = Buffer.alloc(bytesToRead);
    const offset = Math.max(0, fileSize - bytesToRead);
    const bytesRead = fs.readSync(fd, buffer, 0, bytesToRead, offset);
    fs.closeSync(fd);
    fd = null;
    return buffer.toString('utf-8', 0, bytesRead);
  } catch {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* ignore */ } }
    return null;
  }
}
