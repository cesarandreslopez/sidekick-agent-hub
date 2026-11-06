/**
 * @fileoverview Session path resolution for Claude Code projects.
 *
 * This module provides utilities for locating Claude Code session files
 * in ~/.claude/projects/. Claude Code encodes workspace paths by replacing
 * slashes with hyphens, e.g., /home/user/code/project -> home-user-code-project.
 *
 * Session files are stored as [session-uuid].jsonl in the encoded directory.
 *
 * @module sidekick-shared/parsers/sessionPathResolver
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import type { ProjectFolderInfo } from '../providers/types';
import { getClaudeProjectsDir } from '../claudePaths';
import { resolveGitWorktrees } from '../gitWorktrees';

/**
 * Encodes a workspace path to Claude Code's on-disk directory naming scheme
 * under `~/.claude/projects/` — every non-ASCII-alphanumeric character
 * (separators, colons, underscores, dots, spaces) becomes a hyphen, and case
 * is preserved. Exported from the package root as `encodeClaudeWorkspacePath`.
 *
 * Not to be confused with the top-level `encodeWorkspacePath` export from
 * `paths.ts`: that one is Sidekick's own config-store slug (it keeps dots) and
 * does NOT match Claude Code's scheme — using it to build a
 * `~/.claude/projects/` path silently misses for any workspace containing a
 * dot or space. For lookups, prefer `getClaudeSessionDirectory` or the
 * mismatch-tolerant `discoverSessionDirectory` over raw string encoding.
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

  // Claude Code replaces every non-alphanumeric path character, including
  // dots and spaces, with a hyphen.
  return normalized.replace(/[^a-zA-Z0-9]/g, '-');
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
export function getSessionDirectory(
  workspacePath: string,
  projectsDir: string = getClaudeProjectsDir(),
): string {
  const encoded = encodeWorkspacePath(workspacePath);
  return path.join(projectsDir, encoded);
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
export function findSubdirectorySessionDirs(
  workspacePath: string,
  projectsDir: string = getClaudeProjectsDir(),
): string[] {
  try {
    if (!fs.existsSync(projectsDir)) {
      return [];
    }

    // Encode workspace path to get the prefix to match
    const encodedPrefix = encodeWorkspacePath(workspacePath).toLowerCase();

    // Get all directories in projects folder
    const allDirs = fs.readdirSync(projectsDir).filter((name) => {
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
      const files = fs.readdirSync(dir).filter((file) => file.endsWith('.jsonl'));

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
export function discoverSessionDirectory(
  workspacePath: string,
  projectsDir: string = getClaudeProjectsDir(),
): string | null {
  // Strategy 1: Try computed encoded path (exact match)
  const computedDir = getSessionDirectory(workspacePath, projectsDir);
  if (fs.existsSync(computedDir)) {
    return computedDir;
  }

  // Strategy 1.5: Check for subdirectory sessions
  // When Claude Code starts from a subdirectory of the workspace, the session
  // is stored in a directory matching the subdirectory path. We find the most
  // recently active one.
  const subdirMatches = findSubdirectorySessionDirs(workspacePath, projectsDir);
  if (subdirMatches.length > 0) {
    const mostRecent = getMostRecentlyActiveSessionDir(subdirMatches);
    if (mostRecent) {
      return mostRecent;
    }
  }

  // Strategy 2: Scan ~/.claude/projects/ for matching directories
  try {
    if (fs.existsSync(projectsDir)) {
      const existingDirs = fs.readdirSync(projectsDir).filter((name) => {
        const fullPath = path.join(projectsDir, name);
        try {
          return fs.statSync(fullPath).isDirectory();
        } catch {
          return false;
        }
      });

      // Try to match by workspace path components
      // Normalize workspace path for comparison
      const normalizedWorkspace = encodeWorkspacePath(workspacePath).toLowerCase();

      for (const dir of existingDirs) {
        // Check if the directory name matches (case-insensitive)
        if (dir.toLowerCase() === normalizedWorkspace) {
          return path.join(projectsDir, dir);
        }
      }

      // Fallback: match by final path component (project name)
      const workspaceBasename = path
        .basename(workspacePath)
        .replace(/[^a-zA-Z0-9]/g, '-')
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
      const tempDirs = fs.readdirSync(claudeTempDir).filter((name) => {
        const fullPath = path.join(claudeTempDir, name);
        try {
          return fs.statSync(fullPath).isDirectory();
        } catch {
          return false;
        }
      });

      // Match by workspace basename
      const workspaceBasename = path.basename(workspacePath).replace(/_/g, '-').toLowerCase();

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
export function findActiveSession(
  workspacePath: string,
  projectsDir: string = getClaudeProjectsDir(),
): string | null {
  // Use discovery to find the session directory (handles encoding differences)
  const sessionDir = discoverSessionDirectory(workspacePath, projectsDir);

  try {
    // Check if directory was found
    if (!sessionDir) {
      return null;
    }

    const now = Date.now();

    // Find all .jsonl files with stats
    const files = fs
      .readdirSync(sessionDir)
      .filter((file) => file.endsWith('.jsonl'))
      .map((file) => {
        const fullPath = path.join(sessionDir, file);
        const stats = fs.statSync(fullPath);
        const mtime = stats.mtime.getTime();
        return {
          path: fullPath,
          mtime,
          size: stats.size,
          isActive: now - mtime < ACTIVE_SESSION_THRESHOLD_MS,
        };
      })
      // Filter out empty files
      .filter((file) => file.size > 0);

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
export function findAllSessions(
  workspacePath: string,
  projectsDir: string = getClaudeProjectsDir(),
): string[] {
  // Use discovery to find the session directory (handles encoding differences)
  const sessionDir = discoverSessionDirectory(workspacePath, projectsDir);

  try {
    // Check if directory was found
    if (!sessionDir) {
      return [];
    }

    // Find and sort all .jsonl files
    const files = fs
      .readdirSync(sessionDir)
      .filter((file) => file.endsWith('.jsonl'))
      .map((file) => {
        const fullPath = path.join(sessionDir, file);
        try {
          const stats = fs.statSync(fullPath);
          return {
            path: fullPath,
            mtime: stats.mtime.getTime(),
          };
        } catch {
          return null;
        }
      })
      .filter((file): file is { path: string; mtime: number } => file !== null)
      .sort((a, b) => b.mtime - a.mtime)
      .map((file) => file.path);

    return files;
  } catch (error) {
    // Handle errors gracefully
    console.error('Error finding sessions:', error);
    return [];
  }
}

/**
 * Decodes an encoded directory name back to a human-readable path.
 *
 * Claude Code encodes paths by replacing slashes, colons, and underscores with hyphens.
 * This function attempts to reverse that encoding. Note that some ambiguity exists
 * (e.g., was it a slash or underscore?), so we default to slashes for path separators.
 *
 * @param encoded - Encoded directory name (e.g., "-home-user-project")
 * @returns Decoded path (e.g., "/home/user/project")
 *
 * @example
 * ```typescript
 * decodeEncodedPath('-home-user-code-project');
 * // => "/home/user/code/project"
 *
 * decodeEncodedPath('C--Users-user-code');
 * // => "C:/Users/user/code"
 * ```
 */
