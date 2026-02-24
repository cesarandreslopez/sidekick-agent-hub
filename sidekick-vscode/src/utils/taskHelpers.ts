/**
 * @fileoverview Re-exports task helper utilities.
 *
 * The extractTaskIdFromResult function is now inlined in
 * sidekick-shared/src/parsers/subagentScanner.ts. This file
 * provides a standalone export for VS Code extension code that
 * imports it directly.
 *
 * @module utils/taskHelpers
 */

/**
 * Extracts task ID from TaskCreate result content.
 *
 * Looks for "Task #N" or JSON taskId patterns in the result string.
 *
 * @param resultContent - The result content from a TaskCreate tool call
 * @returns The extracted task ID string, or null if not found
 */
export function extractTaskIdFromResult(resultContent: unknown): string | null {
  const resultStr = typeof resultContent === 'string'
    ? resultContent
    : JSON.stringify(resultContent || '');

  // Try to match "Task #N" pattern
  const taskIdMatch = resultStr.match(/Task #(\d+)/i);
  if (taskIdMatch) {
    return taskIdMatch[1];
  }

  // Try to match taskId in JSON-like content
  const jsonIdMatch = resultStr.match(/"taskId"\s*:\s*"?(\d+)"?/i);
  if (jsonIdMatch) {
    return jsonIdMatch[1];
  }

  return null;
}
