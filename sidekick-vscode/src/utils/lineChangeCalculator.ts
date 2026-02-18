/**
 * @fileoverview Utility functions for calculating line additions and deletions from tool calls.
 *
 * This module provides functions to analyze Edit, Write, and MultiEdit tool inputs
 * to count the number of lines added and deleted. This enables the mind map and
 * dashboard to display file change statistics.
 *
 * @module utils/lineChangeCalculator
 */

/**
 * Result of calculating line changes from a tool call.
 */
export interface LineChanges {
  /** Number of lines added */
  additions: number;
  /** Number of lines deleted */
  deletions: number;
}

/**
 * Counts the number of lines in a string.
 *
 * Empty or non-string inputs return 0.
 * A single character with no newline is counted as 1 line.
 *
 * @param str - The string to count lines in
 * @returns Number of lines
 */
function countLines(str: string): number {
  if (!str || typeof str !== 'string' || str.length === 0) return 0;
  const newlines = (str.match(/\n/g) || []).length;
  return str.endsWith('\n') ? newlines : newlines + 1;
}

/**
 * Calculates line additions and deletions from a tool call input.
 *
 * Supports the following tools:
 * - **Write**: All content is counted as additions (new file creation)
 * - **Edit**: old_string lines are deletions, new_string lines are additions
 * - **MultiEdit**: Processes each edit in the edits array
 *
 * @param toolName - Name of the tool (Write, Edit, MultiEdit)
 * @param input - Tool input parameters
 * @returns Object with additions and deletions counts
 *
 * @example
 * ```typescript
 * // Write tool - all lines are additions
 * calculateLineChanges('Write', { content: 'line1\nline2\n' });
 * // Returns: { additions: 2, deletions: 0 }
 *
 * // Edit tool - replacing lines
 * calculateLineChanges('Edit', {
 *   old_string: 'old line',
 *   new_string: 'new line 1\nnew line 2'
 * });
 * // Returns: { additions: 2, deletions: 1 }
 * ```
 */
export function calculateLineChanges(
  toolName: string,
  input: Record<string, unknown>
): LineChanges {
  if (toolName === 'Write') {
    const content = input.content as string;
    return { additions: countLines(content), deletions: 0 };
  }

  if (toolName === 'Edit') {
    const oldStr = (input.old_string as string) || '';
    const newStr = (input.new_string as string) || '';
    return {
      additions: countLines(newStr),
      deletions: countLines(oldStr)
    };
  }

  if (toolName === 'MultiEdit') {
    // MultiEdit contains an array of edits
    const edits = input.edits as Array<{ old_string?: string; new_string?: string }> | undefined;
    if (!edits || !Array.isArray(edits)) {
      return { additions: 0, deletions: 0 };
    }

    let totalAdditions = 0;
    let totalDeletions = 0;

    for (const edit of edits) {
      const oldStr = (edit.old_string as string) || '';
      const newStr = (edit.new_string as string) || '';
      totalAdditions += countLines(newStr);
      totalDeletions += countLines(oldStr);
    }

    return { additions: totalAdditions, deletions: totalDeletions };
  }

  // Other tools don't affect line counts
  return { additions: 0, deletions: 0 };
}

/**
 * Aggregates line changes from multiple tool calls.
 *
 * Processes an array of tool calls and returns total additions and deletions
 * across all Write, Edit, and MultiEdit operations.
 *
 * @param toolCalls - Array of tool calls with name and input
 * @returns Aggregated line changes
 */
export function aggregateLineChanges(
  toolCalls: Array<{ name: string; input: Record<string, unknown> }>
): LineChanges {
  let totalAdditions = 0;
  let totalDeletions = 0;

  for (const call of toolCalls) {
    const changes = calculateLineChanges(call.name, call.input);
    totalAdditions += changes.additions;
    totalDeletions += changes.deletions;
  }

  return { additions: totalAdditions, deletions: totalDeletions };
}
