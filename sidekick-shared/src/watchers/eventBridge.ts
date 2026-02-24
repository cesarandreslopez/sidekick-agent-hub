/**
 * Converts SessionEvent (rich canonical format) to FollowEvent (flat summary).
 *
 * This bridge enables the two-tier event system:
 *   Provider logs → Shared parsers → SessionEvent → toFollowEvents() → FollowEvent
 *
 * SessionEvent preserves full tool inputs, results, and message structure.
 * FollowEvent is a lossy summary for timeline display and CLI output.
 */

import type { SessionEvent } from '../types/sessionEvent';
import type { ProviderId } from '../providers/types';
import type { FollowEvent } from './types';

/**
 * Converts a single SessionEvent to one or more FollowEvents.
 *
 * A single SessionEvent (e.g. an assistant message with tool_use blocks)
 * may produce multiple FollowEvents (one per tool_use + one for text).
 */
export function toFollowEvents(event: SessionEvent, providerId: ProviderId): FollowEvent[] {
  const events: FollowEvent[] = [];
  const ts = event.timestamp || new Date().toISOString();
  const usage = event.message?.usage;
  const tokens = usage
    ? { input: usage.input_tokens || 0, output: usage.output_tokens || 0 }
    : undefined;
  const cacheTokens = usage && (usage.cache_read_input_tokens || usage.cache_creation_input_tokens)
    ? { read: usage.cache_read_input_tokens || 0, write: usage.cache_creation_input_tokens || 0 }
    : undefined;
  const cost = usage?.reported_cost;
  const model = event.message?.model;

  switch (event.type) {
    case 'user': {
      const content = event.message?.content;
      // Extract tool_result blocks from user messages
      if (Array.isArray(content)) {
        for (const block of content as Array<Record<string, unknown>>) {
          if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
            const resultText = typeof block.content === 'string'
              ? truncate(block.content, 120)
              : '';
            events.push({
              providerId, type: 'tool_result', timestamp: ts,
              summary: resultText || '(tool result)', raw: block,
            });
          }
        }
      }
      const text = extractTextContent(content);
      if (text || events.length === 0) {
        events.push({
          providerId, type: 'user', timestamp: ts,
          summary: text || '(user message)', model, raw: event,
        });
      }
      break;
    }

    case 'assistant': {
      const content = event.message?.content;
      // Extract tool_use blocks first
      if (Array.isArray(content)) {
        for (const block of content as Array<Record<string, unknown>>) {
          if (block.type === 'tool_use' && typeof block.name === 'string') {
            const input = block.input
              ? summarizeToolInput(block.input as Record<string, unknown>)
              : '';
            events.push({
              providerId, type: 'tool_use', timestamp: ts,
              summary: input ? `${block.name} ${input}` : block.name as string,
              toolName: block.name as string, toolInput: input, model, raw: block,
            });
          }
        }
      }
      // Emit assistant text (if any)
      const text = extractTextContent(content);
      if (text || events.length === 0) {
        events.push({
          providerId, type: 'assistant', timestamp: ts,
          summary: text || '(thinking...)', tokens, cacheTokens, cost, model, raw: event,
        });
      } else if (tokens) {
        // Attach tokens to the last tool_use event if no separate text
        const last = events[events.length - 1];
        last.tokens = tokens;
        last.cacheTokens = cacheTokens;
        last.cost = cost;
      }
      break;
    }

    case 'tool_use': {
      const name = event.tool?.name || 'unknown';
      const input = event.tool?.input
        ? summarizeToolInput(event.tool.input)
        : '';
      events.push({
        providerId, type: 'tool_use', timestamp: ts,
        summary: input ? `${name} ${input}` : name,
        toolName: name, toolInput: input, model, raw: event,
      });
      break;
    }

    case 'tool_result': {
      const output = event.result?.output;
      const text = typeof output === 'string' ? truncate(output, 120) : '';
      events.push({
        providerId, type: 'tool_result', timestamp: ts,
        summary: text || '(tool result)', raw: event,
      });
      break;
    }

    case 'summary': {
      events.push({
        providerId, type: 'summary', timestamp: ts,
        summary: 'Context compacted', raw: event,
      });
      break;
    }

    default: {
      // Handle 'result' and other types as system events
      const evtType = (event as { type: string }).type;
      if (evtType === 'result') {
        events.push({
          providerId, type: 'system', timestamp: ts,
          summary: 'Session ended', raw: event,
        });
      }
      break;
    }
  }

  return events;
}

// ── Helpers ──

function extractTextContent(content: unknown): string {
  if (!content) return '';
  if (typeof content === 'string') return truncate(content, 200);
  if (Array.isArray(content)) {
    for (const block of content as Array<Record<string, unknown>>) {
      if (block.type === 'text' && typeof block.text === 'string') {
        return truncate(block.text as string, 200);
      }
    }
  }
  return '';
}

function summarizeToolInput(input: Record<string, unknown>): string {
  if (typeof input.command === 'string') return truncate(input.command, 80);
  if (typeof input.file_path === 'string') return truncate(input.file_path, 80);
  if (typeof input.pattern === 'string') return truncate(input.pattern, 80);
  if (typeof input.query === 'string') return truncate(input.query, 80);
  if (typeof input.path === 'string') return truncate(input.path, 80);
  if (typeof input.url === 'string') return truncate(input.url, 80);
  for (const val of Object.values(input)) {
    if (typeof val === 'string' && val.length > 0) return truncate(val, 80);
  }
  return '';
}

function truncate(text: string, maxLen: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > maxLen ? clean.substring(0, maxLen - 3) + '...' : clean;
}