export function decodeEncodedPath(encoded: string): string {
  // Handle Windows paths (start with drive letter like "C-")
  const windowsDriveMatch = encoded.match(/^([A-Za-z])--(.*)/);
  if (windowsDriveMatch) {
    const drive = windowsDriveMatch[1];
    const rest = windowsDriveMatch[2];
    // Replace single hyphens with slashes (path separators)
    const decoded = rest.replace(/-/g, '/');
    return `${drive}:/${decoded}`;
  }

  // Handle Unix paths (start with hyphen representing root /)
  if (encoded.startsWith('-')) {
    // Remove leading hyphen, replace remaining hyphens with slashes
    return '/' + encoded.substring(1).replace(/-/g, '/');
  }

  // Fallback: just replace hyphens with slashes
  return encoded.replace(/-/g, '/');
}

/**
 * Gets all project folders from ~/.claude/projects/.
 *
 * Returns information about every project directory Claude Code has created,
 * sorted by priority:
 * 1. Exact workspace match (if workspacePath provided)
 * 2. Subdirectories of workspace (if workspacePath provided)
 * 3. Most recently active (based on session file modification times)
 *
 * @param workspacePath - Optional workspace path to prioritize in sorting
 * @returns Array of project folder info, sorted by priority
 *
 * @example
 * ```typescript
 * const folders = getAllProjectFolders('/home/user/project');
 * // => [
 * //   { dir: '/home/user/.claude/projects/-home-user-project',  // exact match first
 * //     encodedName: '-home-user-project',
 * //     name: '/home/user/project',
 * //     sessionCount: 3,
 * //     lastModified: Date },
 * //   { dir: '/home/user/.claude/projects/-home-user-project-subdir',  // subdirs next
 * //     ... },
 * //   ...  // then others by recency
 * // ]
 * ```
 */
