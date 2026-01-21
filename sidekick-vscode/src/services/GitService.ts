/**
 * @fileoverview Git integration service for repository and diff access.
 *
 * GitService provides access to the VS Code Git Extension API to detect
 * repositories, enumerate changes, and retrieve diff text for commit message
 * generation. It gracefully handles the case where Git extension is unavailable.
 *
 * @module GitService
 */

import * as vscode from 'vscode';
import { spawn } from 'child_process';
import { API, GitExtension, Repository } from '../api/git';
import { log, logError } from './Logger';

/**
 * Result from getChangesForCommit operation.
 */
export interface ChangesForCommit {
  /** The diff text */
  diff: string;
  /** Whether the diff is from staged or unstaged changes */
  type: 'staged' | 'unstaged';
}

/**
 * Git integration service.
 *
 * This service:
 * - Connects to VS Code's built-in Git extension API
 * - Detects the active repository for the current workspace
 * - Retrieves diff text for staged or unstaged changes
 * - Falls back gracefully when Git extension is unavailable
 *
 * @example
 * ```typescript
 * const gitService = new GitService();
 * const initialized = await gitService.initialize();
 * if (initialized) {
 *   const changes = await gitService.getChangesForCommit();
 *   if (changes) {
 *     console.log(`Got ${changes.type} diff: ${changes.diff.length} chars`);
 *   }
 * }
 * ```
 */
export class GitService implements vscode.Disposable {
  /** Git Extension API instance */
  private api: API | undefined;

  /** Disposables to clean up on dispose */
  private disposables: vscode.Disposable[] = [];

  /**
   * Initializes the Git service by connecting to the Git extension.
   *
   * This method attempts to:
   * 1. Get the 'vscode.git' extension
   * 2. Activate it if not already active
   * 3. Get API version 1
   *
   * @returns Promise resolving to true if Git extension is available, false otherwise
   */
  async initialize(): Promise<boolean> {
    try {
      const extension = vscode.extensions.getExtension<GitExtension>('vscode.git');
      if (!extension) {
        log('Git extension not found');
        return false;
      }

      // Activate if not already active
      if (!extension.isActive) {
        log('Activating Git extension');
        await extension.activate();
      }

      // Get API version 1
      const gitExtension = extension.exports;
      if (!gitExtension.enabled) {
        log('Git extension is disabled');
        return false;
      }

      this.api = gitExtension.getAPI(1);
      log('Git service initialized successfully');
      return true;
    } catch (error) {
      logError('Failed to initialize Git service', error);
      return false;
    }
  }

  /**
   * Gets the active repository for the current workspace.
   *
   * Attempts to match the active editor's file to a repository. If no editor
   * is active or no match is found, returns the first repository.
   *
   * @returns The active repository, or undefined if no repositories exist
   */
  getActiveRepository(): Repository | undefined {
    if (!this.api || this.api.repositories.length === 0) {
      return undefined;
    }

    // Try to match active editor's file to a repository
    const editor = vscode.window.activeTextEditor;
    if (editor) {
      const documentPath = editor.document.uri.fsPath;
      const matchingRepo = this.api.repositories.find(repo =>
        documentPath.startsWith(repo.rootUri.fsPath)
      );
      if (matchingRepo) {
        return matchingRepo;
      }
    }

    // Fallback to first repository
    return this.api.repositories[0];
  }

  /**
   * Checks if a repository has changes.
   *
   * @param repository - The repository to check
   * @returns Object indicating whether there are staged and/or unstaged changes
   */
  hasChanges(repository: Repository): { staged: boolean; unstaged: boolean } {
    return {
      staged: repository.state.indexChanges.length > 0,
      unstaged: repository.state.workingTreeChanges.length > 0,
    };
  }

