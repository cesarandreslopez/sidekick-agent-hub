/**
 * @fileoverview Type definitions for VS Code Git Extension API.
 *
 * These types are extracted from VS Code's built-in Git extension to enable
 * type-safe access to repository state and change information. We only include
 * the essential types needed by GitService, not the full 1000+ line API.
 *
 * @see https://github.com/microsoft/vscode/blob/main/extensions/git/src/api/git.d.ts
 */

import { Uri, Event } from 'vscode';

/**
 * Represents the status of a file in the repository.
 */
export const enum Status {
  INDEX_MODIFIED,
  INDEX_ADDED,
  INDEX_DELETED,
  INDEX_RENAMED,
  INDEX_COPIED,

  MODIFIED,
  DELETED,
  UNTRACKED,
  IGNORED,
  INTENT_TO_ADD,

  ADDED_BY_US,
  ADDED_BY_THEM,
  DELETED_BY_US,
  DELETED_BY_THEM,
  BOTH_ADDED,
  BOTH_DELETED,
  BOTH_MODIFIED,
}

/**
 * Represents a changed file.
 */
export interface Change {
  /**
   * Returns either `originalUri` or `renameUri`, depending
   * on whether this change is a rename change. When
   * in doubt, use this.
   */
  readonly uri: Uri;

  /**
   * Original URI of the file before the change.
   */
  readonly originalUri: Uri;

  /**
   * Renamed URI of the file after the change (if renamed).
   */
  readonly renameUri: Uri | undefined;

  /**
   * Status of the file.
   */
  readonly status: Status;
}

/**
 * Represents the state of a repository.
 */
export interface RepositoryState {
  /**
   * Changes in the index (staged).
   */
  readonly indexChanges: Change[];

  /**
   * Changes in the working tree (unstaged).
   */
  readonly workingTreeChanges: Change[];

  /**
   * Merge changes (conflicts).
   */
  readonly mergeChanges: Change[];

  /**
   * Current HEAD reference.
   */
  readonly HEAD: unknown | undefined;

  /**
   * Current branch name.
   */
  readonly remotes: unknown[];
}

/**
 * Fired when repository state changes.
 */
export interface RepositoryUIState {
  readonly selected: boolean;
}

/**
 * Input box for entering commit messages.
 */
export interface InputBox {
  /**
   * The commit message value.
   */
  value: string;
}

/**
 * Represents a Git repository.
 */
export interface Repository {
  /**
   * Root URI of the repository.
   */
  readonly rootUri: Uri;

  /**
   * Current state of the repository.
   */
  readonly state: RepositoryState;

  /**
   * UI state of the repository.
   */
  readonly ui: RepositoryUIState;

  /**
   * Input box for commit messages.
   */
  readonly inputBox: InputBox;

  /**
   * Fired when the repository state changes.
   */
  readonly onDidChangeState: Event<RepositoryState>;
}

/**
 * Git API interface exposing repositories.
 */
export interface API {
  /**
   * All known repositories.
   */
  readonly repositories: Repository[];

  /**
   * Fired when repositories change.
   */
  readonly onDidOpenRepository: Event<Repository>;
  readonly onDidCloseRepository: Event<Repository>;
}

/**
 * Git Extension interface.
 */
export interface GitExtension {
  /**
   * Whether the extension is enabled.
   */
  readonly enabled: boolean;

  /**
   * Get a specific version of the API.
   *
   * @param version - API version to get (currently only version 1)
   */
  getAPI(version: 1): API;
}
