/**
 * @fileoverview Session path resolution for Claude Code projects.
 *
 * This module provides utilities for locating Claude Code session files
 * in ~/.claude/projects/. Claude Code encodes workspace paths by replacing
 * slashes with hyphens, e.g., /home/user/code/project -> home-user-code-project.
 *
 * Session files are stored as [session-uuid].jsonl in the encoded directory.
 *
 * @module services/SessionPathResolver
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

/**
 * Encodes a workspace path to Claude Code's directory naming scheme.
 *
 * Claude Code replaces path separators, colons, and underscores with hyphens
 * to create a flat directory structure.
 *
 * @param workspacePath - Absolute path to workspace directory
 * @returns Encoded path string (e.g., "-home-user-code-project")
 *
 * @example
 * ```typescript
 * encodeWorkspacePath('/home/user/code/my_project');
 * // => "-home-user-code-my-project"
 *
 * encodeWorkspacePath('C:\\Users\\user\\code\\my_project'); // Windows
 * // => "C--Users-user-code-my-project"
 * ```
 */
export function encodeWorkspacePath(workspacePath: string): string {
  // Normalize path separators to forward slash
  const normalized = workspacePath.replace(/\\/g, '/');

  // Replace colons, slashes, and underscores with hyphens
  // Windows: C:\Users\foo_bar -> C:/Users/foo_bar -> C--Users-foo-bar
  // Unix: /home/user/foo_bar -> -home-user-foo-bar
  return normalized.replace(/[:/_]/g, '-');
}

/**
 * Gets the session directory path for a workspace.
 *
 * Returns the directory where Claude Code stores session files
 * for the given workspace, even if the directory doesn't exist.
 *
 * @param workspacePath - Absolute path to workspace directory
 * @returns Absolute path to session directory
 *
 * @example
 * ```typescript
 * getSessionDirectory('/home/user/code/project');
 * // => "/home/user/.claude/projects/-home-user-code-project"
 * ```
 */
export function getSessionDirectory(workspacePath: string): string {
  const encoded = encodeWorkspacePath(workspacePath);
  return path.join(os.homedir(), '.claude', 'projects', encoded);
}

/** How recently a file must be modified to be considered "active" (5 minutes) */
const ACTIVE_SESSION_THRESHOLD_MS = 5 * 60 * 1000;

/**
 * Finds session directories for Claude Code sessions started from subdirectories
 * of the given workspace path.
 *
 * When VS Code workspace is `/home/user/project` but Claude Code starts from
 * a subdirectory like `/home/user/project/packages/app`, the session goes to
 * `~/.claude/projects/-home-user-project-packages-app/` which we need to find.
 *
 * @param workspacePath - Absolute path to workspace directory
 * @returns Array of matching session directory paths
 *
 * @example
 * ```typescript
 * // Workspace: /home/user/project
 * // Claude started from: /home/user/project/packages/app
 * findSubdirectorySessionDirs('/home/user/project');
 * // => ["/home/user/.claude/projects/-home-user-project-packages-app"]
 * ```
 */
export function findSubdirectorySessionDirs(workspacePath: string): string[] {
  const projectsDir = path.join(os.homedir(), '.claude', 'projects');

  try {
    if (!fs.existsSync(projectsDir)) {
      return [];
    }

    // Encode workspace path to get the prefix to match
    const encodedPrefix = encodeWorkspacePath(workspacePath).toLowerCase();

    // Get all directories in projects folder
    const allDirs = fs.readdirSync(projectsDir).filter(name => {
      const fullPath = path.join(projectsDir, name);
      try {
        return fs.statSync(fullPath).isDirectory();
      } catch {
        return false;
      }
    });

    // Find directories that start with the encoded workspace prefix followed by a hyphen
    // The hyphen requirement prevents /project matching /project-v2
    const matches: string[] = [];
    for (const dir of allDirs) {
      const dirLower = dir.toLowerCase();
      // Must start with prefix AND have a hyphen after (indicating subdirectory)
      if (dirLower.startsWith(encodedPrefix + '-')) {
        matches.push(path.join(projectsDir, dir));
      }
    }

    return matches;
  } catch {
    return [];
  }
}

/**
 * Gets the most recently active session directory from a list of directories.
 *
 * For each directory, finds the most recent .jsonl file by modification time,
 * then returns the directory containing the overall most recent session.
 *
 * @param sessionDirs - Array of session directory paths to check
 * @returns Path to most recently active directory, or null if none have sessions
 *
 * @example
 * ```typescript
 * getMostRecentlyActiveSessionDir([
 *   '/home/user/.claude/projects/-home-user-project-packages-app',
 *   '/home/user/.claude/projects/-home-user-project-packages-lib'
 * ]);
 * // => "/home/user/.claude/projects/-home-user-project-packages-app"
 * ```
 */
