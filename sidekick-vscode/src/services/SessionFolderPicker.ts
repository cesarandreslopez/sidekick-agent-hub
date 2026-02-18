/**
 * @fileoverview Session folder picker for manual session selection.
 *
 * This module provides UI for browsing and selecting session folders
 * from the active session provider, allowing users to monitor sessions
 * that aren't automatically detected based on the current workspace.
 *
 * @module services/SessionFolderPicker
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { SessionMonitor } from './SessionMonitor';
import type { ProjectFolderInfo } from '../types/sessionProvider';
import { log } from './Logger';

/**
 * Formats a relative time string (e.g., "5m ago", "2h ago", "3d ago").
 */
function formatRelativeTime(date: Date): string {
  const now = Date.now();
  const diffMs = now - date.getTime();
  const diffMinutes = Math.floor(diffMs / (1000 * 60));
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffMinutes < 1) {
    return 'just now';
  } else if (diffMinutes < 60) {
    return `${diffMinutes}m ago`;
  } else if (diffHours < 24) {
    return `${diffHours}h ago`;
  } else {
    return `${diffDays}d ago`;
  }
}

/**
 * Service for browsing and selecting Claude Code session folders.
 *
 * Provides VS Code QuickPick UI for navigating project folders and sessions,
 * allowing users to manually select which session to monitor.
 *
 * @example
 * ```typescript
 * const picker = new SessionFolderPicker(sessionMonitor, workspaceState);
 *
 * // Show folder picker and start monitoring
 * const success = await picker.selectAndMonitorSession();
 * if (success) {
 *   console.log('Session monitoring started');
 * }
 * ```
 */
export class SessionFolderPicker {
  constructor(
    private readonly sessionMonitor: SessionMonitor,
    private readonly workspaceState: vscode.Memento
  ) {}

  /**
   * Shows a quick pick of all project folders for the active provider.
   *
   * Displays provider folders with session counts and last activity times.
   * Prioritizes the current workspace and its subdirectories at the top of the list.
   *
   * @returns Selected folder path, or undefined if cancelled
   */
  async showFolderPicker(): Promise<string | undefined> {
    // Pass workspace path for prioritized sorting
    const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const provider = this.sessionMonitor.getProvider();
    const folders = provider.getAllProjectFolders(workspacePath);

    if (folders.length === 0) {
      vscode.window.showInformationMessage(
        `No ${provider.displayName} sessions found. Start ${provider.displayName} in any directory to create sessions.`
      );
      return undefined;
    }

    const items = folders.map((folder: ProjectFolderInfo) => ({
      label: folder.name,
      description: `${folder.sessionCount} session${folder.sessionCount !== 1 ? 's' : ''}, active ${formatRelativeTime(folder.lastModified)}`,
      detail: folder.encodedName || folder.dir,
      folder
    }));

    const selected = await vscode.window.showQuickPick(items, {
      placeHolder: `Select a ${provider.displayName} project folder to monitor`,
      matchOnDescription: true,
      matchOnDetail: true
    });

    return selected?.folder.dir;
  }

  /**
   * Shows a quick pick of sessions within a folder.
   *
   * @param folderPath - Path to the session folder
   * @returns Selected session file path, or undefined if cancelled
   */
  async showSessionPicker(folderPath: string): Promise<string | undefined> {
    const provider = this.sessionMonitor.getProvider();
    const sessions = provider.findSessionsInDirectory(folderPath);

    if (sessions.length === 0) {
      vscode.window.showInformationMessage('No sessions found in this folder.');
      return undefined;
    }

    const items = await Promise.all(sessions.map(async (sessionPath) => {
      const filename = provider.getSessionId(sessionPath);
      let modifiedTime: Date;

      try {
        const stats = await vscode.workspace.fs.stat(vscode.Uri.file(sessionPath));
        modifiedTime = new Date(stats.mtime);
      } catch {
        modifiedTime = new Date();
      }

      return {
        label: filename,
        description: formatRelativeTime(modifiedTime),
        detail: sessionPath,
        sessionPath
      };
    }));

    const selected = await vscode.window.showQuickPick(items, {
      placeHolder: 'Select a session to monitor',
      matchOnDescription: true
    });

    return selected?.sessionPath;
  }

  /**
   * Combined flow: pick folder, then pick session, then start monitoring.
   *
   * Guides the user through selecting a project folder and session,
   * then starts monitoring the selected session. Persists the selection
   * for future VS Code restarts.
   *
   * @returns True if monitoring started successfully
   */
  async selectAndMonitorSession(): Promise<boolean> {
    // Step 1: Pick a folder
    const folderPath = await this.showFolderPicker();
    if (!folderPath) {
      return false;
    }

    // Step 2: Pick a session within the folder
    const sessionPath = await this.showSessionPicker(folderPath);
    if (!sessionPath) {
      return false;
    }

    // Step 3: Start monitoring with custom path
    log(`User selected session: ${sessionPath}`);

    try {
      // Start with the custom path (persists the directory)
      const success = await this.sessionMonitor.startWithCustomPath(path.dirname(sessionPath));

      if (success) {
        // Switch to the specific session if needed
        const currentPath = this.sessionMonitor.getSessionPath();
        if (currentPath !== sessionPath) {
          await this.sessionMonitor.switchToSession(sessionPath);
        }

        vscode.window.showInformationMessage(
          `Now monitoring session from: ${path.basename(path.dirname(sessionPath))}`,
          'Reset to Auto-Detect'
        ).then(action => {
          if (action === 'Reset to Auto-Detect') {
            vscode.commands.executeCommand('sidekick.clearCustomSessionPath');
          }
        });

        return true;
      } else {
        vscode.window.showWarningMessage('Failed to start monitoring the selected session.');
        return false;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      vscode.window.showErrorMessage(`Failed to start session monitoring: ${message}`);
      return false;
    }
  }
}
