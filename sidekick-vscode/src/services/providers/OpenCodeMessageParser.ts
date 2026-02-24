/**
 * @fileoverview Re-exports OpenCode parser functions from sidekick-shared.
 *
 * All OpenCode message parsing is now implemented in sidekick-shared.
 * This file re-exports for backward compatibility within the VS Code extension.
 *
 * @module services/providers/OpenCodeMessageParser
 */

export {
  normalizeToolName,
  normalizeToolInput,
  detectPlanModeFromText,
  convertOpenCodeMessage,
  parseDbMessageData,
  parseDbPartData,
} from 'sidekick-shared/dist/parsers/openCodeParser';