export function getAllProjectFolders(
  workspacePath?: string,
  projectsDir: string = getClaudeProjectsDir(),
): ProjectFolderInfo[] {
  const folders: ProjectFolderInfo[] = [];

  try {
    if (!fs.existsSync(projectsDir)) {
      return [];
    }

    const entries = fs.readdirSync(projectsDir);

    for (const entry of entries) {
      const fullPath = path.join(projectsDir, entry);

      try {
        const stats = fs.statSync(fullPath);
        if (!stats.isDirectory()) {
          continue;
        }

        // Count session files and find most recent modification
        const sessionFiles = fs.readdirSync(fullPath).filter((f) => f.endsWith('.jsonl'));

        let lastModified = stats.mtime;
        let sessionCount = 0;

        for (const sessionFile of sessionFiles) {
          try {
            const sessionPath = path.join(fullPath, sessionFile);
            const sessionStats = fs.statSync(sessionPath);
            if (sessionStats.size > 0) {
              sessionCount++;
              if (sessionStats.mtime > lastModified) {
                lastModified = sessionStats.mtime;
              }
            }
          } catch {
            // Skip files we can't stat
          }
        }

        folders.push({
          dir: fullPath,
          encodedName: entry,
          name: decodeEncodedPath(entry),
          sessionCount,
          lastModified,
        });
      } catch {
        // Skip directories we can't read
      }
    }

    // Sort with workspace prioritization
    // Use encoded names for comparison (decoded paths are lossy — hyphens in
    // directory names become indistinguishable from path separators)
    folders.sort((a, b) => {
      if (workspacePath) {
        const encodedWorkspace = encodeWorkspacePath(workspacePath).toLowerCase();
        const aEncoded = a.encodedName.toLowerCase();
        const bEncoded = b.encodedName.toLowerCase();

        // Priority 1: Exact workspace match comes first
        const aIsExact = aEncoded === encodedWorkspace;
        const bIsExact = bEncoded === encodedWorkspace;
        if (aIsExact && !bIsExact) return -1;
        if (!aIsExact && bIsExact) return 1;

        // Priority 2: Subdirectories of workspace come next
        const aIsSubdir = aEncoded.startsWith(encodedWorkspace + '-');
        const bIsSubdir = bEncoded.startsWith(encodedWorkspace + '-');
        if (aIsSubdir && !bIsSubdir) return -1;
        if (!aIsSubdir && bIsSubdir) return 1;
      }

      // Default: sort by most recently active
      return b.lastModified.getTime() - a.lastModified.getTime();
    });

    return folders;
  } catch {
    return [];
  }
}

/**
 * Finds all session files in a specific directory.
 *
 * Unlike findAllSessions which uses workspace-based discovery, this function
 * accepts a direct path to a session directory and returns all .jsonl files.
 *
 * @param sessionDir - Absolute path to a session directory
 * @returns Array of session file paths, sorted by modification time (most recent first)
 *
 * @example
 * ```typescript
 * findSessionsInDirectory('/home/user/.claude/projects/-home-user-project');
 * // => ['/home/user/.claude/projects/-home-user-project/abc123.jsonl', ...]
 * ```
 */
export function findSessionsInDirectory(sessionDir: string): string[] {
  return findSessionFilesWithStats(sessionDir).map((file) => file.path);
}

