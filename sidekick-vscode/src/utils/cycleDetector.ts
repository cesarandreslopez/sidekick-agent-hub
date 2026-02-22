/**
 * @fileoverview Pure utility for detecting repeating cycles in tool call sequences.
 *
 * Implements a sliding-window pattern-matching algorithm to detect when an agent
 * enters a loop of repeated tool calls (e.g., Read → Edit → Read → Edit).
 *
 * @module utils/cycleDetector
 */

import type { ToolCall } from '../types/claudeSession';
import type { CycleSignature, CycleDetection } from '../types/analysis';

/**
 * Builds a signature for a single tool call.
 *
 * The signature captures the tool name and a key derived from its arguments
 * so that equivalent calls produce matching signatures.
 */
export function buildSignature(call: ToolCall): CycleSignature {
  const toolName = call.name;
  let argHash: string;

  switch (toolName) {
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
      argHash = (call.input.file_path as string) || '';
      break;
    case 'Bash':
      argHash = ((call.input.command as string) || '').trim().split(/\s+/)[0] || '';
      break;
    case 'Glob':
    case 'Grep':
      argHash = (call.input.pattern as string) || '';
      break;
    default:
      argHash = JSON.stringify(call.input).substring(0, 100);
      break;
  }

  return { toolName, argHash };
}

/**
 * Checks if two signatures are equal.
 */
function signaturesEqual(a: CycleSignature, b: CycleSignature): boolean {
  return a.toolName === b.toolName && a.argHash === b.argHash;
}

/**
 * Detects a repeating cycle in the last `windowSize` tool calls.
 *
 * Checks for patterns of length 1, 2, and 3 that repeat to fill the window.
 * For example, with windowSize=6:
 * - Pattern length 1: A A A A A A (6 repetitions)
 * - Pattern length 2: A B A B A B (3 repetitions)
 * - Pattern length 3: A B C A B C (2 repetitions)
 *
 * @param calls - Tool calls to analyze (uses last `windowSize` entries)
 * @param windowSize - Number of recent calls to consider (default 10)
 * @returns CycleDetection if a cycle is found, null otherwise
 */
export function detectCycle(calls: ToolCall[], windowSize: number = 10): CycleDetection | null {
  if (calls.length < windowSize) return null;

  const window = calls.slice(-windowSize);
  const signatures = window.map(buildSignature);

  // Check pattern lengths 1, 2, 3
  for (const patternLen of [1, 2, 3]) {
    if (windowSize % patternLen !== 0) continue;

    const repetitions = windowSize / patternLen;
    if (repetitions < 2) continue;

    // Extract the first pattern segment
    const pattern = signatures.slice(0, patternLen);

    // Compare each subsequent segment against the first
    let isRepeating = true;
    for (let rep = 1; rep < repetitions; rep++) {
      const segStart = rep * patternLen;
      for (let j = 0; j < patternLen; j++) {
        if (!signaturesEqual(pattern[j], signatures[segStart + j])) {
          isRepeating = false;
          break;
        }
      }
      if (!isRepeating) break;
    }

    if (isRepeating) {
      // Collect affected files
      const affectedFiles = new Set<string>();
      for (const sig of pattern) {
        if (['Read', 'Write', 'Edit', 'MultiEdit'].includes(sig.toolName) && sig.argHash) {
          affectedFiles.add(sig.argHash);
        }
      }

      const patternDesc = pattern.map(s => `${s.toolName}(${s.argHash.length > 30 ? '...' + s.argHash.slice(-27) : s.argHash})`).join(' → ');

      return {
        pattern,
        repetitions,
        description: `Repeating cycle: ${patternDesc} (${repetitions}x)`,
        affectedFiles: Array.from(affectedFiles),
        detectedAt: new Date(),
      };
    }
  }

  return null;
}