export function getMostRecentlyActiveSessionDir(sessionDirs: string[]): string | null {
  let mostRecentDir: string | null = null;
  let mostRecentMtime = 0;

  for (const dir of sessionDirs) {
    try {
      // Find most recent .jsonl file in this directory
      const files = fs.readdirSync(dir)
        .filter(file => file.endsWith('.jsonl'));

      for (const file of files) {
        try {
          const fullPath = path.join(dir, file);
          const stats = fs.statSync(fullPath);
          // Only consider non-empty files
          if (stats.size > 0 && stats.mtime.getTime() > mostRecentMtime) {
            mostRecentMtime = stats.mtime.getTime();
            mostRecentDir = dir;
          }
        } catch {
          // Skip files we can't stat
        }
      }
    } catch {
      // Skip directories we can't read
    }
  }

  return mostRecentDir;
}

/**
 * Discovers the session directory for a workspace by trying multiple strategies.
 *
 * Strategy order:
 * 1. Try the computed encoded path (fast, works if our encoding matches Claude Code's)
 * 2. Scan ~/.claude/projects/ for directories matching the workspace name
 * 3. Scan temp directory for Claude scratchpad directories to find actual encoding
 *
 * @param workspacePath - Absolute path to workspace directory
 * @returns Absolute path to session directory, or null if not found
 */
