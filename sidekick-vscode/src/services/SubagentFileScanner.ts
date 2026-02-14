/**
 * @fileoverview Service for scanning subagent JSONL files.
 *
 * This module provides functionality to scan Claude Code subagent session files
 * located in <sessionDir>/<sessionId>/subagents/agent-*.jsonl and extract
 * tool calls made by subagents.
 *
 * @module services/SubagentFileScanner
 */

import * as fs from 'fs';
import * as path from 'path';
import type { ToolCall, SubagentStats, TaskState, TrackedTask, TaskStatus } from '../types/claudeSession';
import { log } from './Logger';
import { extractTaskIdFromResult } from '../utils/taskHelpers';

/**
 * Pattern for matching subagent JSONL files.
 * Files are named like: agent-<hash>.jsonl
 */
const AGENT_FILE_PATTERN = /^agent-(.+)\.jsonl$/;

/** Task-related tool names */
const TASK_TOOLS = ['TaskCreate', 'TaskUpdate', 'TaskGet', 'TaskList'];

/**
 * Scans subagent directory for agent JSONL files and extracts tool calls.
 *
 * Subagent files are located at: <sessionDir>/<sessionId>/subagents/agent-*.jsonl
 *
 * @param sessionDir - Directory containing the session file
 * @param sessionId - Session ID (filename without .jsonl extension)
 * @returns Array of SubagentStats with tool calls, empty array if no subagents
 *
 * @example
 * ```typescript
 * const stats = scanSubagentDir('/home/user/.claude/projects/myproject', 'abc123');
 * for (const agent of stats) {
 *   console.log(`Agent ${agent.agentId}: ${agent.toolCalls.length} tool calls`);
 * }
 * ```
 */
export function scanSubagentDir(sessionDir: string, sessionId: string): SubagentStats[] {
  const subagentsDir = path.join(sessionDir, sessionId, 'subagents');
  const results: SubagentStats[] = [];

  log(`[SubagentScanner] Scanning: ${subagentsDir}`);

  try {
    if (!fs.existsSync(subagentsDir)) {
      log(`[SubagentScanner] Directory does not exist`);
      return results;
    }

    const files = fs.readdirSync(subagentsDir);
    log(`[SubagentScanner] Found ${files.length} files: ${files.join(', ')}`);

    for (const file of files) {
      const match = file.match(AGENT_FILE_PATTERN);
      if (!match) {
        continue;
      }

      const agentId = match[1];
      const filePath = path.join(subagentsDir, file);
      const agentStats = parseAgentFile(filePath, agentId);

      if (agentStats) {
        log(`[SubagentScanner] Agent ${agentId}: ${agentStats.toolCalls.length} tool calls`);
        results.push(agentStats);
      } else {
        log(`[SubagentScanner] Agent ${agentId}: no stats returned`);
      }
    }
  } catch {
    // Directory read failed - subagents dir may not exist yet
    log(`Failed to scan subagents directory: ${subagentsDir}`);
  }

  log(`[SubagentScanner] Returning ${results.length} subagent stats`);
  return results;
}

/**
 * Parses a single subagent JSONL file and extracts tool calls and task state.
 *
 * @param filePath - Path to the agent JSONL file
 * @param agentId - Agent ID extracted from filename
 * @returns SubagentStats or null if parsing fails
 */
