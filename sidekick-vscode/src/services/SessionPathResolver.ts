/**
 * @fileoverview Re-exports session path resolver from sidekick-shared.
 *
 * All Claude Code session path resolution is now implemented in sidekick-shared.
 * This file re-exports for backward compatibility within the VS Code extension.
 *
 * The SessionDiagnostics interface and getSessionDiagnostics function remain
 * local to the VS Code extension (used only by debug commands).
 *
 * @module services/SessionPathResolver
 */

import {
  encodeWorkspacePath,
  getSessionDirectory,
  discoverSessionDirectory,
  findActiveSession,
  findAllSessions,
  findSessionsInDirectory,
  findSubdirectorySessionDirs,
  getMostRecentlyActiveSessionDir,
  decodeEncodedPath,
  getAllProjectFolders,
  getSessionDiagnostics,
} from 'sidekick-shared';

export {
  encodeWorkspacePath,
  getSessionDirectory,
  discoverSessionDirectory,
  findActiveSession,
  findAllSessions,
  findSessionsInDirectory,
  findSubdirectorySessionDirs,
  getMostRecentlyActiveSessionDir,
  decodeEncodedPath,
  getAllProjectFolders,
  getSessionDiagnostics,
};

// Re-export ProjectFolderInfo from the shared type (used by session providers)
export type { ProjectFolderInfo } from 'sidekick-shared';

/**
 * Diagnostic information about session path resolution.
 * VS Code extension-only (used by debug commands).
 */
export type { SessionDiagnostics } from 'sidekick-shared';
