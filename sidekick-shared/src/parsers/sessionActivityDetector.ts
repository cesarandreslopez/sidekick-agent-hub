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
import type { SessionEvent } from '../types/sessionEvent';

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
export const SESSION_ACTIVITY_GRACE_PERIOD_MS = 5_000;
const GRACE_PERIOD_MS = SESSION_ACTIVITY_GRACE_PERIOD_MS;

/** If mtime is older than this, session is stale regardless of content */
export const SESSION_ACTIVITY_STALENESS_MS = 5 * 60 * 1000;
const STALENESS_THRESHOLD_MS = SESSION_ACTIVITY_STALENESS_MS;

/** How many trailing events the in-memory classifier inspects (about a 32 KiB tail). */
const TAIL_EVENTS = 200;

interface ActivitySignals {
  lastAiActivityIndex: number;
  lastEndingIndex: number;
  hasTerminal: boolean;
}

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
const TERMINAL_PATTERNS = ['"type":"result"'];

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
  const lines = tail.split('\n').filter((l) => l.trim().length > 0);
  if (lines.length === 0) {
    return { state: 'ended', lastActivityTime: new Date(stat.mtimeMs), reason: 'no-events' };
  }

  return classifyFromSignals(signalsFromLines(lines), stat.mtimeMs, mtimeAge);
}

function signalsFromLines(lines: readonly string[]): ActivitySignals {
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
        if (pattern === '"type":"user"' && line.includes('"type":"tool_result"')) continue;
        if (line.includes(pattern)) {
          lastEndingIndex = i;
          break;
        }
      }
    }
  }
  return { lastAiActivityIndex, lastEndingIndex, hasTerminal };
}

function hasToolResultBlock(event: SessionEvent): boolean {
  const content = event.message?.content;
  return (
    Array.isArray(content) &&
    content.some(
      (block) =>
        typeof block === 'object' &&
        block !== null &&
        (block as { type?: unknown }).type === 'tool_result',
    )
  );
}

/**
 * The same signals the tail scanner derives from raw JSONL lines, read from
 * canonical events instead: assistant, tool-use, and tool-result events (and
 * user events carrying tool results) are AI activity; an assistant turn that
 * stopped with `end_turn` or a user prompt is an ending event.
 */
function signalsFromEvents(events: readonly SessionEvent[]): ActivitySignals {
  let lastAiActivityIndex = -1;
  let lastEndingIndex = -1;
  for (let i = 0; i < events.length; i++) {
    const event = events[i];
    const carriesToolResult = event.type === 'user' && hasToolResultBlock(event);
    if (
      event.type === 'assistant' ||
      event.type === 'tool_use' ||
      event.type === 'tool_result' ||
      carriesToolResult
    ) {
      lastAiActivityIndex = i;
    }
    if (
      (event.type === 'assistant' && event.message?.stop_reason === 'end_turn') ||
      (event.type === 'user' && !carriesToolResult)
    ) {
      lastEndingIndex = i;
    }
  }
  return { lastAiActivityIndex, lastEndingIndex, hasTerminal: false };
}

function classifyFromSignals(
  signals: ActivitySignals,
  mtimeMs: number,
  mtimeAge: number,
): SessionActivityResult {
  const lastActivityTime = new Date(mtimeMs);
  const { lastAiActivityIndex, lastEndingIndex, hasTerminal } = signals;

  // Terminal patterns mean the session is definitely done
  if (hasTerminal) {
    return { state: 'ended', lastActivityTime, reason: 'terminal-event' };
  }

  // AI activity after the last ending event -> ongoing
  if (lastAiActivityIndex > lastEndingIndex) {
    return { state: 'ongoing', lastActivityTime, reason: 'ai-activity-after-ending' };
  }

  // Ending event with no subsequent AI activity
  if (lastEndingIndex >= 0) {
    // Apply grace period to prevent flicker
    if (mtimeAge < GRACE_PERIOD_MS) {
      return { state: 'ongoing', lastActivityTime, reason: 'grace-period' };
    }
    return { state: 'ended', lastActivityTime, reason: 'ending-event' };
  }

  // No clear signal: if recently modified, assume ongoing
  if (mtimeAge < GRACE_PERIOD_MS) {
    return { state: 'ongoing', lastActivityTime, reason: 'recent-mtime' };
  }

  return { state: 'ended', lastActivityTime, reason: 'no-activity-signal' };
}

export interface ClassifySessionActivityOptions {
  /** Canonical events already read for the session; only the tail is inspected. */
  events: readonly SessionEvent[];
  /** Source mtime; the last event's timestamp is used when unknown. */
  mtimeMs: number | null | undefined;
  /** Clock (default `Date.now()`). */
  now?: number;
}

/**
 * Classify a session from events already in memory, with the same states,
 * reasons, grace period, and staleness rule as {@link detectSessionActivity},
 * but without opening the file again. Works for every provider (the raw
 * tail patterns only ever matched Claude Code JSONL) and for database-backed
 * sessions that have no file to tail.
 */
export function classifySessionActivity(
  options: ClassifySessionActivityOptions,
): SessionActivityResult {
  const now = options.now ?? Date.now();
  const events = options.events;
  const lastEventMs = events.length > 0 ? Date.parse(events[events.length - 1].timestamp) : NaN;
  const mtimeMs =
    typeof options.mtimeMs === 'number' && Number.isFinite(options.mtimeMs)
      ? options.mtimeMs
      : Number.isFinite(lastEventMs)
        ? lastEventMs
        : null;

  if (mtimeMs === null) {
    return { state: 'ended', lastActivityTime: null, reason: 'no-events' };
  }
  const mtimeAge = now - mtimeMs;
  if (mtimeAge > STALENESS_THRESHOLD_MS) {
    return { state: 'stale', lastActivityTime: new Date(mtimeMs), reason: 'mtime-stale' };
  }
  if (events.length === 0) {
    return { state: 'ended', lastActivityTime: new Date(mtimeMs), reason: 'no-events' };
  }
  const tail = events.length > TAIL_EVENTS ? events.slice(-TAIL_EVENTS) : events;
  return classifyFromSignals(signalsFromEvents(tail), mtimeMs, mtimeAge);
}

/**
 * Refresh a cached classification from its unchanged fingerprint without
 * re-reading the transcript. An active file remains active until it crosses
 * the same five-minute staleness boundary used by detectSessionActivity,
 * unless it was active only by grace period (`previousReason`).
 */
export function refreshSessionActivityState(
  previous: 'active' | 'idle' | 'ended' | 'unknown',
  mtimeMs: number,
  nowMs = Date.now(),
  previousReason?: string,
): 'active' | 'idle' | 'ended' | 'unknown' {
  if (!Number.isFinite(mtimeMs)) return previous;
  if (nowMs - mtimeMs > STALENESS_THRESHOLD_MS) return 'idle';
  if (previous === 'ended') return 'ended';
  if (previous === 'idle') return 'idle';
  // A session that was only active thanks to the grace period ends once the
  // grace period lapses, exactly as a fresh classification would say.
  if (
    previous === 'active' &&
    (previousReason === 'grace-period' || previousReason === 'recent-mtime') &&
    nowMs - mtimeMs >= GRACE_PERIOD_MS
  ) {
    return 'ended';
  }
  return previous === 'unknown' ? 'unknown' : 'active';
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
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
    return null;
  }
}
