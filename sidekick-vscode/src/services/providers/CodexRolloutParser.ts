/**
 * @fileoverview Stateful parser converting Codex rollout lines to ClaudeSessionEvent[].
 *
 * Unlike OpenCode's stateless converter, this is stateful because:
 * - exec_command_begin/end and mcp_tool_call_begin/end need pairing by call_id
 * - turn_context sets the current model for subsequent events
 * - token_count provides cumulative usage that needs delta computation
 *
 * @module services/providers/CodexRolloutParser
 */

import type { ClaudeSessionEvent, MessageUsage } from '../../types/claudeSession';
import type {
  CodexRolloutLine,
  CodexSessionMeta,
  CodexResponseItem,
  CodexCompacted,
  CodexTurnContext,
  CodexEventMsg,
  CodexMessageItem,
  CodexReasoningItem,
  CodexFunctionCallItem,
  CodexFunctionCallOutputItem,
  CodexLocalShellCallItem,
  CodexCustomToolCallItem,
  CodexCustomToolCallOutputItem,
  CodexContentPart,
  CodexTokenUsage,
  CodexRateLimits,
  CodexTokenCountEvent,
  CodexExecCommandBeginEvent,
  CodexExecCommandEndEvent,
  CodexMcpToolCallBeginEvent,
  CodexMcpToolCallEndEvent,
  CodexErrorEvent,
  CodexContextCompactedEvent,
  CodexPatchAppliedEvent,
} from '../../types/codex';
import { normalizeToolName } from './OpenCodeMessageParser';

/** Pending exec command awaiting its end event. */
interface PendingExecCommand {
  call_id: string;
  command: string[];
  workdir?: string;
  timestamp: string;
}

/** Pending MCP tool call awaiting its end event. */
interface PendingMcpToolCall {
  call_id: string;
  server_name?: string;
  tool_name: string;
  arguments?: Record<string, unknown>;
  timestamp: string;
}

/**
 * Codex-specific tool name normalization.
 * Extends the shared normalizeToolName with Codex-specific mappings.
 */
function normalizeCodexToolName(name: string): string {
  if (!name) return name;
  const lower = name.toLowerCase();
  if (lower === 'local_shell' || lower === 'local_shell_call') return 'Bash';
  if (lower === 'exec_command') return 'Bash';
  if (lower === 'write_stdin') return 'Bash';
  if (lower === 'request_user_input') return 'AskUserQuestion';
  if (lower === 'update_plan') return 'UpdatePlan';
  if (lower === 'web_search') return 'WebSearch';
  return normalizeToolName(name);
}

/**
 * Normalizes Codex tool input fields for downstream monitor compatibility.
 */
function normalizeCodexToolInput(
  canonicalToolName: string,
  rawToolName: string,
  input: Record<string, unknown>
): Record<string, unknown> {
  const normalized = { ...input };
  normalized._sidekickRawToolName = rawToolName;

  // Codex exec_command uses cmd; monitor expects command for Bash context extraction.
  if (canonicalToolName === 'Bash' && typeof normalized.cmd === 'string' && normalized.command === undefined) {
    normalized.command = normalized.cmd;
  }

  // request_user_input currently emits questions; keep as-is (compatible with AskUserQuestion extractor).
  return normalized;
}

function parsePlainTextFailure(output: string): boolean {
  if (!output) return false;
  const exitCodeMatch = /Process exited with code\s+(-?\d+)/i.exec(output);
  if (exitCodeMatch) {
    return Number(exitCodeMatch[1]) !== 0;
  }

  return /(Permission denied|No such file|not found|SyntaxError|failed|error:)/i.test(output);
}

/**
 * Extracts plain text from Codex message content.
 */
function extractTextFromContent(content: CodexContentPart[] | string): string {
  if (typeof content === 'string') return content;
  const texts: string[] = [];
  for (const part of content) {
    if (part.text) texts.push(part.text);
  }
  return texts.join('\n');
}

/**
 * Extracts file paths from an apply_patch input string.
 * Matches lines like: `*** Add File: src/math.ts` or `*** Update File: src/index.ts`
 */
export function extractPatchFilePaths(input: string): string[] {
  const paths: string[] = [];
  const re = /\*\*\* (?:Add|Update|Delete) File: (.+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(input)) !== null) {
    paths.push(m[1].trim());
  }
  return paths;
}

