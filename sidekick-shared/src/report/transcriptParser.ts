/** Report compatibility adapters over the canonical transcript projection. */

import * as fs from 'node:fs';
import { JsonlParser } from '../parsers/jsonl';
import { extractSessionEvents } from '../schemas/sessionEvent';
import { projectSessionTranscript, type CanonicalTranscriptBlock } from '../transcript';
import type { SessionEvent } from '../types/sessionEvent';
import type { TranscriptEntry, TranscriptContentBlock } from './types';

/** Parse a Claude Code JSONL session through the canonical provider reader. */
export function parseTranscript(sessionPath: string): TranscriptEntry[] {
  try {
    const events: SessionEvent[] = [];
    const parser = new JsonlParser<unknown>({
      onEvent: (raw) => events.push(...extractSessionEvents(raw)),
    });
    parser.processChunk(fs.readFileSync(sessionPath, 'utf8'));
    parser.flush();
    return parseTranscriptFromEvents(events);
  } catch {
    return [];
  }
}

/** Project canonical provider events into the legacy report transcript shape. */
export function parseTranscriptFromEvents(events: SessionEvent[]): TranscriptEntry[] {
  return projectSessionTranscript(events, { fidelity: 'full' }).messages.map((message) => ({
    type: message.role === 'tool' ? 'system' : message.role,
    timestamp: message.timestamp,
    sourceLabel: message.sourceLabel,
    model: message.model,
    usage: message.usage
      ? {
          input_tokens: message.usage.uncachedInputTokens,
          output_tokens: message.usage.outputTokens,
          cache_creation_input_tokens: message.usage.cacheWriteTokens || undefined,
          cache_read_input_tokens: message.usage.cacheReadTokens || undefined,
        }
      : undefined,
    content: message.content.flatMap(toReportBlock),
  }));
}

function toReportBlock(block: CanonicalTranscriptBlock): TranscriptContentBlock[] {
  switch (block.type) {
    case 'text':
      return block.text ? [{ type: 'text', text: block.text }] : [];
    case 'thinking':
      return block.text ? [{ type: 'thinking', text: block.text }] : [];
    case 'tool_use':
      return [
        {
          type: 'tool_use',
          toolName: block.toolName ?? 'unknown',
          toolInput:
            block.input && typeof block.input === 'object'
              ? (block.input as Record<string, unknown>)
              : {},
          toolUseId: block.toolUseId,
        },
      ];
    case 'tool_result':
      return [
        {
          type: 'tool_result',
          toolUseId: block.toolUseId,
          output: reportToolOutput(block.output),
          isError: block.isError,
        },
      ];
    case 'image':
      return [{ type: 'image', text: block.text ?? '[Image content]' }];
    case 'unknown':
      return [];
  }
}

function reportToolOutput(output: unknown): string {
  if (typeof output === 'string') return output;
  if (Array.isArray(output)) {
    return output
      .flatMap((part) =>
        part && typeof part === 'object' && (part as { type?: unknown }).type === 'text'
          ? [String((part as { text?: unknown }).text ?? '')]
          : [],
      )
      .filter(Boolean)
      .join('\n');
  }
  return JSON.stringify(output ?? '');
}
