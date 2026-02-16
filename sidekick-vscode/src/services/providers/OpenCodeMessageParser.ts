/**
 * @fileoverview Converts OpenCode message + parts into ClaudeSessionEvent format.
 *
 * OpenCode stores messages and their parts as separate JSON files.
 * This module converts them to the ClaudeSessionEvent format used by
 * SessionMonitor, enabling all existing event processing logic to work
 * unchanged with OpenCode sessions.
 *
 * @module services/providers/OpenCodeMessageParser
 */

import type { ClaudeSessionEvent } from '../../types/claudeSession';
import type { OpenCodeMessage, OpenCodePart, DbMessage, DbPart } from '../../types/opencode';

/**
 * OpenCode → Claude Code tool name mapping.
 * OpenCode uses lowercase names; downstream code expects PascalCase.
 */
const TOOL_NAME_MAP: Record<string, string> = {
  read: 'Read',
  write: 'Write',
  edit: 'Edit',
  multiedit: 'MultiEdit',
  bash: 'Bash',
  glob: 'Glob',
  grep: 'Grep',
  webfetch: 'WebFetch',
  websearch: 'WebSearch',
  task: 'Task',
  todowrite: 'TodoWrite',
  todoread: 'TodoRead',
  apply_patch: 'ApplyPatch',
  list: 'List',
  lsp: 'Lsp',
  question: 'AskUserQuestion',
  skill: 'Skill',
  plan_enter: 'EnterPlanMode',
  plan_exit: 'ExitPlanMode',
};

/**
 * Normalizes an OpenCode tool name to PascalCase.
 *
 * Uses the known mapping table for common tools, and falls back to
 * capitalizing the first letter for unknown names.
 */
export function normalizeToolName(name: string): string {
  if (!name) return name;
  // Check mapping (case-insensitive lookup via lowercase key)
  const mapped = TOOL_NAME_MAP[name.toLowerCase()];
  if (mapped) return mapped;
  // Already PascalCase (starts with uppercase)? Pass through.
  if (name[0] >= 'A' && name[0] <= 'Z') return name;
  // Fallback: capitalize first letter
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/**
 * Normalizes tool input fields for downstream compatibility.
 *
 * OpenCode uses camelCase field names (e.g. `filePath`); downstream code
 * (MindMapDataService, SessionMonitor) expects snake_case (e.g. `file_path`).
 * This adds snake_case aliases without removing the originals.
 */
export function normalizeToolInput(input: Record<string, unknown>): Record<string, unknown> {
  const result = { ...input };
  // filePath → file_path (used by MindMapDataService.extractFiles, SessionMonitor.extractToolContext)
  if ('filePath' in result && !('file_path' in result)) {
    result.file_path = result.filePath;
  }
  // oldString → old_string (used by lineChangeCalculator, TempFilesTreeProvider, ToolInspectorProvider)
  if ('oldString' in result && !('old_string' in result)) {
    result.old_string = result.oldString;
  }
  // newString → new_string (used by lineChangeCalculator, TempFilesTreeProvider, ToolInspectorProvider)
  if ('newString' in result && !('new_string' in result)) {
    result.new_string = result.newString;
  }
  // replaceAll → replace_all (used by ToolInspectorProvider)
  if ('replaceAll' in result && !('replace_all' in result)) {
    result.replace_all = result.replaceAll;
  }
  return result;
}

/**
 * Converts a timestamp value (ISO string or Unix ms) to ISO string.
 */
function toISOString(time: string | number | undefined): string {
  if (!time) return new Date().toISOString();
  if (typeof time === 'string') return time;
  return new Date(time).toISOString();
}

/**
 * Converts an OpenCode message and its parts into ClaudeSessionEvent array.
 *
 * Maps OpenCode's message/part model to the flat event stream that
 * SessionMonitor expects. A single OpenCode message may produce multiple
 * events (assistant message, tool results, compaction markers).
 *
 * @param message - OpenCode MessageV2 object
 * @param parts - Array of OpenCode parts belonging to this message
 * @returns Array of ClaudeSessionEvent objects
 */
export function convertOpenCodeMessage(
  message: OpenCodeMessage,
  parts: OpenCodePart[]
): ClaudeSessionEvent[] {
  const events: ClaudeSessionEvent[] = [];

  // Sort parts by index if available
  const sortedParts = [...parts].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));

  if (message.role === 'user') {
    events.push(...convertUserMessage(message, sortedParts));
  } else if (message.role === 'assistant') {
    events.push(...convertAssistantMessage(message, sortedParts));
  }

  return events;
}

