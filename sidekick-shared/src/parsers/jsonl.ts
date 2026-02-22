/**
 * Line-buffered JSONL parser and token/tool extraction.
 * Ported from sidekick-vscode/src/services/JsonlParser.ts
 */

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

export interface JsonlParserCallbacks {
  onEvent: (event: RawSessionEvent) => void;
  onError?: (error: Error, line: string) => void;
}

export class JsonlParser {
  private buffer = '';
  private readonly onEvent: (event: RawSessionEvent) => void;
  private readonly onError?: (error: Error, line: string) => void;

  constructor(callbacks: JsonlParserCallbacks) {
    this.onEvent = callbacks.onEvent;
    this.onError = callbacks.onError;
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
      const event = JSON.parse(trimmed) as RawSessionEvent;
      this.onEvent(event);
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