function parseAgentFile(filePath: string, agentId: string): SubagentStats | null {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n').filter(line => line.trim());

    const toolCalls: ToolCall[] = [];
    let agentType: string | undefined;
    let description: string | undefined;

    // Task tracking state
    const taskState: TaskState = {
      tasks: new Map(),
      activeTaskId: null
    };
    const pendingTaskCreates = new Map<string, {
      subject: string;
      description?: string;
      activeForm?: string;
      timestamp: Date;
    }>();

    for (const line of lines) {
      try {
        const event = JSON.parse(line);
        const eventTimestamp = new Date(event.timestamp || Date.now());

        // Extract agent type and description from Task tool invocation
        // This appears in the parent session, but we can also look for it
        // in the first system message or context
        if (event.type === 'system' && event.message?.content) {
          const contentStr = typeof event.message.content === 'string'
            ? event.message.content
            : JSON.stringify(event.message.content);

          // Try to extract agent type from system message
          const typeMatch = contentStr.match(/subagent_type['":\s]+(\w+)/i);
          if (typeMatch) {
            agentType = typeMatch[1];
          }
        }

        // Look for tool_use events in assistant messages
        if (event.type === 'assistant' && event.message?.content) {
          const contentArray = Array.isArray(event.message.content)
            ? event.message.content
            : [];

          for (const block of contentArray) {
            if (block && typeof block === 'object' && block.type === 'tool_use') {
              const toolUse = block as {
                type: string;
                id: string;
                name: string;
                input: Record<string, unknown>;
              };

              const toolCall: ToolCall = {
                name: toolUse.name,
                input: toolUse.input || {},
                timestamp: eventTimestamp
              };

              // Handle task tools
              if (toolUse.name === 'TaskCreate') {
                pendingTaskCreates.set(toolUse.id, {
                  subject: String(toolUse.input.subject || ''),
                  description: toolUse.input.description ? String(toolUse.input.description) : undefined,
                  activeForm: toolUse.input.activeForm ? String(toolUse.input.activeForm) : undefined,
                  timestamp: eventTimestamp
                });
              } else if (toolUse.name === 'TaskUpdate') {
                handleTaskUpdate(taskState, toolUse.input, eventTimestamp);
              }

              // Associate non-task tool calls with active task
              if (!TASK_TOOLS.includes(toolUse.name) && taskState.activeTaskId) {
                const activeTask = taskState.tasks.get(taskState.activeTaskId);
                if (activeTask) {
                  activeTask.associatedToolCalls.push(toolCall);
                }
              }

              toolCalls.push(toolCall);

              // If this is a Task tool call (spawning another subagent), extract info
              if (toolUse.name === 'Task' && toolUse.input) {
                if (toolUse.input.subagent_type && !agentType) {
                  agentType = String(toolUse.input.subagent_type);
                }
                if (toolUse.input.description && !description) {
                  description = String(toolUse.input.description);
                }
              }
            }
          }
        }

        // Look for tool_result events in user messages
        if (event.type === 'user' && event.message?.content) {
          const contentArray = Array.isArray(event.message.content)
            ? event.message.content
            : [];

          for (const block of contentArray) {
            if (block && typeof block === 'object' && block.type === 'tool_result') {
              const toolResult = block as {
                type: string;
                tool_use_id: string;
                content?: unknown;
                is_error?: boolean;
              };

              // Handle TaskCreate results
              const pendingCreate = pendingTaskCreates.get(toolResult.tool_use_id);
              if (pendingCreate && !toolResult.is_error) {
                const taskId = extractTaskIdFromResult(toolResult.content);
                if (taskId) {
                  const task: TrackedTask = {
                    taskId,
                    subject: pendingCreate.subject,
                    description: pendingCreate.description,
                    status: 'pending',
                    createdAt: pendingCreate.timestamp,
                    updatedAt: eventTimestamp,
                    activeForm: pendingCreate.activeForm,
                    blockedBy: [],
                    blocks: [],
                    associatedToolCalls: []
                  };
                  taskState.tasks.set(taskId, task);
                }
                pendingTaskCreates.delete(toolResult.tool_use_id);
              }
            }
          }
        }
      } catch {
        // Skip malformed lines
      }
    }

    // If we found any tool calls, return the stats
    if (toolCalls.length > 0 || agentType || description) {
      return {
        agentId,
        agentType,
        description,
        toolCalls,
        taskState: taskState.tasks.size > 0 ? taskState : undefined
      };
    }

    return null;
  } catch {
    log(`Failed to parse agent file: ${filePath}`);
    return null;
  }
}

/**
 * Handles TaskUpdate tool input and updates task state.
 */
function handleTaskUpdate(
  taskState: TaskState,
  input: Record<string, unknown>,
  timestamp: Date
): void {
  const taskId = String(input.taskId || '');
  let task = taskState.tasks.get(taskId);

  if (!task) {
    // Create placeholder task for unknown TaskUpdate
    task = {
      taskId,
      subject: input.subject ? String(input.subject) : `Task ${taskId}`,
      description: input.description ? String(input.description) : undefined,
      status: 'pending',
      createdAt: timestamp,
      updatedAt: timestamp,
      blockedBy: [],
      blocks: [],
      associatedToolCalls: []
    };
    taskState.tasks.set(taskId, task);
  }

  // Update task fields
  if (input.status) {
    const newStatus = input.status as TaskStatus;
    const oldStatus = task.status;
    task.status = newStatus;

    // Track active task transitions
    if (newStatus === 'in_progress' && oldStatus !== 'in_progress') {
      taskState.activeTaskId = taskId;
    } else if (oldStatus === 'in_progress' && newStatus !== 'in_progress') {
      if (taskState.activeTaskId === taskId) {
        taskState.activeTaskId = null;
      }
    }
  }
  if (input.subject) task.subject = String(input.subject);
  if (input.description) task.description = String(input.description);
  if (input.activeForm) task.activeForm = String(input.activeForm);

  if (Array.isArray(input.addBlockedBy)) {
    for (const id of input.addBlockedBy) {
      const idStr = String(id);
      if (!task.blockedBy.includes(idStr)) {
        task.blockedBy.push(idStr);
      }
    }
  }
  if (Array.isArray(input.addBlocks)) {
    for (const id of input.addBlocks) {
      const idStr = String(id);
      if (!task.blocks.includes(idStr)) {
        task.blocks.push(idStr);
      }
    }
  }

  task.updatedAt = timestamp;
}

/**
 * Extracts agent type and description from a Task tool call input.
 *
 * @param input - Task tool input parameters
 * @returns Object with agentType and description if found
 */
export function extractTaskInfo(input: Record<string, unknown>): {
  agentType?: string;
  description?: string;
} {
  return {
    agentType: input.subagent_type ? String(input.subagent_type) : undefined,
    description: input.description ? String(input.description) : undefined
  };
}
