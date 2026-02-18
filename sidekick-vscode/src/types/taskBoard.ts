/**
 * @fileoverview Type definitions for task board webview communication.
 *
 * This module defines message types and state for the Kanban-style
 * task board visualization of Claude Code session tasks.
 *
 * @module types/taskBoard
 */

import type { TaskStatus } from './claudeSession';

/**
 * Task card displayed on the board.
 */
export interface TaskCard {
  /** Unique task identifier */
  taskId: string;

  /** Brief task title */
  subject: string;

  /** Optional task description */
  description?: string;

  /** Task status */
  status: TaskStatus;

  /** Present continuous form shown while task is in_progress */
  activeForm?: string;

  /** When the task was created (ISO 8601) */
  createdAt: string;

  /** When the task was last updated (ISO 8601) */
  updatedAt: string;

  /** Count of tool calls while task was active */
  toolCallCount: number;

  /** Task IDs that this task is blocked by */
  blockedBy: string[];

  /** Task IDs that this task blocks */
  blocks: string[];

  /** Whether this is the currently active task */
  isActive: boolean;

  /** Whether this card represents a subagent spawn */
  isSubagent?: boolean;

  /** Subagent type (e.g. "Explore", "Plan", "Bash") */
  subagentType?: string;

  /** Whether this task was carried over from a prior session */
  carriedOver?: boolean;

  /** Session ID where this task was created */
  sessionOrigin?: string;

  /** Number of session boundaries this task has crossed */
  sessionAge?: number;

  /** Tags for filtering */
  tags?: string[];
}

/**
 * Column of the task board.
 */
export interface TaskBoardColumn {
  /** Status represented by the column */
  status: TaskStatus;

  /** Display label for the column */
  label: string;

  /** Tasks in this column */
  tasks: TaskCard[];
}

/**
 * Task board state sent to the webview.
 */
export interface TaskBoardState {
  /** Columns for rendering */
  columns: TaskBoardColumn[];

  /** Whether session is active */
  sessionActive: boolean;

  /** Last update timestamp (ISO 8601) */
  lastUpdated: string;

  /** Total tasks tracked */
  totalTasks: number;

  /** Active task ID if any */
  activeTaskId: string | null;

  /** Number of carried-over tasks from prior sessions */
  carriedOverCount: number;
}

/**
 * Messages from extension to webview.
 */
export type TaskBoardMessage =
  | { type: 'updateBoard'; state: TaskBoardState }
  | { type: 'sessionStart'; sessionPath: string }
  | { type: 'sessionEnd' };

/**
 * Messages from webview to extension.
 */
export type WebviewTaskBoardMessage =
  | { type: 'webviewReady' }
  | { type: 'requestBoard' }
  | { type: 'clearCompleted' }
  | { type: 'archiveAll' };
