/**
 * @fileoverview Streaming JSONL parser with line buffering.
 *
 * This module provides a robust parser for Claude Code session JSONL files
 * that handles partial lines, malformed JSON, and incremental file reading.
 * Designed for parsing large or growing session files without memory issues.
 *
 * Key features:
 * - Buffers incomplete lines until newline arrives
 * - Gracefully handles malformed JSON (logs and skips)
 * - Supports incremental parsing for actively growing files
 * - Extracts token usage and tool calls from events
 *
 * @module services/JsonlParser
 */

import { ClaudeSessionEvent, TokenUsage, ToolCall } from '../types/claudeSession';

/**
 * Options for JsonlParser constructor.
 */
export interface JsonlParserOptions {
  /**
   * Callback invoked for each successfully parsed event.
   * @param event - The parsed session event
   */
  onEvent: (event: ClaudeSessionEvent) => void;

  /**
   * Optional callback for error handling.
   * @param error - The error that occurred
   * @param line - The malformed line that caused the error
   */
  onError?: (error: Error, line: string) => void;
}

/**
 * Streaming JSONL parser with line buffering.
 *
 * Handles partial lines during streaming reads by buffering incomplete
 * content until a newline delimiter arrives. Gracefully handles malformed
 * JSON by logging and skipping invalid lines.
 *
 * @example
 * ```typescript
 * const parser = new JsonlParser({
 *   onEvent: (event) => {
 *     console.log('Event:', event.type);
 *     const usage = extractTokenUsage(event);
 *     if (usage) {
 *       console.log('Tokens:', usage.inputTokens + usage.outputTokens);
 *     }
 *   },
 *   onError: (error, line) => {
 *     console.error('Parse error:', error.message);
 *   }
 * });
 *
 * // Process chunks from a stream
 * stream.on('data', (chunk: string) => {
 *   parser.processChunk(chunk);
 * });
 *
 * stream.on('end', () => {
 *   parser.flush();
 * });
 * ```
 */
export class JsonlParser {
  /** Internal buffer for incomplete lines */
  private buffer: string = '';

  /** Callback for successfully parsed events */
  private readonly onEvent: (event: ClaudeSessionEvent) => void;

  /** Optional callback for parse errors */
  private readonly onError?: (error: Error, line: string) => void;

  /**
   * Creates a new JsonlParser.
   *
   * @param options - Parser configuration with event and error handlers
   */
  constructor(options: JsonlParserOptions) {
    this.onEvent = options.onEvent;
    this.onError = options.onError;
  }

  /**
   * Processes a chunk of data from a stream.
   *
   * May contain partial lines - incomplete content is buffered
   * until the next chunk arrives with a newline delimiter.
   *
   * @param chunk - String data from stream (may contain multiple or partial lines)
   */
  processChunk(chunk: string): void {
    // Append chunk to buffer
    this.buffer += chunk;

    // Split on newlines
    const lines = this.buffer.split('\n');

    // Keep last element in buffer (may be incomplete)
    this.buffer = lines.pop() || '';

    // Process complete lines
    for (const line of lines) {
      this.parseLine(line);
    }
  }

  /**
   * Flushes any remaining buffered content.
   *
   * Should be called at end of stream to process the final
   * line if it doesn't end with a newline.
   */
  flush(): void {
    if (this.buffer.trim().length > 0) {
      this.parseLine(this.buffer);
      this.buffer = '';
    }
  }

  /**
   * Resets the parser state.
   *
   * Clears the internal buffer. Useful for reusing the parser
   * for a new stream or after an error.
   */
  reset(): void {
    this.buffer = '';
  }

  /**
   * Parses a single complete line of JSONL.
   *
   * @param line - Complete line to parse (no partial content)
   */
  private parseLine(line: string): void {
    const trimmed = line.trim();

    // Skip empty lines
    if (trimmed.length === 0) {
      return;
    }

    // Quick validation: JSONL lines must start with { (object)
    // This catches corrupted reads early without expensive JSON.parse
    if (!trimmed.startsWith('{')) {
      if (this.onError) {
        this.onError(
          new Error('Line does not start with { - not valid JSONL'),
          line
        );
      }
      return;
    }

    try {
      const event = JSON.parse(trimmed) as ClaudeSessionEvent;
      this.onEvent(event);
    } catch (error) {
      // Handle parse errors gracefully
      const parseError = error instanceof Error
        ? error
        : new Error(String(error));

      if (this.onError) {
        this.onError(parseError, line);
      } else {
        // Default error handling - log and continue
        console.error('Failed to parse JSONL line:', parseError.message);
        console.error('Line:', line.substring(0, 100) + '...');
      }
    }
  }
}

/**
 * Extracts normalized token usage from a session event.
 *
 * Only assistant events contain usage data. Returns null for
 * other event types or events without usage information.
 *
 * @param event - Session event to extract usage from
 * @returns Normalized token usage, or null if not available
 *
 * @example
 * ```typescript
 * const usage = extractTokenUsage(event);
 * if (usage) {
 *   const totalTokens = usage.inputTokens + usage.outputTokens;
 *   const cachedTokens = usage.cacheReadTokens;
 *   console.log(`Used ${totalTokens} tokens (${cachedTokens} from cache)`);
 * }
 * ```
 */
export function extractTokenUsage(event: ClaudeSessionEvent): TokenUsage | null {
  // Only assistant events have usage data
  if (event.type !== 'assistant') {
    return null;
  }

  // Check if usage field exists
  const usage = event.message.usage;
  if (!usage) {
    return null;
  }

  // Normalize to camelCase with explicit model
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheWriteTokens: usage.cache_creation_input_tokens || 0,
    cacheReadTokens: usage.cache_read_input_tokens || 0,
    model: event.message.model || 'unknown',
    timestamp: new Date(event.timestamp),
    reportedCost: usage.reported_cost,
    reasoningTokens: usage.reasoning_tokens || 0,
  };
}

/**
 * Extracts tool call information from a session event.
 *
 * Returns tool invocation details for tool_use events,
 * or null for other event types.
 *
 * @param event - Session event to extract tool call from
 * @returns Tool call details, or null if not a tool use event
 *
 * @example
 * ```typescript
 * const toolCall = extractToolCall(event);
 * if (toolCall) {
 *   console.log(`Called ${toolCall.name} with:`, toolCall.input);
 * }
 * ```
 */
export function extractToolCall(event: ClaudeSessionEvent): ToolCall | null {
  // Only tool_use events have tool data
  if (event.type !== 'tool_use' || !event.tool) {
    return null;
  }

  return {
    name: event.tool.name,
    input: event.tool.input,
    timestamp: new Date(event.timestamp)
  };
}
