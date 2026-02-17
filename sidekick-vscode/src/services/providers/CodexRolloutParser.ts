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
  CodexContentPart,
  CodexTokenUsage,
  CodexTokenCountEvent,
  CodexAgentMessageEvent,
  CodexUserMessageEvent,
  CodexExecCommandBeginEvent,
  CodexExecCommandEndEvent,
  CodexMcpToolCallBeginEvent,
  CodexMcpToolCallEndEvent,
  CodexErrorEvent,
  CodexContextCompactedEvent,
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
  return normalizeToolName(name);
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

    return [{
      type: 'assistant',
      message: {
        role: 'assistant',
        id: item.id,
        model: this.currentModel || undefined,
        content: [{
          type: 'tool_use',
          id: item.call_id,
          name: normalizeCodexToolName(item.name),
          input: parsedArgs,
        }],
      },
      timestamp,
    }];
  }

  private handleFunctionCallOutput(timestamp: string, item: CodexFunctionCallOutputItem): ClaudeSessionEvent[] {
    return [{
      type: 'user',
      message: {
        role: 'user',
        id: `${item.call_id}:result`,
        content: [{
          type: 'tool_result',
          tool_use_id: item.call_id,
          content: item.output,
          is_error: false,
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
          input: { command, workdir: item.action?.workdir },
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
        // Usage data is nested under info.last_token_usage (info can be null)
        const usage = e.info?.last_token_usage || e.info?.total_token_usage;
        return this.handleTokenCount(timestamp, usage ?? null);
      }

      case 'agent_message': {
        const e = event as CodexAgentMessageEvent;
        return [{
          type: 'assistant',
          message: {
            role: 'assistant',
            id: `agent-msg-${timestamp}`,
            model: this.currentModel || undefined,
            content: [{ type: 'text', text: e.message }],
          },
          timestamp,
        }];
      }

      case 'user_message': {
        const e = event as CodexUserMessageEvent;
        return [{
          type: 'user',
          message: {
            role: 'user',
            id: `user-msg-${timestamp}`,
            content: [{ type: 'text', text: e.message }],
          },
          timestamp,
        }];
      }

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
              input: { command, workdir: pending?.workdir },
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
              input: pendingMcp?.arguments || {},
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

      case 'turn_started':
      case 'turn_complete':
      case 'task_started':
      case 'task_complete':
      case 'turn_aborted':
      case 'agent_reasoning':
      case 'patch_applied':
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