export function discoverSessionDirectory(workspacePath: string): string | null {
  const projectsDir = path.join(os.homedir(), '.claude', 'projects');

  // Strategy 1: Try computed encoded path (exact match)
  const computedDir = getSessionDirectory(workspacePath);
  if (fs.existsSync(computedDir)) {
    return computedDir;
  }

  // Strategy 1.5: Check for subdirectory sessions
  // When Claude Code starts from a subdirectory of the workspace, the session
  // is stored in a directory matching the subdirectory path. We find the most
  // recently active one.
  const subdirMatches = findSubdirectorySessionDirs(workspacePath);
  if (subdirMatches.length > 0) {
    const mostRecent = getMostRecentlyActiveSessionDir(subdirMatches);
    if (mostRecent) {
      return mostRecent;
    }
  }

  // Strategy 2: Scan ~/.claude/projects/ for matching directories
  try {
    if (fs.existsSync(projectsDir)) {
      const existingDirs = fs.readdirSync(projectsDir).filter(name => {
        const fullPath = path.join(projectsDir, name);
        try {
          return fs.statSync(fullPath).isDirectory();
        } catch {
          return false;
        }
      });

      // Try to match by workspace path components
      // Normalize workspace path for comparison
      const normalizedWorkspace = workspacePath
        .replace(/\\/g, '/')
        .replace(/:/g, '-')
        .replace(/_/g, '-')
        .replace(/\//g, '-')
        .toLowerCase();

      for (const dir of existingDirs) {
        // Check if the directory name matches (case-insensitive)
        if (dir.toLowerCase() === normalizedWorkspace) {
          return path.join(projectsDir, dir);
        }
      }

      // Fallback: match by final path component (project name)
      const workspaceBasename = path.basename(workspacePath)
        .replace(/_/g, '-')
        .toLowerCase();

      for (const dir of existingDirs) {
        const dirLower = dir.toLowerCase();
        // Check if dir ends with the project name
        if (dirLower.endsWith('-' + workspaceBasename) || dirLower === workspaceBasename) {
          return path.join(projectsDir, dir);
        }
      }
    }
  } catch {
    // Ignore errors during discovery
  }

  // Strategy 3: Check temp directory for Claude scratchpad directories
  // Claude creates: <tmpdir>/claude/<encoded-workspace>/<session-uuid>/scratchpad
  try {
    const claudeTempDir = path.join(os.tmpdir(), 'claude');
    if (fs.existsSync(claudeTempDir)) {
      const tempDirs = fs.readdirSync(claudeTempDir).filter(name => {
        const fullPath = path.join(claudeTempDir, name);
        try {
          return fs.statSync(fullPath).isDirectory();
        } catch {
          return false;
        }
      });

      // Match by workspace basename
      const workspaceBasename = path.basename(workspacePath)
        .replace(/_/g, '-')
        .toLowerCase();

      for (const encodedDir of tempDirs) {
        const encodedLower = encodedDir.toLowerCase();
        if (encodedLower.endsWith('-' + workspaceBasename) || encodedLower === workspaceBasename) {
          // Found a match in temp - use this encoding for the session directory
          const sessionDir = path.join(projectsDir, encodedDir);
          if (fs.existsSync(sessionDir)) {
            return sessionDir;
          }
        }
      }
    }
  } catch {
    // Ignore errors during temp directory scan
  }

  return null;
}

/**
 * Finds the most recently modified session file for a workspace.
 *
 * Prioritizes "active" sessions (modified within last 5 minutes) over
 * stale ones. This helps select the right session when multiple exist.
 *
 * @param workspacePath - Absolute path to workspace directory
 * @returns Path to active session file, or null if none exists
 *
 * @example
 * ```typescript
 * const sessionPath = findActiveSession('/home/user/code/project');
 * if (sessionPath) {
 *   console.log('Active session:', sessionPath);
 * } else {
 *   console.log('No active Claude Code session for this workspace');
 * }
 * ```
 */
export function findActiveSession(workspacePath: string): string | null {
  // Use discovery to find the session directory (handles encoding differences)
  const sessionDir = discoverSessionDirectory(workspacePath);

  try {
    // Check if directory was found
    if (!sessionDir) {
      return null;
    }

    const now = Date.now();

    // Find all .jsonl files with stats
    const files = fs.readdirSync(sessionDir)
      .filter(file => file.endsWith('.jsonl'))
      .map(file => {
        const fullPath = path.join(sessionDir, file);
        const stats = fs.statSync(fullPath);
        const mtime = stats.mtime.getTime();
        return {
          path: fullPath,
          mtime,
          size: stats.size,
          isActive: (now - mtime) < ACTIVE_SESSION_THRESHOLD_MS
        };
      })
      // Filter out empty files
      .filter(file => file.size > 0);

    // Return null if no session files
    if (files.length === 0) {
      return null;
    }

    // Prefer active sessions, then sort by modification time
    files.sort((a, b) => {
      // Active sessions first
      if (a.isActive && !b.isActive) return -1;
      if (!a.isActive && b.isActive) return 1;
      // Then by modification time (most recent first)
      return b.mtime - a.mtime;
    });

    return files[0].path;

  } catch (error) {
    // Handle errors gracefully - missing directory, permission issues, etc.
    console.error('Error finding active session:', error);
    return null;
  }
}

/**
 * Finds all session files for a workspace.
 *
 * Returns paths to all .jsonl session files for the workspace,
 * sorted by modification time (most recent first). Useful for
 * session history features.
 *
 * @param workspacePath - Absolute path to workspace directory
 * @returns Array of session file paths (empty if none exist)
 *
 * @example
 * ```typescript
 * const sessions = findAllSessions('/home/user/code/project');
 * console.log(`Found ${sessions.length} session(s)`);
 * sessions.forEach(session => console.log(session));
 * ```
 */
export function findAllSessions(workspacePath: string): string[] {
  // Use discovery to find the session directory (handles encoding differences)
  const sessionDir = discoverSessionDirectory(workspacePath);

  try {
    // Check if directory was found
    if (!sessionDir) {
      return [];
    }

    // Find and sort all .jsonl files
    const files = fs.readdirSync(sessionDir)
      .filter(file => file.endsWith('.jsonl'))
      .map(file => {
        const fullPath = path.join(sessionDir, file);
        const stats = fs.statSync(fullPath);
        return {
          path: fullPath,
          mtime: stats.mtime.getTime()
        };
      })
      .sort((a, b) => b.mtime - a.mtime)
      .map(file => file.path);

    return files;

  } catch (error) {
    // Handle errors gracefully
    console.error('Error finding sessions:', error);
    return [];
  }
}

/**
 * Diagnostic information about session path resolution.
 *
 * Helps debug issues where sessions aren't being detected by showing
 * what paths the extension is looking for and what actually exists.
 */
export interface SessionDiagnostics {
  /** Workspace path being monitored */
  workspacePath: string;
  /** Encoded path (how Claude Code names the directory) */
  encodedPath: string;
  /** Full expected session directory path */
  expectedSessionDir: string;
  /** Whether the expected directory exists */
  expectedDirExists: boolean;
  /** Directory found by discovery (may differ from expected if encoding differs) */
  discoveredSessionDir: string | null;
  /** All directories in ~/.claude/projects/ (for debugging path mismatches) */
  existingProjectDirs: string[];
  /** Directories that look similar to expected (fuzzy matches) */
  similarDirs: string[];
  /** Platform info */
  platform: string;
  /** Subdirectory session matches (sessions started from subdirectories of workspace) */
  subdirectoryMatches: string[];
  /** Selected subdirectory match (most recently active) */
  selectedSubdirectoryMatch: string | null;
}

/**
 * Gets diagnostic information about session path resolution.
 *
 * Useful for debugging why sessions aren't being detected,
 * especially on Mac where path encoding might differ.
 *
 * @param workspacePath - Absolute path to workspace directory
 * @returns Diagnostic information
 */
export function getSessionDiagnostics(workspacePath: string): SessionDiagnostics {
  const encodedPath = encodeWorkspacePath(workspacePath);
  const expectedSessionDir = getSessionDirectory(workspacePath);
  const projectsDir = path.join(os.homedir(), '.claude', 'projects');

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

  // Try discovery to find actual session directory
  const discoveredSessionDir = discoverSessionDirectory(workspacePath);

  // Find similar directories (fuzzy match for debugging)
  const workspaceBasename = path.basename(workspacePath).toLowerCase();
  const similarDirs = existingProjectDirs.filter(dir => {
    const dirLower = dir.toLowerCase();
    return dirLower.includes(workspaceBasename) ||
           workspaceBasename.includes(dirLower.split('-').pop() || '');
  });

  // Find subdirectory session matches
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
