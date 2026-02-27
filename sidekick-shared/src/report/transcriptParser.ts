/**
 * Parse Claude Code JSONL session files into typed transcript entries
 * with full, untruncated content suitable for HTML report rendering.
 */

import * as fs from 'fs';
import { JsonlParser } from '../parsers/jsonl';
import type { RawSessionEvent } from '../parsers/jsonl';
import type { TranscriptEntry, TranscriptContentBlock } from './types';

/**
 * Parse a JSONL session file into an array of TranscriptEntry objects.
 *
 * Unlike the FollowEvent pipeline (which truncates to 120-200 chars),
 * this preserves full message content for HTML report rendering.
 */
export function parseTranscript(sessionPath: string): TranscriptEntry[] {
  let data: string;
  try {
    data = fs.readFileSync(sessionPath, 'utf-8');
  } catch {
    return [];
  }

  const events: RawSessionEvent[] = [];
  const parser = new JsonlParser<RawSessionEvent>({
    onEvent: (event) => events.push(event),
  });
  parser.processChunk(data);
  parser.flush();

  const entries: TranscriptEntry[] = [];

  for (const event of events) {
    const entry = eventToTranscriptEntry(event);
    if (entry) {
      entries.push(entry);
    }
  }

  return entries;
}

function eventToTranscriptEntry(event: RawSessionEvent): TranscriptEntry | null {
  if (!event.type || !event.message) return null;

  const role = event.message.role;
  const timestamp = event.timestamp || '';
  const model = event.message.model;
  const usage = event.message.usage
    ? {
        input_tokens: event.message.usage.input_tokens || 0,
        output_tokens: event.message.usage.output_tokens || 0,
        cache_creation_input_tokens: event.message.usage.cache_creation_input_tokens,
        cache_read_input_tokens: event.message.usage.cache_read_input_tokens,
      }
    : undefined;

  const content = extractContentBlocks(event.message.content);

  // Skip empty entries (warmup messages, etc.)
  if (content.length === 0) return null;

  let type: TranscriptEntry['type'];
  // Check event.type first — summary events have role 'assistant' but should be typed as 'summary'
  if (event.type === 'summary') {
    type = 'summary';
  } else if (role === 'user') {
    type = 'user';
  } else if (role === 'assistant') {
    type = 'assistant';
  } else {
    type = 'system';
  }

  return { type, timestamp, model, usage, content };
}

function extractContentBlocks(content: unknown): TranscriptContentBlock[] {
  if (!content) return [];

  // Simple string content
  if (typeof content === 'string') {
    return content.trim() ? [{ type: 'text', text: content }] : [];
  }

  // Array of content blocks (Claude API format)
  if (!Array.isArray(content)) return [];

  const blocks: TranscriptContentBlock[] = [];
  for (const block of content as Array<Record<string, unknown>>) {
    if (!block || typeof block !== 'object') continue;

    switch (block.type) {
      case 'text': {
        const text = typeof block.text === 'string' ? block.text : '';
        if (text.trim()) {
          blocks.push({ type: 'text', text });
        }
        break;
      }

      case 'thinking': {
        const text = typeof block.thinking === 'string' ? block.thinking : '';
        if (text.trim()) {
          blocks.push({ type: 'thinking', text });
        }
        break;
      }

      case 'tool_use': {
        const toolName = typeof block.name === 'string' ? block.name : 'unknown';
        const toolInput = block.input && typeof block.input === 'object'
          ? block.input as Record<string, unknown>
          : {};
        const toolUseId = typeof block.id === 'string' ? block.id : undefined;
        blocks.push({ type: 'tool_use', toolName, toolInput, toolUseId });
        break;
      }

      case 'tool_result': {
        const toolUseId = typeof block.tool_use_id === 'string' ? block.tool_use_id : undefined;
        const isError = block.is_error === true;
        const output = extractToolResultContent(block.content);
        blocks.push({ type: 'tool_result', toolUseId, output, isError });
        break;
      }

      case 'image': {
        blocks.push({ type: 'image', text: '[Image content]' });
        break;
      }

      default:
        break;
    }
  }

  return blocks;
}

/** Extract text from tool_result content (can be string or array of blocks). */
function extractToolResultContent(content: unknown): string {
  if (!content) return '';
  if (typeof content === 'string') return content;

  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const part of content as Array<Record<string, unknown>>) {
      if (part && typeof part === 'object' && part.type === 'text' && typeof part.text === 'string') {
        parts.push(part.text);
      }
    }
    return parts.join('\n');
  }

  return '';
}