/**
 * Stateful parser for Codex JSONL rollout lines.
 *
 * Maintains internal state for:
 * - Session metadata (from session_meta)
 * - Current model (from turn_context)
 * - Pending exec commands and MCP tool calls (begin/end pairing)
 * - Previous token counts (for delta computation)
 */
export class CodexRolloutParser {
  private sessionMeta: CodexSessionMeta | null = null;
  private currentModel: string | null = null;
  private pendingExecCommands = new Map<string, PendingExecCommand>();
  private pendingMcpToolCalls = new Map<string, PendingMcpToolCall>();
  private lastTokenUsage: CodexTokenUsage | null = null;
  private modelContextWindow: number | null = null;
  private lastRateLimits: CodexRateLimits | null = null;
  private inPlanMode = false;

  /** Get stored session metadata. */
  getSessionMeta(): CodexSessionMeta | null {
    return this.sessionMeta;
  }

  /** Get current model from turn_context. */
  getCurrentModel(): string | null {
    return this.currentModel;
  }

  /** Get the last observed token usage snapshot. */
  getLastTokenUsage(): CodexTokenUsage | null {
    return this.lastTokenUsage;
  }

  /** Get the model context window size from token_count events. */
  getModelContextWindow(): number | null {
    return this.modelContextWindow;
  }

  /** Get the last observed rate limits from token_count events. */
  getLastRateLimits(): CodexRateLimits | null {
    return this.lastRateLimits;
  }

  /**
   * Converts a single rollout line to zero or more session events.
   */
  convertLine(line: CodexRolloutLine): ClaudeSessionEvent[] {
    switch (line.type) {
      case 'session_meta':
        return this.handleSessionMeta(line.payload as CodexSessionMeta);
      case 'response_item':
        return this.handleResponseItem(line.timestamp, line.payload as CodexResponseItem);
      case 'compacted':
        return this.handleCompacted(line.timestamp, line.payload as CodexCompacted);
      case 'turn_context':
        return this.handleTurnContext(line.payload as CodexTurnContext);
      case 'event_msg':
        return this.handleEventMsg(line.timestamp, line.payload as CodexEventMsg);
      default:
        return [];
    }
  }

  /** Reset all parser state. */
  reset(): void {
    this.sessionMeta = null;
    this.currentModel = null;
    this.pendingExecCommands.clear();
    this.pendingMcpToolCalls.clear();
    this.lastTokenUsage = null;
    this.modelContextWindow = null;
    this.lastRateLimits = null;
    this.inPlanMode = false;
  }

  // --- Handlers ---

  private handleSessionMeta(payload: CodexSessionMeta): ClaudeSessionEvent[] {
    this.sessionMeta = payload;
    return [];
  }

  private handleResponseItem(timestamp: string, payload: CodexResponseItem): ClaudeSessionEvent[] {
    // payload IS the item directly (no .item wrapper)
    if (!payload || !payload.type) return [];

    switch (payload.type) {
      case 'message':
        return this.handleMessage(timestamp, payload as CodexMessageItem);
      case 'reasoning':
        return this.handleReasoning(timestamp, payload as CodexReasoningItem);
      case 'function_call':
        return this.handleFunctionCall(timestamp, payload as CodexFunctionCallItem);
      case 'function_call_output':
        return this.handleFunctionCallOutput(timestamp, payload as CodexFunctionCallOutputItem);
      case 'local_shell_call':
        return this.handleLocalShellCall(timestamp, payload as CodexLocalShellCallItem);
      case 'custom_tool_call':
        return this.handleCustomToolCall(timestamp, payload as CodexCustomToolCallItem);
      case 'custom_tool_call_output':
        return this.handleCustomToolCallOutput(timestamp, payload as CodexCustomToolCallOutputItem);
      default:
        return [];
    }
  }

  private handleMessage(timestamp: string, item: CodexMessageItem): ClaudeSessionEvent[] {
    const text = extractTextFromContent(item.content);
    if (!text) return [];

    if (item.role === 'user') {
      return [{
        type: 'user',
        message: {
          role: 'user',
          id: item.id,
          content: [{ type: 'text', text }],
        },
        timestamp,
      }];
    }

    if (item.role === 'assistant') {
      return [{
        type: 'assistant',
        message: {
          role: 'assistant',
          id: item.id,
          model: this.currentModel || undefined,
          content: [{ type: 'text', text }],
        },
        timestamp,
      }];
    }

    return [];
  }

