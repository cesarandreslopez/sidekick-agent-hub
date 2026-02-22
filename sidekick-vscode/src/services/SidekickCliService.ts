/**
 * @fileoverview Service for launching the Sidekick CLI dashboard in a VS Code terminal.
 *
 * Handles CLI binary detection (config → common paths → PATH) and terminal lifecycle
 * management. This is the extension's first use of `vscode.window.createTerminal()`.
 *
 * @module SidekickCliService
 */

import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { execSync } from 'child_process';
import { log } from './Logger';

const TERMINAL_NAME = 'Sidekick Dashboard';
const DOCS_URL = 'https://github.com/cesarandreslopez/sidekick-agent-hub';
const NPM_PACKAGE = 'sidekick-agent-hub';

let dashboardTerminal: vscode.Terminal | undefined;

/**
 * Common installation paths for the Sidekick CLI on different platforms.
 * Mirrors the pattern from MaxSubscriptionClient's getCommonClaudePaths().
 */
function getCommonSidekickPaths(): string[] {
  const homeDir = os.homedir();
  const isWindows = process.platform === 'win32';
  const ext = isWindows ? '.cmd' : '';
  const bin = `sidekick${ext}`;

  return [
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
    '/usr/local/bin/sidekick',
    '/usr/bin/sidekick',
    // macOS Homebrew
    '/opt/homebrew/bin/sidekick',
    // Windows npm/pnpm global
    ...(isWindows ? [
      path.join(process.env.APPDATA || '', 'npm', 'sidekick.cmd'),
      path.join(process.env.LOCALAPPDATA || '', 'pnpm', 'sidekick.cmd'),
    ] : []),
  ];
}

/**
 * Resolves 'sidekick' from the system PATH to an absolute path.
 * Uses `which` on Unix, `where` on Windows.
 */
function resolveFromPath(): string | null {
  try {
    const isWindows = process.platform === 'win32';
    const cmd = isWindows ? 'where sidekick' : 'which sidekick';
    const result = execSync(cmd, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    const resolved = result.trim().split(/\r?\n/)[0];
    if (resolved && fs.existsSync(resolved)) {
      log(`Resolved 'sidekick' from PATH: ${resolved}`);
      return resolved;
    }
  } catch {
    // Not found in PATH
  }
  return null;
}

/**
 * Finds the Sidekick CLI executable path.
 *
 * Checks in order:
 * 1. User-configured path (`sidekick.sidekickCliPath` setting)
 * 2. Common installation paths (npm/pnpm/yarn/volta globals, system paths)
 * 3. Resolves 'sidekick' from system PATH
 *
 * @returns The absolute path to the sidekick executable, or null if not found
 */
export function findSidekickCli(): string | null {
  // 1. Check user-configured path
  const config = vscode.workspace.getConfiguration('sidekick');
  const configuredPath = config.get<string>('sidekickCliPath');

  if (configuredPath && configuredPath.trim() !== '') {
    const expandedPath = configuredPath.replace(/^~/, os.homedir());
    if (fs.existsSync(expandedPath)) {
      log(`Using configured sidekick CLI path: ${expandedPath}`);
      return expandedPath;
    }
    log(`Configured sidekick CLI path not found: ${expandedPath}`);
  }

  // 2. Check common installation paths
  for (const candidatePath of getCommonSidekickPaths()) {
    if (fs.existsSync(candidatePath)) {
      log(`Found sidekick CLI at: ${candidatePath}`);
      return candidatePath;
    }
  }

  // 3. Resolve from PATH
  log('Sidekick CLI not found in common paths, resolving from PATH...');
  const resolved = resolveFromPath();
  if (resolved) {
    return resolved;
  }

  log('Sidekick CLI not found anywhere');
  return null;
}

export interface OpenCliDashboardOptions {
  workspacePath?: string;
  providerId?: string;
}

/**
 * Opens the Sidekick CLI dashboard in a VS Code integrated terminal.
 *
 * If a dashboard terminal already exists and hasn't exited, it is revealed.
 * Otherwise a new terminal is created with the CLI as the shell process,
 * so the terminal closes cleanly when the TUI exits.
 */
export function openCliDashboard(options?: OpenCliDashboardOptions): void {
  const cliPath = findSidekickCli();

  if (!cliPath) {
    showNotInstalledError();
    return;
  }

  // Reuse existing terminal if still alive
  if (dashboardTerminal && dashboardTerminal.exitStatus === undefined) {
    dashboardTerminal.show();
    return;
  }

  // Build args
  const args = ['dashboard'];
  if (options?.workspacePath) {
    args.push('--project', options.workspacePath);
  }
  if (options?.providerId) {
    args.push('--provider', options.providerId);
  }

  dashboardTerminal = vscode.window.createTerminal({
    name: TERMINAL_NAME,
    shellPath: cliPath,
    shellArgs: args,
  });
  dashboardTerminal.show();
}

/**
 * Shows an error notification when the Sidekick CLI is not installed,
 * with buttons to install or learn more.
 */
function showNotInstalledError(): void {
  vscode.window
    .showErrorMessage(
      'Sidekick CLI not found. Install sidekick-agent-hub to use the CLI dashboard.',
      'Install in Terminal',
      'Learn More'
    )
    .then((choice) => {
      if (choice === 'Install in Terminal') {
        const installTerminal = vscode.window.createTerminal({ name: 'Install Sidekick CLI' });
        installTerminal.sendText(`npm install -g ${NPM_PACKAGE}`);
        installTerminal.show();
      } else if (choice === 'Learn More') {
        vscode.env.openExternal(vscode.Uri.parse(DOCS_URL));
      }
    });
}

/**
 * Disposes the dashboard terminal if it exists.
 * Call from extension deactivate().
 */
export function disposeDashboardTerminal(): void {
  if (dashboardTerminal) {
    dashboardTerminal.dispose();
    dashboardTerminal = undefined;
  }
}
