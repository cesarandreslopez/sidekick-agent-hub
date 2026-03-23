/**
 * Pure extraction of ToolCall objects from a SessionEvent.
 *
 * Provides a standalone function to extract tool calls from assistant
 * message content blocks without requiring an EventAggregator instance.
 *
 * @module extractors/toolCall
 */

import type { SessionEvent, ToolCall } from '../types/sessionEvent';

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
    if (
      block &&
      typeof block === 'object' &&
      'type' in block &&
      block.type === 'tool_use'
    ) {
      const toolBlock = block as {
        id?: string;
        name?: string;
        input?: Record<string, unknown>;
      };

      if (toolBlock.name) {
        calls.push({
          name: toolBlock.name,
          input: toolBlock.input ?? {},
          timestamp,
          toolUseId: toolBlock.id,
        });
      }
    }
  }

  return calls;
}