  private handleReasoning(timestamp: string, item: CodexReasoningItem): ClaudeSessionEvent[] {
    const summaryTexts = (item.summary || [])
      .filter(s => s.type === 'summary_text' && s.text)
      .map(s => s.text);

    if (summaryTexts.length === 0) return [];

    return [{
      type: 'assistant',
      message: {
        role: 'assistant',
        id: item.id,
        model: this.currentModel || undefined,
        content: [{ type: 'thinking', thinking: summaryTexts.join('\n') }],
      },
      timestamp,
    }];
  }

  private handleFunctionCall(timestamp: string, item: CodexFunctionCallItem): ClaudeSessionEvent[] {
    let parsedArgs: Record<string, unknown> = {};
    try {
      parsedArgs = JSON.parse(item.arguments);
    } catch {
      parsedArgs = { raw: item.arguments };
    }

    const canonicalName = normalizeCodexToolName(item.name);
    const normalizedInput = normalizeCodexToolInput(canonicalName, item.name, parsedArgs);

    return [{
      type: 'assistant',
      message: {
        role: 'assistant',
        id: item.id,
        model: this.currentModel || undefined,
        content: [{
          type: 'tool_use',
          id: item.call_id,
          name: canonicalName,
          input: normalizedInput,
        }],
      },
      timestamp,
    }];
  }

  private handleFunctionCallOutput(timestamp: string, item: CodexFunctionCallOutputItem): ClaudeSessionEvent[] {
    const isError = parsePlainTextFailure(item.output);
    return [{
      type: 'user',
      message: {
        role: 'user',
        id: `${item.call_id}:result`,
        content: [{
          type: 'tool_result',
          tool_use_id: item.call_id,
          content: item.output,
          is_error: isError,
        }],
      },
      timestamp,
    }];
  }

  private handleLocalShellCall(timestamp: string, item: CodexLocalShellCallItem): ClaudeSessionEvent[] {
    const command = item.action?.command?.join(' ') || '';
    return [{
      type: 'assistant',
      message: {
        role: 'assistant',
        id: item.id,
        model: this.currentModel || undefined,
        content: [{
          type: 'tool_use',
          id: item.call_id,
          name: 'Bash',
          input: {
            command,
            workdir: item.action?.workdir,
            _sidekickRawToolName: 'local_shell_call',
          },
        }],
      },
      timestamp,
    }];
  }

  private handleCustomToolCall(timestamp: string, item: CodexCustomToolCallItem): ClaudeSessionEvent[] {
    if (item.name === 'apply_patch') {
      const filePaths = extractPatchFilePaths(item.input);
      if (filePaths.length === 0) return [];
      return filePaths.map(fp => ({
        type: 'assistant' as const,
        message: {
          role: 'assistant' as const,
          id: `${item.call_id}-${fp}`,
          model: this.currentModel || undefined,
          content: [{
            type: 'tool_use',
            id: `${item.call_id}-${fp}`,
            name: 'Edit',
            input: {
              file_path: fp,
              _sidekickRawToolName: 'apply_patch',
            },
          }],
        },
        timestamp,
      }));
    }

    // Generic custom tool
    let parsedInput: Record<string, unknown>;
    try {
      parsedInput = JSON.parse(item.input);
    } catch {
      parsedInput = { raw: item.input };
    }

    const canonicalName = normalizeCodexToolName(item.name);
    const normalizedInput = normalizeCodexToolInput(canonicalName, item.name, parsedInput);

    return [{
      type: 'assistant',
      message: {
        role: 'assistant',
        id: item.call_id,
        model: this.currentModel || undefined,
        content: [{
          type: 'tool_use',
          id: item.call_id,
          name: canonicalName,
          input: normalizedInput,
        }],
      },
      timestamp,
    }];
  }