/**
 * Converts a user-role message to events.
 */
function convertUserMessage(
  message: OpenCodeMessage,
  parts: OpenCodePart[]
): ClaudeSessionEvent[] {
  const events: ClaudeSessionEvent[] = [];
  const content: unknown[] = [];

  for (const part of parts) {
    if (part.type === 'text') {
      content.push({ type: 'text', text: part.text });
    } else if (part.type === 'file') {
      content.push({ type: 'text', text: `[File: ${part.filename || 'unknown'} (${part.mime || 'unknown'})]` });
    } else if (part.type === 'subtask') {
      content.push({ type: 'text', text: `[Subtask: ${part.description || 'unknown'}]` });
    }
  }

  if (content.length > 0) {
    events.push({
      type: 'user',
      message: { role: 'user', id: message.id, content },
      timestamp: toISOString(message.time.created)
    });
  }

  return events;
}

/**
 * Converts an assistant-role message to events.
 *
 * Produces:
 * 1. An assistant event with text, thinking, and tool_use content blocks
 * 2. Synthetic user events for completed tool results
 * 3. A summary event if compaction was detected
 */
function convertAssistantMessage(
  message: OpenCodeMessage,
  parts: OpenCodePart[]
): ClaudeSessionEvent[] {
  const events: ClaudeSessionEvent[] = [];
  const content: unknown[] = [];

  for (const part of parts) {
    switch (part.type) {
      case 'text':
        content.push({ type: 'text', text: part.text });
        break;

      case 'reasoning':
        content.push({ type: 'thinking', thinking: part.text });
        break;

      case 'tool-invocation':
        content.push({
          type: 'tool_use',
          id: part.callID,
          name: normalizeToolName(part.tool),
          input: normalizeToolInput(part.state.input || {})
        });
        break;

      case 'tool':
        content.push({
          type: 'tool_use',
          id: part.callID,
          name: normalizeToolName(part.tool),
          input: normalizeToolInput(part.state.input || {})
        });
        break;

      case 'patch':
        // Emit per-file synthetic Write tool_use blocks so downstream code
        // (TempFilesTreeProvider, MindMapDataService) picks up file touches
        // via the standard file_path field extraction.
        if (part.files && part.files.length > 0) {
          for (let i = 0; i < part.files.length; i++) {
            content.push({
              type: 'tool_use',
              id: `patch-${part.id}-${i}`,
              name: 'Write',
              input: { file_path: part.files[i] }
            });
          }
        } else {
          content.push({
            type: 'tool_use',
            id: `patch-${part.id}`,
            name: 'Patch',
            input: { hash: part.hash, files: part.files }
          });
        }
        break;

      case 'step-start':
      case 'step-finish':
        // Timeline markers — no content to emit
        break;

      case 'subtask':
        content.push({
          type: 'tool_use',
          id: `subtask-${part.id}`,
          name: 'Subtask',
          input: {
            description: part.description,
            agent: part.agent,
            model: part.model,
            prompt: part.prompt,
            command: part.command,
          }
        });
        break;

      case 'file':
        content.push({
          type: 'text',
          text: `[File: ${part.filename || 'unknown'} (${part.mime || 'unknown'})]`
        });
        break;

      case 'retry':
        content.push({
          type: 'text',
          text: `[Retry attempt ${part.attempt ?? '?'}: ${part.error?.message || 'unknown error'}]`
        });
        break;

      case 'agent':
      case 'snapshot':
        // Metadata only — no user-visible content
        break;

      case 'compaction':
        // Will add summary event below
        break;
    }
  }

  // Surface message-level errors as text blocks so they appear in the timeline.
  // OpenCode messages can carry structured errors (AuthError, APIError, etc.)
  if (message.error) {
    const errType = message.error.type || 'Error';
    const errMsg = message.error.message || 'Unknown error';
    const errCode = message.error.code ? ` (code: ${message.error.code})` : '';
    content.push({
      type: 'text',
      text: `[${errType}]${errCode} ${errMsg}`
    });
  }

  // Sum cost from step-finish parts as fallback for reported_cost
  // when the message-level cost is unavailable. Step-finish parts carry
  // per-step cost from the provider which can improve accuracy.
  let stepFinishCost = 0;
  for (const part of parts) {
    if (part.type === 'step-finish' && part.cost && part.cost > 0) {
      stepFinishCost += part.cost;
    }
  }

  // Build usage data from message tokens
  const reportedCost = (message.cost && message.cost > 0)
    ? message.cost
    : (stepFinishCost > 0 ? stepFinishCost : undefined);

  const usage = {
    input_tokens: message.tokens.input || 0,
    output_tokens: message.tokens.output || 0,
    cache_creation_input_tokens: message.tokens.cacheWrite || 0,
    cache_read_input_tokens: message.tokens.cacheRead || 0,
    reported_cost: reportedCost,
    reasoning_tokens: message.tokens.reasoning || 0,
  };

  const timestamp = toISOString(message.time.completed || message.time.created);

  // Emit assistant event (even if content is empty, usage data is valuable)
  if (content.length > 0 || message.tokens.input > 0 || message.tokens.output > 0) {
    events.push({
      type: 'assistant',
      message: {
        role: 'assistant',
        id: message.id,
        model: message.modelID,
        usage,
        content
      },
      timestamp
    });
  }

  // Emit synthetic tool_result events for completed tool invocations
  // and subtask parts. In Claude Code's format, tool results come as
  // user messages with tool_result content blocks.
  for (const part of parts) {
    if ((part.type === 'tool-invocation' || part.type === 'tool') &&
        (part.state.status === 'completed' || part.state.status === 'error')) {

      // Calculate duration from provider-supplied timestamps when available
      let duration: number | undefined;
      if (part.state.time?.start && part.state.time?.end) {
        const startMs = typeof part.state.time.start === 'number'
          ? part.state.time.start
          : new Date(part.state.time.start).getTime();
        const endMs = typeof part.state.time.end === 'number'
          ? part.state.time.end
          : new Date(part.state.time.end).getTime();
        if (endMs > startMs) {
          duration = endMs - startMs;
        }
      }

      const resultContent: unknown[] = [{
        type: 'tool_result',
        tool_use_id: part.callID,
        content: part.state.status === 'error' ? part.state.error : part.state.output,
        is_error: part.state.status === 'error',
        ...(duration !== undefined && { duration }),
      }];

      const resultTimestamp = part.state.time?.end
        ? toISOString(part.state.time.end)
        : timestamp;

      events.push({
        type: 'user',
        message: { role: 'user', id: `${message.id}:${part.callID}:result`, content: resultContent },
        timestamp: resultTimestamp
      });
    }

    // Subtask parts get a synthetic tool_result so they appear in the timeline
    if (part.type === 'subtask') {
      events.push({
        type: 'user',
        message: {
          role: 'user',
          id: `${message.id}:subtask-${part.id}:result`,
          content: [{
            type: 'tool_result',
            tool_use_id: `subtask-${part.id}`,
            content: part.description || 'Subtask completed',
            is_error: false
          }]
        },
        timestamp
      });
    }
  }

  // Detect compaction via summary flag or compaction part
  const hasCompaction = message.summary || parts.some(p => p.type === 'compaction');
  if (hasCompaction) {
    events.push({
      type: 'summary',
      message: { role: 'assistant', id: `${message.id}:summary`, content: 'Context compacted' },
      timestamp
    });
  }

  return events;
}

