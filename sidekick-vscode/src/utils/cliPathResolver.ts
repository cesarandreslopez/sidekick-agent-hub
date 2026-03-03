/**
 * @fileoverview Shared CLI path discovery utility.
 *
 * Consolidates the duplicated path-resolution pattern used by
 * MaxSubscriptionClient (claude), CodexClient (codex), and
 * SidekickCliService (sidekick).
 *
 * @module utils/cliPathResolver
 */

import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { execFileSync } from 'child_process';
import { log } from '../services/Logger';

/** Cache of resolved CLI paths (cleared only by `clearCliCache`). */
const resolvedPaths = new Map<string, string>();

/**
 * Clears the cached CLI path for a given binary name (or all if omitted).
 * Useful when user changes the configured path in settings.
 */
export function clearCliCache(binaryName?: string): void {
  if (binaryName) {
    resolvedPaths.delete(binaryName);
  } else {
    resolvedPaths.clear();
  }
}

/**
 * Resolves a command name to its absolute path using the system's PATH.
 * Uses `which` on Unix, `where` on Windows — via `execFileSync` (no shell).
 *
 * @param command - The command name to resolve (e.g., 'claude', 'codex')
 * @returns The absolute path to the command, or null if not found
 */
export function resolveCommandPath(command: string): string | null {
  try {
    const isWindows = process.platform === 'win32';
    const bin = isWindows ? 'where' : 'which';
    const result = execFileSync(bin, [command], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
      timeout: 5000,
    });
    const resolved = result.trim().split(/\r?\n/)[0];
    if (resolved) {
      log(`Resolved '${command}' from PATH: ${resolved}`);
      return resolved;
    }
  } catch {
    // Command not found in PATH
  }
  return null;
}

/**
 * Returns common installation paths for a CLI tool.
 *
 * Covers: npm global, pnpm global, yarn global, volta, system paths,
 * macOS Homebrew, and Windows-specific locations.
 *
 * @param binaryName - The binary name without extension (e.g., 'claude')
 * @param extraPaths - Additional platform-specific paths to prepend
 */
export function getCommonCliPaths(binaryName: string, extraPaths: string[] = []): string[] {
  const homeDir = os.homedir();
  const isWindows = process.platform === 'win32';
  const ext = isWindows ? '.cmd' : '';
  const bin = `${binaryName}${ext}`;

  return [
    ...extraPaths,
    // npm global
    path.join(homeDir, '.npm-global', 'bin', bin),
    path.join(homeDir, 'npm-global', 'bin', bin),
    // pnpm global
    path.join(homeDir, '.local', 'share', 'pnpm', bin),
    path.join(homeDir, 'Library', 'pnpm', bin),
    // yarn global
    path.join(homeDir, '.yarn', 'bin', bin),
    // volta
    path.join(homeDir, '.volta', 'bin', bin),
    // Linux local bin
    path.join(homeDir, '.local', 'bin', bin),
    // System paths
    `/usr/local/bin/${binaryName}`,
    `/usr/bin/${binaryName}`,
    // macOS Homebrew
    `/opt/homebrew/bin/${binaryName}`,
    // Windows npm/pnpm global
    ...(isWindows ? [
      path.join(process.env.APPDATA || '', 'npm', `${binaryName}.cmd`),
      path.join(process.env.LOCALAPPDATA || '', 'pnpm', `${binaryName}.cmd`),
    ] : []),
  ];
}

export interface FindCliOptions {
  /** Binary name without extension (e.g., 'claude'). */
  binaryName: string;
  /** User-configured path from VS Code settings (may be empty/undefined). */
  configuredPath?: string;
  /** Additional platform-specific candidate paths (prepended to common paths). */
  extraPaths?: string[];
}

/**
 * Finds a CLI executable using the standard three-step discovery:
 * 1. Check user-configured path
 * 2. Check common installation paths
 * 3. Resolve from system PATH
 *
 * @returns The absolute path to the executable, or null if not found
 */
export function findCli(options: FindCliOptions): string | null {
  const { binaryName, configuredPath, extraPaths } = options;

  // Return cached result if available
  const cached = resolvedPaths.get(binaryName);
  if (cached) return cached;

  // 1. Check user-configured path
  if (configuredPath && configuredPath.trim() !== '') {
    const expandedPath = configuredPath.replace(/^~/, os.homedir());
    if (fs.existsSync(expandedPath)) {
      log(`Using configured ${binaryName} path: ${expandedPath}`);
      resolvedPaths.set(binaryName, expandedPath);
      return expandedPath;
    }
    log(`Configured ${binaryName} path not found: ${expandedPath}`);
  }

  // 2. Check common installation paths
  for (const candidatePath of getCommonCliPaths(binaryName, extraPaths)) {
    // Skip glob patterns (nvm paths with **)
    if (candidatePath.includes('**')) continue;

    if (fs.existsSync(candidatePath)) {
      log(`Found ${binaryName} at: ${candidatePath}`);
      resolvedPaths.set(binaryName, candidatePath);
      return candidatePath;
    }
  }

  // 3. Resolve from PATH
  log(`${binaryName} not found in common paths, resolving from PATH...`);
  const resolved = resolveCommandPath(binaryName);
  if (resolved) {
    resolvedPaths.set(binaryName, resolved);
    return resolved;
  }

  log(`${binaryName} not found anywhere`);
  return null;
}