  private handleCustomToolCallOutput(timestamp: string, item: CodexCustomToolCallOutputItem): ClaudeSessionEvent[] {
    let isError = false;
    let duration: number | undefined;
    try {
      const parsed = JSON.parse(item.output);
      isError = parsed?.metadata?.exit_code !== 0 && parsed?.metadata?.exit_code !== undefined;
      if (parsed?.metadata?.duration_seconds) {
        duration = Math.round(parsed.metadata.duration_seconds * 1000);
      }
    } catch {
      isError = parsePlainTextFailure(item.output);
    }

    return [{
      type: 'user',
      message: {
        role: 'user',
        id: `${item.call_id}:result`,
        content: [{
          type: 'tool_result',
          tool_use_id: item.call_id,
          content: item.output,
          is_error: isError,
          duration,
        }],
      },
      timestamp,
    }];
  }

  private handleCompacted(timestamp: string, payload: CodexCompacted): ClaudeSessionEvent[] {
    return [{
      type: 'summary',
      message: {
        role: 'assistant',
        id: `compacted-${timestamp}`,
        content: payload.summary || 'Context compacted',
      },
      timestamp,
    }];
  }

  private handleTurnContext(payload: CodexTurnContext): ClaudeSessionEvent[] {
    if (payload.model) {
      this.currentModel = payload.model;
    }
    return [];
  }

