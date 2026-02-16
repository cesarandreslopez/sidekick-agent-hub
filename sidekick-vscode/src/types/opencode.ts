/**
 * @fileoverview Type definitions for OpenCode session storage format.
 *
 * OpenCode stores data as individual JSON files in ~/.local/share/opencode/storage/:
 * - Sessions: storage/session/{projectID}/{sessionID}.json
 * - Messages: storage/message/{sessionID}/{messageID}.json
 * - Parts: storage/part/{messageID}/{partID}.json
 * - Projects: storage/project/{projectID}.json
 *
 * @module types/opencode
 */

/**
 * OpenCode session metadata.
 * Stored at: storage/session/{projectID}/{sessionID}.json
 */
export interface OpenCodeSession {
  id: string;
  projectID: string;
  title?: string;
  /** Timestamps in ISO 8601 or Unix ms */
  time: {
    created: string | number;
    updated?: string | number;
  };
  /** Whether session is currently active */
  active?: boolean;
}

/**
 * OpenCode message (MessageV2 format).
 * Stored at: storage/message/{sessionID}/{messageID}.json
 */
export interface OpenCodeMessage {
  id: string;
  sessionID: string;
  role: 'user' | 'assistant' | 'system';
  modelID?: string;
  /** Whether this message is a summary/compaction */
  summary?: boolean;
  tokens: {
    input: number;
    output: number;
    cacheRead?: number;
    cacheWrite?: number;
    reasoning?: number;
  };
  time: {
    created: string | number;
    completed?: string | number;
  };
  /** Cost reported by the provider for this message */
  cost?: number;
  /** Provider identifier (e.g., "anthropic", "openai") */
  providerID?: string;
  /** Optional tool annotations at the message level */
  tool?: {
    name?: string;
    id?: string;
  };
  /** Error reported by the provider (AuthError, APIError, OutputLengthError, etc.) */
  error?: {
    type?: string;
    message?: string;
    code?: string | number;
  };
}

/**
 * Base for OpenCode part types.
 * Stored at: storage/part/{messageID}/{partID}.json
 */
interface OpenCodePartBase {
  id: string;
  messageID: string;
  /** Ordering index within the message */
  index?: number;
}

/**
 * Text content part.
 */
export interface OpenCodeTextPart extends OpenCodePartBase {
  type: 'text';
  text: string;
}

/**
 * Reasoning/thinking content part.
 */
export interface OpenCodeReasoningPart extends OpenCodePartBase {
  type: 'reasoning';
  text: string;
}

/**
 * Tool invocation part.
 */
export interface OpenCodeToolInvocationPart extends OpenCodePartBase {
  type: 'tool-invocation';
  callID: string;
  tool: string;
  state: {
    status: 'pending' | 'running' | 'completed' | 'error';
    input?: Record<string, unknown>;
    output?: string;
    error?: string;
    time?: {
      start?: string | number;
      end?: string | number;
    };
  };
}

/**
 * Compaction marker part.
 */
export interface OpenCodeCompactionPart extends OpenCodePartBase {
  type: 'compaction';
  text?: string;
}

/**
 * Tool part (DB format — uses 'tool' instead of 'tool-invocation').
 */
export interface OpenCodeDbToolPart extends OpenCodePartBase {
  type: 'tool';
  callID: string;
  tool: string;
  state: {
    status: 'pending' | 'running' | 'completed' | 'error';
    input?: Record<string, unknown>;
    output?: string;
    error?: string;
    title?: string;
    metadata?: Record<string, unknown>;
    time?: {
      start?: string | number;
      end?: string | number;
      compacted?: string | number;
    };
  };
}

/**
 * Step start marker (DB format).
 */
export interface OpenCodeStepStartPart extends OpenCodePartBase {
  type: 'step-start';
  snapshot?: string;
}

/**
 * Step finish marker (DB format).
 */
export interface OpenCodeStepFinishPart extends OpenCodePartBase {
  type: 'step-finish';
  reason?: string;
  snapshot?: string;
  cost?: number;
  tokens?: {
    input?: number;
    output?: number;
    reasoning?: number;
    cache?: { read?: number; write?: number };
  };
}

/**
 * Patch part — represents a code change (DB format).
 */
export interface OpenCodePatchPart extends OpenCodePartBase {
  type: 'patch';
  hash?: string;
  files?: string[];
}

/**
 * Subtask part — delegated work to a subagent.
 */
export interface OpenCodeSubtaskPart extends OpenCodePartBase {
  type: 'subtask';
  prompt?: string;
  description?: string;
  agent?: string;
  model?: string;
  command?: string;
}

/**
 * Agent part — metadata about an agent invocation.
 */
export interface OpenCodeAgentPart extends OpenCodePartBase {
  type: 'agent';
  name?: string;
  source?: string;
}

/**
 * File part — file attachment or reference.
 */
export interface OpenCodeFilePart extends OpenCodePartBase {
  type: 'file';
  mime?: string;
  filename?: string;
  url?: string;
}

/**
 * Retry part — automatic retry after an error.
 */
export interface OpenCodeRetryPart extends OpenCodePartBase {
  type: 'retry';
  attempt?: number;
  error?: { message?: string; code?: string };
  time?: string | number;
}

/**
 * Snapshot part — conversation state snapshot.
 */
export interface OpenCodeSnapshotPart extends OpenCodePartBase {
  type: 'snapshot';
  snapshot?: string;
}

/**
 * Discriminated union of all OpenCode part types.
 */
export type OpenCodePart =
  | OpenCodeTextPart
  | OpenCodeReasoningPart
  | OpenCodeToolInvocationPart
  | OpenCodeCompactionPart
  | OpenCodeDbToolPart
  | OpenCodeStepStartPart
  | OpenCodeStepFinishPart
  | OpenCodePatchPart
  | OpenCodeSubtaskPart
  | OpenCodeAgentPart
  | OpenCodeFilePart
  | OpenCodeRetryPart
  | OpenCodeSnapshotPart;

/**
 * OpenCode project metadata.
 * Stored at: storage/project/{projectID}.json
 */
export interface OpenCodeProject {
  id: string;
  path: string;
  name?: string;
  time?: {
    created: string | number;
  };
}

// --- Database row types (SQLite schema) ---

/** Raw project row from the SQLite database. */
export interface DbProject {
  id: string;
  worktree: string;
  name: string | null;
  time_created: number;
  time_updated: number;
}

/** Raw session row from the SQLite database. */
export interface DbSession {
  id: string;
  project_id: string;
  title: string;
  directory: string;
  time_created: number;
  time_updated: number;
  /** Non-null for subagent child sessions; references the parent session ID. */
  parent_id?: string | null;
}

/** Raw message row from the SQLite database. */
export interface DbMessage {
  id: string;
  session_id: string;
  time_created: number;
  time_updated: number;
  data: string;
}

/** Raw part row from the SQLite database. */
export interface DbPart {
  id: string;
  message_id: string;
  session_id: string;
  time_created: number;
  time_updated: number;
  data: string;
}
