/**
 * Pure extraction of ToolCall objects from a SessionEvent.
 *
 * Provides a standalone function to extract tool calls from assistant
 * message content blocks without requiring an EventAggregator instance.
 *
 * @module extractors/toolCall
 */

import type { SessionEvent, ToolCall } from '../types/sessionEvent';
import { categorizeError, extractErrorMessage } from './errorTaxonomy';

function outputString(value: unknown): string | undefined {
  if (value == null) return undefined;
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return text.length > 5000 ? `${text.slice(0, 5000)}\n...(truncated)` : text;
}

/**
 * Extracts ToolCall objects from a SessionEvent.
 *
 * Scans the message content blocks for `tool_use` entries and
 * returns them as normalized ToolCall objects.
 *
 * @param event - A parsed session event
 * @returns Array of ToolCall objects (empty if none found)
 *
 * @example
 * ```typescript
 * const calls = extractToolCalls(event);
 * for (const call of calls) {
 *   console.log(`${call.name}: ${JSON.stringify(call.input)}`);
 * }
 * ```
 */
export function extractToolCalls(event: SessionEvent): ToolCall[] {
  // Tool calls live in assistant message content blocks
  if (event.type !== 'assistant') return [];

  const content = event.message?.content;
  if (!Array.isArray(content)) return [];

  const timestamp = new Date(event.timestamp);
  const calls: ToolCall[] = [];

  for (const block of content) {
    if (block && typeof block === 'object' && 'type' in block && block.type === 'tool_use') {
      const toolBlock = block as {
        id?: string;
        name?: string;
        input?: Record<string, unknown>;
        is_error?: boolean;
        error?: unknown;
        output?: unknown;
      };

      if (toolBlock.name) {
        const isError = toolBlock.is_error === true || toolBlock.error != null;
        const errorOutput = toolBlock.error ?? toolBlock.output;
        calls.push({
          name: toolBlock.name,
          input: toolBlock.input ?? {},
          timestamp,
          toolUseId: toolBlock.id,
          ...(isError
            ? {
                isError: true,
                output: outputString(errorOutput),
                errorMessage: extractErrorMessage(errorOutput, toolBlock.name),
                errorCategory: categorizeError(errorOutput),
              }
            : {}),
        });
      }
    }
  }

  return calls;
}

/**
 * Stateful shared extractor that correlates provider-normalized tool uses with
 * their later results. Completed calls always carry the canonical taxonomy.
 */
export class ToolCallTracker {
  private readonly pending = new Map<string, ToolCall>();

  process(event: SessionEvent): ToolCall[] {
    const completed: ToolCall[] = [];
    for (const call of extractToolCalls(event)) {
      if (call.toolUseId) this.pending.set(call.toolUseId, call);
      else completed.push(call);
    }

    const topLevel = extractToolCall(event);
    if (topLevel) {
      const id = event.message.id;
      if (id) {
        topLevel.toolUseId = id;
        this.pending.set(id, topLevel);
      } else {
        completed.push(topLevel);
      }
    }

    const content = event.message.content;
    if (!Array.isArray(content)) return completed;
    for (const block of content) {
      if (
        !block ||
        typeof block !== 'object' ||
        !('type' in block) ||
        block.type !== 'tool_result'
      ) {
        continue;
      }
      const result = block as {
        tool_use_id?: string;
        content?: unknown;
        is_error?: boolean;
        duration?: number;
      };
      if (!result.tool_use_id) continue;
      const call = this.pending.get(result.tool_use_id);
      if (!call) continue;
      this.pending.delete(result.tool_use_id);
      call.duration =
        typeof result.duration === 'number'
          ? result.duration
          : Math.max(0, new Date(event.timestamp).getTime() - call.timestamp.getTime());
      call.isError = result.is_error === true;
      call.output = outputString(result.content);
      if (call.isError) {
        call.errorMessage = extractErrorMessage(result.content, call.name);
        call.errorCategory = categorizeError(result.content);
      }
      completed.push(call);
    }
    return completed;
  }

  reset(): void {
    this.pending.clear();
  }
}

/**
 * Extracts a single top-level `tool_use` event.
 *
 * This complements `extractToolCalls`, which scans assistant message content
 * blocks. Some providers normalize tool calls as their own event with
 * `event.type === 'tool_use'` and `event.tool` populated.
 */
export function extractToolCall(event: SessionEvent): ToolCall | null {
  if (event.type !== 'tool_use' || !event.tool?.name) return null;

  return {
    name: event.tool.name,
    input: event.tool.input ?? {},
    timestamp: new Date(event.timestamp),
  };
}