  private handleEventMsg(timestamp: string, event: CodexEventMsg): ClaudeSessionEvent[] {
    // payload IS the event directly (no .event wrapper)
    if (!event || !event.type) return [];

    switch (event.type) {
      case 'token_count': {
        const e = event as CodexTokenCountEvent;
        // Store model_context_window if provided (actual limit for current model)
        if (e.info?.model_context_window) {
          this.modelContextWindow = e.info.model_context_window;
        }
        // Store rate_limits if provided (subscription quota data)
        if (e.rate_limits) {
          this.lastRateLimits = e.rate_limits;
        }
        // Usage data is nested under info.last_token_usage (info can be null)
        const usage = e.info?.last_token_usage || e.info?.total_token_usage;
        return this.handleTokenCount(timestamp, usage ?? null);
      }

      // agent_message and user_message are suppressed — they duplicate
      // response_item/message events which carry richer metadata (id, content parts, role).

      case 'exec_command_begin': {
        const e = event as CodexExecCommandBeginEvent;
        this.pendingExecCommands.set(e.call_id, {
          call_id: e.call_id,
          command: e.command,
          workdir: e.workdir,
          timestamp,
        });
        return [];
      }

      case 'exec_command_end': {
        const e = event as CodexExecCommandEndEvent;
        const pending = this.pendingExecCommands.get(e.call_id);
        this.pendingExecCommands.delete(e.call_id);
        const command = pending?.command?.join(' ') || '';
        const events: ClaudeSessionEvent[] = [];

        events.push({
          type: 'assistant',
          message: {
            role: 'assistant',
            id: `exec-${e.call_id}`,
            model: this.currentModel || undefined,
            content: [{
              type: 'tool_use',
              id: e.call_id,
              name: 'Bash',
              input: {
                command,
                workdir: pending?.workdir,
                _sidekickRawToolName: 'exec_command',
              },
            }],
          },
          timestamp: pending?.timestamp || timestamp,
        });

        const output = [e.stdout, e.stderr].filter(Boolean).join('\n') || '';
        events.push({
          type: 'user',
          message: {
            role: 'user',
            id: `exec-${e.call_id}:result`,
            content: [{
              type: 'tool_result',
              tool_use_id: e.call_id,
              content: output,
              is_error: e.exit_code !== 0,
              duration: e.duration_ms,
            }],
          },
          timestamp,
        });

        return events;
      }

      case 'mcp_tool_call_begin': {
        const e = event as CodexMcpToolCallBeginEvent;
        this.pendingMcpToolCalls.set(e.call_id, {
          call_id: e.call_id,
          server_name: e.server_name,
          tool_name: e.tool_name,
          arguments: e.arguments,
          timestamp,
        });
        return [];
      }

      case 'mcp_tool_call_end': {
        const e = event as CodexMcpToolCallEndEvent;
        const pendingMcp = this.pendingMcpToolCalls.get(e.call_id);
        this.pendingMcpToolCalls.delete(e.call_id);
        const toolName = pendingMcp?.tool_name || 'McpTool';
        const events: ClaudeSessionEvent[] = [];

        events.push({
          type: 'assistant',
          message: {
            role: 'assistant',
            id: `mcp-${e.call_id}`,
            model: this.currentModel || undefined,
            content: [{
              type: 'tool_use',
              id: e.call_id,
              name: normalizeCodexToolName(toolName),
              input: {
                ...(pendingMcp?.arguments || {}),
                _sidekickRawToolName: toolName,
              },
            }],
          },
          timestamp: pendingMcp?.timestamp || timestamp,
        });

        events.push({
          type: 'user',
          message: {
            role: 'user',
            id: `mcp-${e.call_id}:result`,
            content: [{
              type: 'tool_result',
              tool_use_id: e.call_id,
              content: e.result || '',
              is_error: e.is_error || false,
              duration: e.duration_ms,
            }],
          },
          timestamp,
        });

        return events;
      }

      case 'error': {
        const e = event as CodexErrorEvent;
        return [{
          type: 'assistant',
          message: {
            role: 'assistant',
            id: `error-${timestamp}`,
            model: this.currentModel || undefined,
            content: [{ type: 'text', text: `[Error${e.code ? ` (${e.code})` : ''}] ${e.message}` }],
          },
          timestamp,
        }];
      }

      case 'context_compacted': {
        const e = event as CodexContextCompactedEvent;
        return [{
          type: 'summary',
          message: {
            role: 'assistant',
            id: `ctx-compacted-${timestamp}`,
            content: e.summary || 'Context compacted',
          },
          timestamp,
        }];
      }

      case 'patch_applied': {
        const e = event as CodexPatchAppliedEvent;
        if (!e.file_path) return [];
        const patchId = `patch-${timestamp}-${e.file_path}`;
        return [{
          type: 'assistant',
          message: {
            role: 'assistant',
            id: patchId,
            model: this.currentModel || undefined,
            content: [{
              type: 'tool_use',
              id: patchId,
              name: 'Edit',
              input: {
                file_path: e.file_path,
                additions: e.additions ?? 0,
                deletions: e.deletions ?? 0,
                _sidekickRawToolName: 'patch_applied',
              },
            }],
          },
          timestamp,
        }];
      }

      case 'turn_started':
      case 'turn_complete':
      case 'task_started':
      {
        const collaborationMode = (event as CodexTaskStartedEvent).collaboration_mode_kind;
        if (collaborationMode !== 'plan' || this.inPlanMode) return [];
        this.inPlanMode = true;
        return [{
          type: 'assistant',
          message: {
            role: 'assistant',
            id: `plan-enter-${timestamp}`,
            model: this.currentModel || undefined,
            content: [{
              type: 'tool_use',
              id: `plan-enter-${timestamp}`,
              name: 'EnterPlanMode',
              input: {
                source: 'codex_task_started',
                _sidekickRawToolName: 'task_started',
              },
            }],
          },
          timestamp,
        }];
      }

      case 'task_complete':
        if (!this.inPlanMode) return [];
        this.inPlanMode = false;
        return [{
          type: 'assistant',
          message: {
            role: 'assistant',
            id: `plan-exit-${timestamp}`,
            model: this.currentModel || undefined,
            content: [{
              type: 'tool_use',
              id: `plan-exit-${timestamp}`,
              name: 'ExitPlanMode',
              input: {
                source: 'codex_task_complete',
                _sidekickRawToolName: 'task_complete',
              },
            }],
          },
          timestamp,
        }];

      case 'turn_aborted':
      case 'agent_reasoning':
      case 'agent_message':
      case 'user_message':
      case 'background':
        return [];

      default:
        return [];
    }
  }

  private handleTokenCount(timestamp: string, usage: CodexTokenUsage | null): ClaudeSessionEvent[] {
    if (!usage) return [];

    const mappedUsage: MessageUsage = {
      input_tokens: usage.input_tokens || 0,
      output_tokens: usage.output_tokens || 0,
      cache_read_input_tokens: usage.cached_input_tokens || 0,
      cache_creation_input_tokens: 0,
      reasoning_tokens: usage.reasoning_output_tokens || 0,
    };

    this.lastTokenUsage = usage;

    return [{
      type: 'assistant',
      message: {
        role: 'assistant',
        id: `token-count-${timestamp}`,
        model: this.currentModel || undefined,
        usage: mappedUsage,
        content: [],
      },
      timestamp,
    }];
  }
}