// --- DB-to-OpenCode adapter functions ---

/**
 * Parses a database message row's JSON `data` field into an OpenCodeMessage.
 *
 * DB messages store data as a JSON blob with slightly different field layout
 * than the file-based format (e.g., `modelID` is at top level, tokens are
 * nested under `tokens`).
 */
export function parseDbMessageData(row: DbMessage): OpenCodeMessage {
  const data = JSON.parse(row.data) as Record<string, unknown>;
  const time = data.time as Record<string, unknown> | undefined;
  const tokens = data.tokens as Record<string, unknown> | undefined;
  const cache = tokens?.cache as Record<string, unknown> | undefined;
  const summary = data.summary as Record<string, unknown> | undefined;

  // Parse error field if present (AuthError, APIError, OutputLengthError, etc.)
  const errorData = data.error as Record<string, unknown> | undefined;
  const error = errorData ? {
    type: (errorData.type as string) || undefined,
    message: (errorData.message as string) || undefined,
    code: errorData.code as string | number | undefined,
  } : undefined;

  return {
    id: row.id,
    sessionID: row.session_id,
    role: (data.role as string) as 'user' | 'assistant' | 'system',
    modelID: data.modelID as string | undefined,
    summary: summary != null ? true : undefined,
    cost: (data.cost as number) || undefined,
    providerID: (data.providerID as string) || undefined,
    tokens: {
      input: (tokens?.input as number) || 0,
      output: (tokens?.output as number) || 0,
      cacheRead: (cache?.read as number) || 0,
      cacheWrite: (cache?.write as number) || 0,
      reasoning: (tokens?.reasoning as number) || 0,
    },
    time: {
      created: (time?.created as number) || row.time_created,
      completed: (time?.completed as number) || undefined,
    },
    error,
  };
}

