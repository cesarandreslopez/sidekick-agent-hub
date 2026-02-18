/**
 * @fileoverview Type definitions for cross-session task persistence.
 *
 * These types define the on-disk format for persisting tasks across
 * Claude Code sessions. All types are JSON-safe (no Date, Map, etc.).
 *
 * Storage location: ~/.config/sidekick/tasks/{projectSlug}.json
 *
 * @module types/taskPersistence
 */

import type { TaskStatus } from './claudeSession';

/** Current schema version for task persistence store */
export const TASK_PERSISTENCE_SCHEMA_VERSION = 1;

/**
 * A task serialized for on-disk persistence.
 *
 * Derived from TrackedTask but JSON-safe: Dates become ISO strings,
 * associatedToolCalls are summarized as a count to avoid bloat.
 */
export interface PersistedTask {
  /** Unique task identifier (from Claude Code) */
  taskId: string;

  /** Brief task title */
  subject: string;

  /** Optional task description */
  description?: string;

  /** Task status */
  status: TaskStatus;

  /** Present continuous form shown while task was in_progress */
  activeForm?: string;

  /** When the task was created (ISO 8601) */
  createdAt: string;

  /** When the task was last updated (ISO 8601) */
  updatedAt: string;

  /** Number of tool calls made while task was active */
  toolCallCount: number;

  /** Task IDs that this task is blocked by */
  blockedBy: string[];

  /** Task IDs that this task blocks */
  blocks: string[];

  /** Session ID where this task was created */
  sessionOrigin: string;

  /** Whether this task was carried over from a prior session */
  carriedOver: boolean;

  /** Number of session boundaries this task has crossed */
  sessionAge: number;

  /** Whether this task represents a subagent spawn */
  isSubagent?: boolean;

  /** Subagent type (e.g. "Explore", "Plan", "Bash") */
  subagentType?: string;

  /** Tags for filtering (forward-looking, from project-orchestrator) */
  tags?: string[];
}

/**
 * On-disk store for persisted tasks.
 */
export interface TaskPersistenceStore {
  /** Schema version for future migrations */
  schemaVersion: number;

  /** Persisted tasks keyed by taskId (or namespaced ID for collisions) */
  tasks: Record<string, PersistedTask>;

  /** Session ID of the most recently saved session */
  lastSessionId: string;

  /** Total number of sessions that have contributed tasks */
  sessionCount: number;

  /** ISO 8601 timestamp of last save */
  lastSaved: string;
}
