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

import * as fs from 'fs';
import * as path from 'path';

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
} from 'sidekick-shared/dist/parsers/sessionPathResolver';

// Re-export ProjectFolderInfo from the shared type (used by session providers)
export type { ProjectFolderInfo } from 'sidekick-shared/dist/providers/types';

/**
 * Diagnostic information about session path resolution.
 * VS Code extension-only (used by debug commands).
 */
export interface SessionDiagnostics {
  workspacePath: string;
  encodedPath: string;
  expectedSessionDir: string;
  expectedDirExists: boolean;
  discoveredSessionDir: string | null;
  existingProjectDirs: string[];
  similarDirs: string[];
  platform: string;
  subdirectoryMatches: string[];
  selectedSubdirectoryMatch: string | null;
}

/**
 * Gets diagnostic information about session path resolution.
 * VS Code extension-only (used by debug commands).
 */
export function getSessionDiagnostics(workspacePath: string): SessionDiagnostics {
  // Import from shared at runtime to avoid circular dependencies
  const {
    encodeWorkspacePath,
    getSessionDirectory,
    discoverSessionDirectory,
    findSubdirectorySessionDirs,
    getMostRecentlyActiveSessionDir,
  } = require('sidekick-shared/dist/parsers/sessionPathResolver');

  const encodedPath = encodeWorkspacePath(workspacePath);
  const expectedSessionDir = getSessionDirectory(workspacePath);
  const projectsDir = path.join(require('os').homedir(), '.claude', 'projects');

  let existingProjectDirs: string[] = [];
  let expectedDirExists = false;

  try {
    if (fs.existsSync(projectsDir)) {
      existingProjectDirs = fs.readdirSync(projectsDir)
        .filter(name => {
          const fullPath = path.join(projectsDir, name);
          return fs.statSync(fullPath).isDirectory();
        })
        .sort();
    }
    expectedDirExists = fs.existsSync(expectedSessionDir);
  } catch {
    // Ignore errors - just return empty arrays
  }

  const discoveredSessionDir = discoverSessionDirectory(workspacePath);

  const workspaceBasename = path.basename(workspacePath).toLowerCase();
  const similarDirs = existingProjectDirs.filter((dir: string) => {
    const dirLower = dir.toLowerCase();
    return dirLower.includes(workspaceBasename) ||
           workspaceBasename.includes(dirLower.split('-').pop() || '');
  });

  const subdirectoryMatches = findSubdirectorySessionDirs(workspacePath);
  const selectedSubdirectoryMatch = subdirectoryMatches.length > 0
    ? getMostRecentlyActiveSessionDir(subdirectoryMatches)
    : null;

  return {
    workspacePath,
    encodedPath,
    expectedSessionDir,
    expectedDirExists,
    discoveredSessionDir,
    existingProjectDirs,
    similarDirs,
    platform: process.platform,
    subdirectoryMatches,
    selectedSubdirectoryMatch
  };
}
