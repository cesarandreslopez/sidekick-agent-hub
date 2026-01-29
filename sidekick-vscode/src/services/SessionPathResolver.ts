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
 * Claude Code replaces path separators with hyphens and removes the
 * leading separator to create a flat directory structure.
 *
 * @param workspacePath - Absolute path to workspace directory
 * @returns Encoded path string (e.g., "home-user-code-project")
 *
 * @example
 * ```typescript
 * encodeWorkspacePath('/home/user/code/project');
 * // => "-home-user-code-project"
 *
 * encodeWorkspacePath('C:\\Users\\user\\code\\project'); // Windows
 * // => "C:-Users-user-code-project"
 * ```
 */
export function encodeWorkspacePath(workspacePath: string): string {
  // Normalize path separators to forward slash
  const normalized = workspacePath.replace(/\\/g, '/');

  // Replace all slashes with hyphens (including leading slash)
  // Claude Code keeps the leading hyphen: /home/user/code -> -home-user-code
  return normalized.replace(/\//g, '-');
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
  const sessionDir = getSessionDirectory(workspacePath);

  try {
    // Check if directory exists
    if (!fs.existsSync(sessionDir)) {
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
  const sessionDir = getSessionDirectory(workspacePath);

  try {
    // Check if directory exists
    if (!fs.existsSync(sessionDir)) {
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
  /** All directories in ~/.claude/projects/ (for debugging path mismatches) */
  existingProjectDirs: string[];
  /** Directories that look similar to expected (fuzzy matches) */
  similarDirs: string[];
  /** Platform info */
  platform: string;
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

  // Find similar directories (fuzzy match for debugging)
  const workspaceBasename = path.basename(workspacePath).toLowerCase();
  const similarDirs = existingProjectDirs.filter(dir => {
    const dirLower = dir.toLowerCase();
    return dirLower.includes(workspaceBasename) ||
           workspaceBasename.includes(dirLower.split('-').pop() || '');
  });

  return {
    workspacePath,
    encodedPath,
    expectedSessionDir,
    expectedDirExists,
    existingProjectDirs,
    similarDirs,
    platform: process.platform
  };
}