  /**
   * Gets diff text for staged or unstaged changes.
   *
   * Uses `git diff` command via child_process.spawn to retrieve diff text.
   * Spawn is used instead of exec to handle large diffs without buffer limits.
   *
   * @param repository - The repository to get diff from
   * @param useStaged - Whether to get staged (true) or unstaged (false) changes
   * @returns Promise resolving to diff text
   */
  async getDiff(repository: Repository, useStaged: boolean): Promise<string> {
    return new Promise((resolve, reject) => {
      try {
        const args = useStaged ? ['diff', '--cached'] : ['diff'];
        const cwd = repository.rootUri.fsPath;

        log(`Getting ${useStaged ? 'staged' : 'unstaged'} diff from ${cwd}`);

        const gitProcess = spawn('git', args, {
          cwd,
          shell: true,
        });

        const chunks: Buffer[] = [];
        const errorChunks: Buffer[] = [];

        gitProcess.stdout.on('data', (chunk: Buffer) => {
          chunks.push(chunk);
        });

        gitProcess.stderr.on('data', (chunk: Buffer) => {
          errorChunks.push(chunk);
        });

        gitProcess.on('close', (code) => {
          if (code !== 0) {
            const errorText = Buffer.concat(errorChunks).toString('utf8');
            logError(`git diff exited with code ${code}`, new Error(errorText));
            reject(new Error(`git diff failed: ${errorText}`));
            return;
          }

          const diff = Buffer.concat(chunks).toString('utf8');
          log(`Retrieved diff: ${diff.length} characters`);
          resolve(diff);
        });

        gitProcess.on('error', (error) => {
          logError('Failed to spawn git process', error);
          reject(error);
        });
      } catch (error) {
        logError('getDiff error', error);
        reject(error);
      }
    });
  }

  /**
   * Gets changes for commit message generation.
   *
   * This is the main method for retrieving diff text. It:
   * 1. Gets the active repository
   * 2. Checks for staged changes (preferred)
   * 3. Falls back to unstaged changes if nothing staged
   * 4. Returns null if no changes exist
   *
   * @returns Promise resolving to changes object or null if no changes
   */
  async getChangesForCommit(): Promise<ChangesForCommit | null> {
    try {
      const repository = this.getActiveRepository();
      if (!repository) {
        log('No active repository found');
        return null;
      }

      const changes = this.hasChanges(repository);

      // Prefer staged changes
      if (changes.staged) {
        const diff = await this.getDiff(repository, true);
        if (diff.trim().length === 0) {
          log('Staged changes exist but diff is empty');
          return null;
        }
        return { diff, type: 'staged' };
      }

      // Fall back to unstaged changes
      if (changes.unstaged) {
        const diff = await this.getDiff(repository, false);
        if (diff.trim().length === 0) {
          log('Unstaged changes exist but diff is empty');
          return null;
        }
        return { diff, type: 'unstaged' };
      }

      log('No changes found in repository');
      return null;
    } catch (error) {
      logError('getChangesForCommit failed', error);
      return null;
    }
  }

  /**
   * Sets the commit message in the SCM input box.
   *
   * This method accesses the repository's inputBox property from the Git Extension
   * API and sets its value directly. Optionally confirms with user if existing
   * content would be overwritten.
   *
   * @param message - The commit message to set
   * @param confirmOverwrite - If true and input box has content, ask user to confirm (default: true)
   * @returns Promise resolving to true if message was set, false if cancelled or no repo
   */
  async setCommitMessage(message: string, confirmOverwrite: boolean = true): Promise<boolean> {
    const repository = this.getActiveRepository();
    if (!repository) {
      log('setCommitMessage: No active repository');
      return false;
    }

    // Check if user has existing content
    const currentValue = repository.inputBox.value;
    if (confirmOverwrite && currentValue.trim().length > 0) {
      const choice = await vscode.window.showWarningMessage(
        'Replace existing commit message?',
        'Replace',
        'Cancel'
      );
      if (choice !== 'Replace') {
        log('setCommitMessage: User cancelled overwrite');
        return false;
      }
    }

    repository.inputBox.value = message;
    log(`setCommitMessage: Set message to "${message}"`);

    // Focus SCM view to show the message
    await vscode.commands.executeCommand('workbench.view.scm');
    return true;
  }

  /**
   * Disposes of all resources.
   *
   * Cleans up any event listeners or resources.
   */
  dispose(): void {
    this.disposables.forEach(d => d.dispose());
  }
}
