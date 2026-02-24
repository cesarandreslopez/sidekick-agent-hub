/**
 * @fileoverview Re-exports OpenCode types from sidekick-shared.
 *
 * All OpenCode session format types are now defined in sidekick-shared.
 * This file re-exports them for backward compatibility within the VS Code extension.
 *
 * @module types/opencode
 */

export type {
  OpenCodeSession,
  OpenCodeMessage,
  OpenCodePart,
  OpenCodeTextPart,
  OpenCodeReasoningPart,
  OpenCodeToolInvocationPart,
  OpenCodeCompactionPart,
  OpenCodeDbToolPart,
  OpenCodeStepStartPart,
  OpenCodeStepFinishPart,
  OpenCodePatchPart,
  OpenCodeSubtaskPart,
  OpenCodeAgentPart,
  OpenCodeFilePart,
  OpenCodeRetryPart,
  OpenCodeSnapshotPart,
  OpenCodeProject,
  DbProject,
  DbSession,
  DbMessage,
  DbPart,
} from 'sidekick-shared/dist/types/opencode';