export interface SessionFileStat {
  path: string;
  mtime: Date;
  sizeBytes: number;
}

/**
 * The non-empty `.jsonl` files in a session directory with the stat each one
 * already cost, newest first, so callers that need the mtime do not stat the
 * same files a second time.
 */
export function findSessionFilesWithStats(sessionDir: string): SessionFileStat[] {
  try {
    if (!fs.existsSync(sessionDir)) {
      return [];
    }

    return fs
      .readdirSync(sessionDir)
      .filter((file) => file.endsWith('.jsonl'))
      .map((file) => {
        const fullPath = path.join(sessionDir, file);
        try {
          const stats = fs.statSync(fullPath);
          return { path: fullPath, mtime: stats.mtime, sizeBytes: stats.size };
        } catch {
          return null;
        }
      })
      .filter((f): f is SessionFileStat => f !== null && f.sizeBytes > 0)
      .sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
  } catch {
    return [];
  }
}

// ═══════════════════════════════════════════════════════════════════════
// Multi-worktree session discovery
// ═══════════════════════════════════════════════════════════════════════

/**
 * Detects if a workspace is a git worktree and resolves the main repo path.
 *
 * @deprecated Use `resolveGitWorktrees()`, which also reads bare,
 * `--separate-git-dir` and relative-path layouts. This wrapper answers from
 * it: the main checkout (or the bare repository) of a linked worktree, and
 * null for anything else, the main checkout included.
 *
 * @param workspacePath - Absolute path to workspace directory
 * @returns Main repository path, or null if not a linked worktree
 */
export function resolveWorktreeMainRepo(workspacePath: string): string | null {
  const layout = resolveGitWorktrees(workspacePath);
  if (!layout || layout.gitDir === layout.commonDir) return null;
  const main = layout.worktrees.find((worktree) => worktree.kind !== 'linked');
  return main?.path ?? null;
}

/**
 * Discovers all worktree sibling paths for a main repository.
 *
 * @deprecated Use `resolveGitWorktrees()`. This wrapper returns its linked
 * worktrees (those whose directory still exists).
 *
 * @param mainRepoPath - Absolute path to the main repository
 * @returns Array of absolute paths to worktree working directories
 */
export function discoverWorktreeSiblings(mainRepoPath: string): string[] {
  const layout = resolveGitWorktrees(mainRepoPath);
  return layout
    ? layout.worktrees
        .filter((worktree) => worktree.kind === 'linked')
        .map((worktree) => worktree.path)
    : [];
}

/**
 * Finds all sessions across the main repo and all its worktrees.
 *
 * When monitoring from a worktree, sessions started from the main repo
 * or other worktrees are normally invisible. This function consolidates
 * sessions from all related workspaces.
 *
 * @param workspacePath - Absolute path to workspace directory (may be worktree or main repo)
 * @returns Sorted array of session file paths from all related workspaces
 */
export function findAllSessionsWithWorktrees(
  workspacePath: string,
  projectsDir: string = getClaudeProjectsDir(),
): string[] {
  const allPaths = new Set<string>();

  // Start with sessions from the given workspace
  for (const s of findAllSessions(workspacePath, projectsDir)) {
    allPaths.add(s);
  }

  // Then every worktree of its repository: the main checkout and the
  // linked worktrees, whichever of them the workspace is.
  const layout = resolveGitWorktrees(workspacePath);
  for (const worktree of layout?.worktrees ?? []) {
    if (worktree.kind === 'bare' || path.resolve(worktree.path) === path.resolve(workspacePath)) {
      continue;
    }
    for (const s of findAllSessions(worktree.path, projectsDir)) {
      allPaths.add(s);
    }
  }

  // Sort by mtime (most recent first)
  return Array.from(allPaths)
    .map((sessionPath) => {
      try {
        const stat = fs.statSync(sessionPath);
        return { path: sessionPath, mtime: stat.mtime.getTime() };
      } catch {
        return { path: sessionPath, mtime: 0 };
      }
    })
    .sort((a, b) => b.mtime - a.mtime)
    .map((f) => f.path);
}
