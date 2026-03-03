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
import { findCli } from '../utils/cliPathResolver';

const TERMINAL_NAME = 'Sidekick Dashboard';
const DOCS_URL = 'https://github.com/cesarandreslopez/sidekick-agent-hub';
const NPM_PACKAGE = 'sidekick-agent-hub';
const EXTENSION_ID = 'CesarAndresLopez.sidekick-for-max';

let dashboardTerminal: vscode.Terminal | undefined;
let versionCheckDone = false;

/**
 * Extra nvm-specific paths for the Sidekick CLI.
 * Enumerates actual nvm node versions (most recent first).
 */
function getNvmSidekickPaths(): string[] {
  const nvmDir = path.join(os.homedir(), '.nvm', 'versions', 'node');
  if (process.platform === 'win32' || !fs.existsSync(nvmDir)) return [];
  try {
    return fs.readdirSync(nvmDir).sort().reverse()
      .map(v => path.join(nvmDir, v, 'bin', 'sidekick'));
  } catch {
    return [];
  }
}

/**
 * Finds the Sidekick CLI executable path.
 *
 * Checks in order:
 * 1. User-configured path (`sidekick.sidekickCliPath` setting)
 * 2. nvm paths + common installation paths
 * 3. Resolves 'sidekick' from system PATH
 *
 * @returns The absolute path to the sidekick executable, or null if not found
 */
export function findSidekickCli(): string | null {
  const config = vscode.workspace.getConfiguration('sidekick');
  return findCli({
    binaryName: 'sidekick',
    configuredPath: config.get<string>('sidekickCliPath'),
    extraPaths: getNvmSidekickPaths(),
  });
}

export interface CliVersionCheck {
  cliVersion: string;
  extensionVersion: string;
  needsUpdate: boolean;
}

/**
 * Checks the installed CLI version against the extension version.
 * Returns null on any error (CLI not found, version parse failure, etc.).
 */
export function checkCliVersion(cliPath: string): CliVersionCheck | null {
  try {
    const output = execSync(`"${cliPath}" --version`, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
      timeout: 5000,
    }).trim();

    // Parse version — output may be just "0.12.0" or "sidekick/0.12.0"
    const match = output.match(/(\d+\.\d+\.\d+)/);
    if (!match) return null;
    const cliVersion = match[1];

    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    const extensionVersion: string = ext?.packageJSON?.version;
    if (!extensionVersion) return null;

    return {
      cliVersion,
      extensionVersion,
      needsUpdate: isNewer(extensionVersion, cliVersion),
    };
  } catch {
    return null;
  }
}

/**
 * Returns true if version `a` is newer than version `b` (simple semver).
 */
export function isNewer(a: string, b: string): boolean {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const va = pa[i] || 0;
    const vb = pb[i] || 0;
    if (va > vb) return true;
    if (va < vb) return false;
  }
  return false;
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

  // One-time version check per session (non-blocking)
  if (!versionCheckDone) {
    versionCheckDone = true;
    const result = checkCliVersion(cliPath);
    if (result?.needsUpdate) {
      vscode.window
        .showInformationMessage(
          `Sidekick CLI v${result.cliVersion} is outdated (extension is v${result.extensionVersion}). Update for the best experience.`,
          'Update Now',
          'Later',
        )
        .then((choice) => {
          if (choice === 'Update Now') {
            const t = vscode.window.createTerminal({ name: 'Update Sidekick CLI' });
            t.sendText(`npm install -g ${NPM_PACKAGE}`);
            t.show();
          }
        });
    }
  }

  // Build args
  const args = ['dashboard'];
  if (options?.workspacePath) {
    args.push('--project', options.workspacePath);
  }
  if (options?.providerId) {
    args.push('--provider', options.providerId);
  }

  // Inject the CLI's directory into PATH so the node binary (co-located in
  // nvm/volta/etc. bin dirs) is found when the shim uses #!/usr/bin/env node.
  // Without this, shellPath bypasses shell init and node may not be in PATH.
  const cliDir = path.dirname(cliPath);
  const env: Record<string, string> = {};
  if (cliDir && cliDir !== '.') {
    env['PATH'] = `${cliDir}${path.delimiter}${process.env.PATH || ''}`;
  }

  dashboardTerminal = vscode.window.createTerminal({
    name: TERMINAL_NAME,
    shellPath: cliPath,
    shellArgs: args,
    env,
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
  versionCheckDone = false;
}
