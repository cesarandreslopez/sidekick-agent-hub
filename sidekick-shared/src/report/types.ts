/**
 * Report-specific types for HTML session report generation.
 */

/** A single content block within a transcript entry. */
export interface TranscriptContentBlock {
  type: 'text' | 'tool_use' | 'tool_result' | 'thinking' | 'image';
  /** Text or thinking content. */
  text?: string;
  /** Tool name (tool_use blocks). */
  toolName?: string;
  /** Full tool input (tool_use blocks). */
  toolInput?: Record<string, unknown>;
  /** Correlation ID linking tool_use to tool_result. */
  toolUseId?: string;
  /** Tool result output content (tool_result blocks). */
  output?: string;
  /** Whether the tool result is an error (tool_result blocks). */
  isError?: boolean;
}

/** A single message entry in the transcript. */
export interface TranscriptEntry {
  type: 'user' | 'assistant' | 'system' | 'summary';
  timestamp: string;
  model?: string;
  usage?: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
  content: TranscriptContentBlock[];
}

/** Options for HTML report generation. */
export interface HtmlReportOptions {
  /** Session file name to display in the header. */
  sessionFileName?: string;
  /** Include thinking blocks in the transcript (default: true). */
  includeThinking?: boolean;
  /** Include full tool input/output detail (default: true). */
  includeToolDetail?: boolean;
  /** Color theme (default: 'dark'). */
  theme?: 'dark' | 'light';
}
