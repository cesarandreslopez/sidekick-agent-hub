/**
 * @fileoverview Type definitions for the session event log.
 *
 * Defines the shape of JSONL log entries and the manifest file
 * used to track all logged sessions.
 *
 * @module types/sessionEventLog
 */

import type { ClaudeSessionEvent } from './claudeSession';

/**
 * A single line in a session event log JSONL file.
 */
export interface SessionEventLogEntry {
  /** Monotonic sequence number within the session */
  seq: number;
  /** ISO 8601 timestamp when Sidekick processed this event */
  processedAt: string;
  /** Which provider produced the event */
  providerId: 'claude-code' | 'opencode' | 'codex';
  /** Provider-assigned session identifier */
  sessionId: string;
  /** The full normalized event */
  event: ClaudeSessionEvent;
}

/**
 * Manifest tracking all logged sessions for quick discovery.
 *
 * Stored at `~/.config/sidekick/event-logs/sessions.json`.
 */
export interface SessionEventLogManifest {
  /** Schema version for future migrations */
  schemaVersion: number;
  /** Session metadata keyed by "{providerId}/{sessionId}" */
  sessions: Record<string, SessionLogMetadata>;
  /** ISO 8601 timestamp of last manifest update */
  lastUpdated: string;
}

/**
 * Metadata about a single logged session.
 */
export interface SessionLogMetadata {
  /** Provider that produced this session */
  providerId: string;
  /** Provider-assigned session identifier */
  sessionId: string;
  /** Relative path from event-logs/ directory */
  filePath: string;
  /** ISO 8601 timestamp of the first logged event */
  firstEventAt: string;
  /** ISO 8601 timestamp of the most recent logged event */
  lastEventAt: string;
  /** Total number of events logged */
  eventCount: number;
  /** File size in bytes (updated on manifest save) */
  fileSizeBytes: number;
}

/** Current schema version for the manifest */
export const EVENT_LOG_SCHEMA_VERSION = 1;
