/**
 * Inline Chat (Quick Ask) - Type Definitions
 *
 * Shared types for inline chat feature providing AI-powered Q&A and code editing.
 * Supports both conversational questions and direct code modifications.
 */

/**
 * Mode of inline chat interaction
 *
 * - 'question': User asked a question, expects a text answer
 * - 'edit': User requested a code change, expects replacement code
 */
export type InlineChatMode = 'question' | 'edit';

/**
 * Request context for inline chat
 *
 * Provides AI with sufficient context to understand the user's intent:
 * - The query/instruction itself
 * - Current selection or cursor position
 * - Surrounding code for context
 * - File metadata (language, path)
 */
export interface InlineChatRequest {
  /** User's question or instruction (e.g., "explain this function" or "add error handling") */
  query: string;

  /** Currently selected text (empty string if no selection) */
  selectedText: string;

  /** Cursor position in the document */
  cursorPosition: {
    line: number;
    character: number;
  };

  /** URI of the document being edited (for file context) */
  documentUri: string;

  /** Programming language ID (e.g., "typescript", "python") */
  languageId: string;

  /** Lines of code before the selection/cursor (for context) */
  contextBefore: string;

  /** Lines of code after the selection/cursor (for context) */
  contextAfter: string;
}

/**
 * AI response for inline chat
 *
 * Contains either:
 * - A text answer (for questions)
 * - Code replacement + explanation (for edits)
 */
export interface InlineChatResponse {
  /** Detected mode from AI analysis of the query */
  mode: InlineChatMode;

  /**
   * Response text:
   * - For 'question' mode: The answer to the user's question
   * - For 'edit' mode: Explanation of what was changed and why
   */
  text: string;

  /**
   * Replacement code (only present in 'edit' mode)
   * This is the actual code to insert/replace
   */
  code?: string;

  /**
   * Range to replace (only present in 'edit' mode when selection exists)
   * If undefined, code should be inserted at cursor position
   */
  range?: {
    start: {
      line: number;
      character: number;
    };
    end: {
      line: number;
      character: number;
    };
  };
}

/**
 * Result of inline chat operation
 *
 * Wrapper for success/error handling
 */
export interface InlineChatResult {
  /** Whether the operation completed successfully */
  success: boolean;

  /** The AI response (only present if success === true) */
  response?: InlineChatResponse;

  /** Error message (only present if success === false) */
  error?: string;
}
