/**
 * @fileoverview Re-exports Codex rollout parser from sidekick-shared.
 *
 * All Codex JSONL rollout parsing is now implemented in sidekick-shared.
 * This file re-exports for backward compatibility within the VS Code extension.
 *
 * @module services/providers/CodexRolloutParser
 */

export {
  CodexRolloutParser,
  extractPatchFilePaths,
  normalizeCodexToolName,
  normalizeCodexToolInput,
} from 'sidekick-shared/dist/parsers/codexParser';
