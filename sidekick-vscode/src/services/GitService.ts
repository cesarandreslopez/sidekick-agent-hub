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
import * as path from 'path';
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
  /** The repository path where changes were found */
  repoPath: string;
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
   * Uses smart detection to find the most appropriate repository:
   * 1. Match active editor's file to a repository
   * 2. Last resort: first repository
   *
   * Note: For commit operations, use selectRepository() instead which
   * verifies actual diffs exist.
   *
   * @returns The active repository, or undefined if no repositories exist
   */
  getActiveRepository(): Repository | undefined {
    if (!this.api || this.api.repositories.length === 0) {
      return undefined;
    }

    // Single repo - no ambiguity
    if (this.api.repositories.length === 1) {
      return this.api.repositories[0];
    }

    // Try to match active editor's file to a repository
    const editor = vscode.window.activeTextEditor;
    if (editor) {
      const documentPath = editor.document.uri.fsPath;
      const matchingRepo = this.api.repositories.find((repo) =>
        documentPath.startsWith(repo.rootUri.fsPath),
      );
      if (matchingRepo) {
        log(`getActiveRepository: Matched editor to repo: ${matchingRepo.rootUri.fsPath}`);
        return matchingRepo;
      }
    }

    // Last resort: first repository
    log(
      `getActiveRepository: No editor match, using first repo: ${this.api.repositories[0].rootUri.fsPath}`,
    );
    return this.api.repositories[0];
  }

  /**
   * Checks if a repository has an actual non-empty diff (staged or unstaged).
   * This is more reliable than checking VS Code's state which can include
   * untracked files or submodule changes that don't produce diffs.
   *
   * @param repository - The repository to check
   * @returns Promise resolving to true if repo has actual diff content
   */
  private async hasActualDiff(repository: Repository): Promise<boolean> {
    try {
      // Check staged diff first
      const stagedDiff = await this.getDiff(repository, true);
      if (stagedDiff.trim().length > 0) {
        return true;
      }
      // Check unstaged diff
      const unstagedDiff = await this.getDiff(repository, false);
      return unstagedDiff.trim().length > 0;
    } catch {
      return false;
    }
  }

  /**
   * Selects a repository for commit-related operations with user interaction.
   *
   * Verifies repos have actual diffs (not just VS Code state which can include
   * untracked files). Uses smart detection and prompts user when ambiguous:
   * 1. Single repo: return it directly
   * 2. Check all repos for actual diffs
   * 3. If active editor matches a repo with diffs: use it
   * 4. Exactly one repo with diffs: use it
   * 5. Multiple repos with diffs: prompt user to select
   * 6. No repos with diffs: return undefined
   *
   * @returns Promise resolving to selected repository, or undefined if none available/selected
   */
  async selectRepository(): Promise<Repository | undefined> {
    if (!this.api || this.api.repositories.length === 0) {
      return undefined;
    }

    // Single repo - no ambiguity
    if (this.api.repositories.length === 1) {
      return this.api.repositories[0];
    }

    // Check which repos actually have diffs (not just VS Code state)
    log(`selectRepository: Checking ${this.api.repositories.length} repos for actual diffs`);
    const reposWithDiffs: Repository[] = [];
    for (const repo of this.api.repositories) {
      if (await this.hasActualDiff(repo)) {
        log(`selectRepository: Repo has actual diff: ${repo.rootUri.fsPath}`);
        reposWithDiffs.push(repo);
      }
    }

    // No repos with actual diffs
    if (reposWithDiffs.length === 0) {
      log('selectRepository: No repositories with actual diffs found');
      return undefined;
    }

    // If active editor matches a repo with diffs, prefer it
    const editor = vscode.window.activeTextEditor;
    if (editor) {
      const documentPath = editor.document.uri.fsPath;
      const matchingRepo = reposWithDiffs.find((repo) =>
        documentPath.startsWith(repo.rootUri.fsPath),
      );
      if (matchingRepo) {
        log(
          `selectRepository: Active editor matches repo with diff: ${matchingRepo.rootUri.fsPath}`,
        );
        return matchingRepo;
      }
    }

    // Exactly one repo with diffs - use it
    if (reposWithDiffs.length === 1) {
      log(`selectRepository: Single repo with diff: ${reposWithDiffs[0].rootUri.fsPath}`);
      return reposWithDiffs[0];
    }

    // Multiple repos with diffs - ask user
    log(`selectRepository: ${reposWithDiffs.length} repos with diffs, prompting user`);
    const items = reposWithDiffs.map((repo) => ({
      label: path.basename(repo.rootUri.fsPath),
      description: repo.rootUri.fsPath,
      repo,
    }));

    const selected = await vscode.window.showQuickPick(items, {
      placeHolder: 'Multiple repositories have changes. Select one:',
    });

    if (selected) {
      log(`selectRepository: User selected: ${selected.repo.rootUri.fsPath}`);
    } else {
      log('selectRepository: User cancelled selection');
    }

    return selected?.repo;
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
   * 1. Selects the appropriate repository (with user prompt if ambiguous)
   * 2. Checks for staged changes (preferred)
   * 3. Falls back to unstaged changes if nothing staged
   * 4. Returns null if no changes exist
   *
   * @returns Promise resolving to changes object or null if no changes
   */
  async getChangesForCommit(): Promise<ChangesForCommit | null> {
    try {
      const repository = await this.selectRepository();
      if (!repository) {
        log('No active repository found or no repositories with changes');
        return null;
      }

      const changes = this.hasChanges(repository);

      const repoPath = repository.rootUri.fsPath;

      // Prefer staged changes
      if (changes.staged) {
        const diff = await this.getDiff(repository, true);
        if (diff.trim().length === 0) {
          log('Staged changes exist but diff is empty');
          return null;
        }
        return { diff, type: 'staged', repoPath };
      }

      // Fall back to unstaged changes
      if (changes.unstaged) {
        const diff = await this.getDiff(repository, false);
        if (diff.trim().length === 0) {
          log('Unstaged changes exist but diff is empty');
          return null;
        }
        return { diff, type: 'unstaged', repoPath };
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
   * @param repoPath - Optional path to specific repository (use to ensure message goes to correct repo)
   * @returns Promise resolving to true if message was set, false if cancelled or no repo
   */
  async setCommitMessage(
    message: string,
    confirmOverwrite: boolean = true,
    repoPath?: string,
  ): Promise<boolean> {
    let repository: Repository | undefined;

    // If repoPath provided, find that specific repository
    if (repoPath && this.api) {
      repository = this.api.repositories.find((repo) => repo.rootUri.fsPath === repoPath);
      if (!repository) {
        log(`setCommitMessage: Repository not found for path: ${repoPath}`);
      }
    }

    // Fall back to active repository detection
    if (!repository) {
      repository = this.getActiveRepository();
    }

    if (!repository) {
      log('setCommitMessage: No repository found');
      return false;
    }

    log(`setCommitMessage: Using repository: ${repository.rootUri.fsPath}`);

    // Check if user has existing content
    const currentValue = repository.inputBox.value;
    if (confirmOverwrite && currentValue.trim().length > 0) {
      const choice = await vscode.window.showWarningMessage(
        'Replace existing commit message?',
        'Replace',
        'Cancel',
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
   * Executes a git command and returns the output.
   * Uses spawn to handle large outputs without buffer limits.
   *
   * @param repoPath - The repository root path (fsPath)
   * @param args - Git command arguments (without 'git' prefix)
   * @returns Promise resolving to command output
   * @throws Error if command fails
   */
  async execGit(repoPath: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      log(`Executing: git ${args.join(' ')} in ${repoPath}`);

      const gitProcess = spawn('git', args, { cwd: repoPath, shell: true });

      const chunks: Buffer[] = [];
      const errorChunks: Buffer[] = [];

      gitProcess.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
      gitProcess.stderr.on('data', (chunk: Buffer) => errorChunks.push(chunk));

      gitProcess.on('close', (code) => {
        if (code !== 0) {
          const errorText = Buffer.concat(errorChunks).toString('utf8');
          reject(new Error(`git ${args[0]} failed: ${errorText}`));
          return;
        }
        resolve(Buffer.concat(chunks).toString('utf8'));
      });

      gitProcess.on('error', (error) => reject(error));
    });
  }

  /**
   * Gets commit messages on current branch that aren't on base branch.
   * Uses: git log base..HEAD --format=%s
   *
   * @param repository - The repository
   * @param baseBranch - Base branch to compare against (default: 'main')
   * @returns Promise resolving to array of commit subject lines
   */
  async getBranchCommits(repository: Repository, baseBranch: string = 'main'): Promise<string[]> {
    try {
      const output = await this.execGit(repository.rootUri.fsPath, [
        'log',
        `${baseBranch}..HEAD`,
        '--format=%s', // Subject line only
      ]);

      // Split by newlines, filter empty
      const commits = output
        .trim()
        .split('\n')
        .filter((line) => line.length > 0);
      log(`Found ${commits.length} commits on branch vs ${baseBranch}`);
      return commits;
    } catch (error) {
      logError(`getBranchCommits failed`, error);
      return [];
    }
  }

  /**
   * Gets the diff between current branch and base branch.
   * Uses: git diff base...HEAD (triple-dot = since common ancestor)
   *
   * @param repository - The repository
   * @param baseBranch - Base branch to compare against (default: 'main')
   * @returns Promise resolving to diff text
   */
  async getBranchDiff(repository: Repository, baseBranch: string = 'main'): Promise<string> {
    try {
      const diff = await this.execGit(repository.rootUri.fsPath, [
        'diff',
        `${baseBranch}...HEAD`, // Triple-dot: compare since divergence
      ]);
      log(`Branch diff: ${diff.length} characters vs ${baseBranch}`);
      return diff;
    } catch (error) {
      logError(`getBranchDiff failed`, error);
      return '';
    }
  }

  /**
   * Disposes of all resources.
   *
   * Cleans up any event listeners or resources.
   */
  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
  }
}
