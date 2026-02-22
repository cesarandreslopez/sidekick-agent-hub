/**
 * On-disk schema types for cross-session task persistence.
 * Canonical source: sidekick-vscode/src/types/taskPersistence.ts + claudeSession.ts (TaskStatus)
 */

export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'deleted';

export const TASK_PERSISTENCE_SCHEMA_VERSION = 1;

export interface PersistedTask {
  taskId: string;
  subject: string;
  description?: string;
  status: TaskStatus;
  activeForm?: string;
  createdAt: string;
  updatedAt: string;
  toolCallCount: number;
  blockedBy: string[];
  blocks: string[];
  sessionOrigin: string;
  carriedOver: boolean;
  sessionAge: number;
  isSubagent?: boolean;
  subagentType?: string;
  tags?: string[];
  isGoalGate?: boolean;
}

export interface TaskPersistenceStore {
  schemaVersion: number;
  tasks: Record<string, PersistedTask>;
  lastSessionId: string;
  sessionCount: number;
  lastSaved: string;
}