/**
 * Parses a database part row's JSON `data` field into an OpenCodePart.
 */
export function parseDbPartData(row: DbPart): OpenCodePart {
  const data = JSON.parse(row.data) as Record<string, unknown>;
  const type = data.type as string;
  const base = { id: row.id, messageID: row.message_id };

  switch (type) {
    case 'text':
      return { ...base, type: 'text', text: (data.text as string) || '' };

    case 'reasoning':
      return { ...base, type: 'reasoning', text: (data.text as string) || '' };

    case 'tool': {
      const state = data.state as Record<string, unknown> | undefined;
      return {
        ...base,
        type: 'tool',
        callID: (data.callID as string) || '',
        tool: (data.tool as string) || '',
        state: {
          status: ((state?.status as string) || 'completed') as 'pending' | 'running' | 'completed' | 'error',
          input: state?.input as Record<string, unknown> | undefined,
          output: state?.output as string | undefined,
          error: state?.error as string | undefined,
          title: state?.title as string | undefined,
          metadata: state?.metadata as Record<string, unknown> | undefined,
          time: state?.time as { start?: string | number; end?: string | number; compacted?: string | number } | undefined,
        },
      };
    }

    case 'tool-invocation': {
      const state = data.state as Record<string, unknown> | undefined;
      return {
        ...base,
        type: 'tool-invocation',
        callID: (data.callID as string) || '',
        tool: (data.tool as string) || '',
        state: {
          status: ((state?.status as string) || 'completed') as 'pending' | 'running' | 'completed' | 'error',
          input: state?.input as Record<string, unknown> | undefined,
          output: state?.output as string | undefined,
          error: state?.error as string | undefined,
          time: state?.time as { start?: string | number; end?: string | number } | undefined,
        },
      };
    }

    case 'compaction':
      return { ...base, type: 'compaction', text: data.text as string | undefined };

    case 'step-start':
      return { ...base, type: 'step-start', snapshot: data.snapshot as string | undefined };

    case 'step-finish': {
      const tokensData = data.tokens as Record<string, unknown> | undefined;
      const cacheData = tokensData?.cache as Record<string, unknown> | undefined;
      return {
        ...base,
        type: 'step-finish',
        reason: data.reason as string | undefined,
        snapshot: data.snapshot as string | undefined,
        cost: data.cost as number | undefined,
        tokens: tokensData ? {
          input: tokensData.input as number | undefined,
          output: tokensData.output as number | undefined,
          reasoning: tokensData.reasoning as number | undefined,
          cache: cacheData ? {
            read: cacheData.read as number | undefined,
            write: cacheData.write as number | undefined,
          } : undefined,
        } : undefined,
      };
    }

    case 'patch':
      return {
        ...base,
        type: 'patch',
        hash: data.hash as string | undefined,
        files: data.files as string[] | undefined,
      };

    case 'subtask':
      return {
        ...base,
        type: 'subtask',
        prompt: data.prompt as string | undefined,
        description: data.description as string | undefined,
        agent: data.agent as string | undefined,
        model: data.model as string | undefined,
        command: data.command as string | undefined,
      };

    case 'agent':
      return {
        ...base,
        type: 'agent',
        name: data.name as string | undefined,
        source: data.source as string | undefined,
      };

    case 'file':
      return {
        ...base,
        type: 'file',
        mime: data.mime as string | undefined,
        filename: data.filename as string | undefined,
        url: data.url as string | undefined,
      };

    case 'retry': {
      const errorData = data.error as Record<string, unknown> | undefined;
      return {
        ...base,
        type: 'retry',
        attempt: data.attempt as number | undefined,
        error: errorData ? {
          message: errorData.message as string | undefined,
          code: errorData.code as string | undefined,
        } : undefined,
        time: data.time as string | number | undefined,
      };
    }

    case 'snapshot':
      return {
        ...base,
        type: 'snapshot',
        snapshot: data.snapshot as string | undefined,
      };

    default:
      // Unknown part type — treat as text with raw JSON
      return { ...base, type: 'text', text: JSON.stringify(data) };
  }
}
