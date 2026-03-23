/**
 * Line-buffered JSONL parser with optional Zod schema validation.
 * Ported from sidekick-vscode/src/services/JsonlParser.ts
 */

import type { ZodType } from 'zod';

/** Minimal session event shape for stats extraction. */
export interface RawSessionEvent {
  type: string;
  timestamp: string;
  message: {
    role: string;
    id?: string;
    model?: string;
    usage?: {
      input_tokens: number;
      output_tokens: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
      reported_cost?: number;
    };
    content?: unknown;
  };
  tool?: { name: string; input: Record<string, unknown> };
}

export interface JsonlParserCallbacks<T = RawSessionEvent> {
  onEvent: (event: T) => void;
  onError?: (error: Error, line: string) => void;
}

/** Options for JsonlParser construction. */
export interface JsonlParserOptions<T> {
  /**
   * Optional Zod schema for runtime validation.
   * When provided, each parsed JSON line is validated against this schema.
   * Valid events are emitted via onEvent; invalid events go to onError.
   * When omitted, JSON.parse output is cast to T (existing behavior).
   */
  schema?: ZodType<T>;
}

export class JsonlParser<T = RawSessionEvent> {
  private buffer = '';
  private readonly onEvent: (event: T) => void;
  private readonly onError?: (error: Error, line: string) => void;
  private readonly schema?: ZodType<T>;

  constructor(callbacks: JsonlParserCallbacks<T>, options?: JsonlParserOptions<T>) {
    this.onEvent = callbacks.onEvent;
    this.onError = callbacks.onError;
    this.schema = options?.schema;
  }

  processChunk(chunk: string): void {
    this.buffer += chunk;
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() || '';
    for (const line of lines) {
      this.parseLine(line);
    }
  }

  flush(): void {
    if (this.buffer.trim().length > 0) {
      this.parseLine(this.buffer);
      this.buffer = '';
    }
  }

  reset(): void {
    this.buffer = '';
  }

  private parseLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.startsWith('{')) return;
    try {
      const raw = JSON.parse(trimmed);

      if (this.schema) {
        const result = this.schema.safeParse(raw);
        if (result.success) {
          this.onEvent(result.data);
        } else if (this.onError) {
          this.onError(new Error(`Schema validation failed: ${result.error.message}`), line);
        }
      } else {
        this.onEvent(raw as T);
      }
    } catch (error) {
      if (this.onError) {
        this.onError(error instanceof Error ? error : new Error(String(error)), line);
      }
    }
  }
}

/** Truncation patterns from SessionMonitor. */
export const TRUNCATION_PATTERNS: Array<{ regex: RegExp; name: string }> = [
  { regex: /\[Response truncated/, name: 'Response truncated' },
  { regex: /\[WARNING: Tool output was truncated/, name: 'Tool output truncated' },
  { regex: /content_too_long/, name: 'Content too long' },
  { regex: /<response clipped>/, name: 'Response clipped' },
  { regex: /\[Content truncated/, name: 'Content truncated' },
  { regex: /\[\.\.\.truncated/, name: 'Truncated' },
];
