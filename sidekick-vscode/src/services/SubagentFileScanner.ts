/**
 * @fileoverview Re-exports subagent scanner from sidekick-shared.
 *
 * All subagent JSONL scanning is now implemented in sidekick-shared.
 * This file re-exports for backward compatibility within the VS Code extension.
 *
 * @module services/SubagentFileScanner
 */

export {
  scanSubagentDir,
  extractTaskInfo,
} from 'sidekick-shared/dist/parsers/subagentScanner';
