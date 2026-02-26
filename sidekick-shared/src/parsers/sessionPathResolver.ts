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
export function getAllProjectFolders(workspacePath?: string): ProjectFolderInfo[] {
  const projectsDir = path.join(os.homedir(), '.claude', 'projects');
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
        const sessionFiles = fs.readdirSync(fullPath)
          .filter(f => f.endsWith('.jsonl'));

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
          lastModified
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
  try {
    if (!fs.existsSync(sessionDir)) {
      return [];
    }

    const files = fs.readdirSync(sessionDir)
      .filter(file => file.endsWith('.jsonl'))
      .map(file => {
        const fullPath = path.join(sessionDir, file);
        try {
          const stats = fs.statSync(fullPath);
          return {
            path: fullPath,
            mtime: stats.mtime.getTime(),
            size: stats.size
          };
        } catch {
          return null;
        }
      })
      .filter((f): f is { path: string; mtime: number; size: number } => f !== null && f.size > 0)
      .sort((a, b) => b.mtime - a.mtime)
      .map(f => f.path);

    return files;
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
 * Git worktrees have a .git file (not directory) containing a gitdir: pointer.
 * This function reads that file and resolves the main repo path.
 *
 * @param workspacePath - Absolute path to workspace directory
 * @returns Main repository path, or null if not a worktree
 */
export function resolveWorktreeMainRepo(workspacePath: string): string | null {
  const gitPath = path.join(workspacePath, '.git');
  try {
    const stat = fs.statSync(gitPath);
    if (stat.isDirectory()) {
      // Regular repo, not a worktree
      return null;
    }
    // It's a file — this is a worktree
    const content = fs.readFileSync(gitPath, 'utf-8').trim();
    const match = content.match(/^gitdir:\s*(.+)$/m);
    if (!match) return null;

    const gitdir = match[1].trim();
    // gitdir points to something like /main-repo/.git/worktrees/<name>
    // Resolve to absolute path
    const resolvedGitdir = path.isAbsolute(gitdir)
      ? gitdir
      : path.resolve(workspacePath, gitdir);

    // Navigate up from .git/worktrees/<name> to the main repo
    const worktreesDir = path.dirname(resolvedGitdir);
    if (path.basename(worktreesDir) !== 'worktrees') return null;
    const dotGit = path.dirname(worktreesDir);
    if (path.basename(dotGit) !== '.git') return null;
    return path.dirname(dotGit);
  } catch {
    return null;
  }
}

/**
 * Discovers all worktree sibling paths for a main repository.
 *
 * Reads .git/worktrees/{name}/gitdir to find all worktree paths.
 *
 * @param mainRepoPath - Absolute path to the main repository
 * @returns Array of absolute paths to worktree working directories
 */
export function discoverWorktreeSiblings(mainRepoPath: string): string[] {
  const worktreesDir = path.join(mainRepoPath, '.git', 'worktrees');
  const siblings: string[] = [];

  try {
    if (!fs.existsSync(worktreesDir)) return siblings;
    const entries = fs.readdirSync(worktreesDir);

    for (const entry of entries) {
      const gitdirFile = path.join(worktreesDir, entry, 'gitdir');
      try {
        const content = fs.readFileSync(gitdirFile, 'utf-8').trim();
        // gitdir file contains path to the worktree's .git file
        // which is the worktree working directory + /.git
        const worktreeGit = path.isAbsolute(content)
          ? content
          : path.resolve(worktreesDir, entry, content);
        const worktreeDir = path.dirname(worktreeGit);
        if (fs.existsSync(worktreeDir)) {
          siblings.push(worktreeDir);
        }
      } catch {
        // Skip entries without gitdir
      }
    }
  } catch {
    // worktrees dir doesn't exist or isn't readable
  }

  return siblings;
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
export function findAllSessionsWithWorktrees(workspacePath: string): string[] {
  const allPaths = new Set<string>();

  // Start with sessions from the given workspace
  for (const s of findAllSessions(workspacePath)) {
    allPaths.add(s);
  }

  // Check if this is a worktree
  const mainRepo = resolveWorktreeMainRepo(workspacePath);
  if (mainRepo) {
    // Add sessions from the main repo
    for (const s of findAllSessions(mainRepo)) {
      allPaths.add(s);
    }
    // Add sessions from sibling worktrees
    for (const sibling of discoverWorktreeSiblings(mainRepo)) {
      if (sibling !== workspacePath) {
        for (const s of findAllSessions(sibling)) {
          allPaths.add(s);
        }
      }
    }
  } else {
    // This might be the main repo — check for worktrees
    const siblings = discoverWorktreeSiblings(workspacePath);
    for (const sibling of siblings) {
      for (const s of findAllSessions(sibling)) {
        allPaths.add(s);
      }
    }
  }

  // Sort by mtime (most recent first)
  return Array.from(allPaths)
    .map(sessionPath => {
      try {
        const stat = fs.statSync(sessionPath);
        return { path: sessionPath, mtime: stat.mtime.getTime() };
      } catch {
        return { path: sessionPath, mtime: 0 };
      }
    })
    .sort((a, b) => b.mtime - a.mtime)
    .map(f => f.path);
}
