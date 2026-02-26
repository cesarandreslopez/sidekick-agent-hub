/**
 * Debug log parser for Claude Code debug logs.
 *
 * Claude Code writes debug logs to ~/.claude/debug/. This module parses
 * them into structured entries with level filtering and duplicate collapsing.
 *
 * @module parsers/debugLogParser
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// ── Types ──

export type DebugLogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

export interface DebugLogEntry {
  /** ISO 8601 timestamp */
  timestamp: string;
  /** Log level */
  level: DebugLogLevel;
  /** Main log message (first line) */
  message: string;
  /** Full content including continuation lines */
  fullContent: string;
  /** Line number in the original file (1-based) */
  lineNumber: number;
  /** Number of consecutive duplicates collapsed into this entry */
  duplicateCount?: number;
}

export interface DebugLogFile {
  /** Absolute path to the log file */
  path: string;
  /** Filename */
  name: string;
  /** File modification time */
  mtime: Date;
  /** File size in bytes */
  size: number;
}

// ── Constants ──

const LOG_LINE_PATTERN = /^(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}[.\d]*Z?)\s+(DEBUG|INFO|WARN|ERROR)\s+(.*)$/;
const LEVEL_ORDER: Record<DebugLogLevel, number> = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
};

// ── Public API ──

/**
 * Parses debug log content into structured entries.
 *
 * Handles multi-line entries (continuation lines without timestamps).
 *
 * @param content - Raw log file content
 * @returns Array of parsed log entries
 */
export function parseDebugLog(content: string): DebugLogEntry[] {
  const lines = content.split('\n');
  const entries: DebugLogEntry[] = [];
  let current: DebugLogEntry | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const match = line.match(LOG_LINE_PATTERN);

    if (match) {
      // Save previous entry
      if (current) entries.push(current);

      current = {
        timestamp: match[1],
        level: match[2] as DebugLogLevel,
        message: match[3],
        fullContent: line,
        lineNumber: i + 1,
      };
    } else if (current && line.trim()) {
      // Continuation line
      current.fullContent += '\n' + line;
    }
  }

  // Don't forget the last entry
  if (current) entries.push(current);

  return entries;
}

/**
 * Filters log entries by minimum level.
 *
 * @param entries - Array of log entries
 * @param minLevel - Minimum level to include
 * @returns Filtered entries at or above the minimum level
 */
export function filterByLevel(entries: DebugLogEntry[], minLevel: DebugLogLevel): DebugLogEntry[] {
  const minOrder = LEVEL_ORDER[minLevel];
  return entries.filter(e => LEVEL_ORDER[e.level] >= minOrder);
}

/**
 * Collapses consecutive identical log messages into single entries with counts.
 *
 * @param entries - Array of log entries
 * @returns Collapsed entries with duplicateCount set on collapsed items
 */
export function collapseDuplicates(entries: DebugLogEntry[]): DebugLogEntry[] {
  if (entries.length === 0) return [];

  const result: DebugLogEntry[] = [];
  let current = { ...entries[0], duplicateCount: 1 };

  for (let i = 1; i < entries.length; i++) {
    if (entries[i].message === current.message && entries[i].level === current.level) {
      current.duplicateCount = (current.duplicateCount || 1) + 1;
    } else {
      result.push(current);
      current = { ...entries[i], duplicateCount: 1 };
    }
  }

  result.push(current);
  return result;
}

/**
 * Discovers available debug log files.
 *
 * @returns Array of debug log file info, sorted by mtime (most recent first)
 */
export function discoverDebugLogs(): DebugLogFile[] {
  const debugDir = path.join(os.homedir(), '.claude', 'debug');

  try {
    if (!fs.existsSync(debugDir)) return [];

    return fs.readdirSync(debugDir)
      .filter(f => f.endsWith('.log') || f.endsWith('.txt'))
      .map(name => {
        const fullPath = path.join(debugDir, name);
        try {
          const stat = fs.statSync(fullPath);
          return {
            path: fullPath,
            name,
            mtime: stat.mtime,
            size: stat.size,
          };
        } catch {
          return null;
        }
      })
      .filter((f): f is DebugLogFile => f !== null)
      .sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
  } catch {
    return [];
  }
}
