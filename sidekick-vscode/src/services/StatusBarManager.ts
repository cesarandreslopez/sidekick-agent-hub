/**
 * @fileoverview Centralized status bar state management for Sidekick.
 *
 * StatusBarManager provides a multi-state status bar with proper visual feedback
 * for connected, disconnected, loading, and error states. Also handles the
 * completion hint highlight after typing stops.
 *
 * @module StatusBarManager
 */

import * as vscode from 'vscode';

/**
 * Connection state for the Sidekick extension.
 *
 * - 'connected': Idle, inline completions are enabled
 * - 'disconnected': Idle, inline completions are disabled
 * - 'loading': API operation in progress
 * - 'error': Last operation failed
 */
export type ConnectionState = 'connected' | 'disconnected' | 'loading' | 'error';

/**
 * Manages the VS Code status bar item with multi-state support.
 *
 * Provides visual feedback for different extension states including
 * connection status, loading indicators, error states, and completion hints.
 *
 * @example
 * ```typescript
 * const statusBarManager = new StatusBarManager();
 * context.subscriptions.push(statusBarManager);
 *
 * // Toggle states
 * statusBarManager.setConnected();
 * statusBarManager.setDisconnected();
 *
 * // Show loading state during operations
 * statusBarManager.setLoading('Testing connection');
 *
 * // Show error state on failure
 * statusBarManager.setError('API request failed');
 *
 * // Update model display
 * statusBarManager.setModel('sonnet');
 * ```
 */
export class StatusBarManager implements vscode.Disposable {
  /** Current connection state */
  private state: ConnectionState = 'disconnected';

  /** Currently configured model name */
  private currentModel: string = 'haiku';

  /** Currently active inference provider display name */
  private currentProvider: string = 'Claude';

  /** Error message when in error state */
  private errorMessage: string | undefined;

  /** The VS Code status bar item */
  private statusBarItem: vscode.StatusBarItem;

  /** Whether completion hint highlight is active */
  private highlightActive: boolean = false;

  /** Disposables for event listeners */
  private _disposables: vscode.Disposable[] = [];

  /** Active editor for tracking typing */
  private _activeEditor: vscode.TextEditor | undefined;

  /** Timer for highlight delay */
  private _highlightTimer: ReturnType<typeof setTimeout> | undefined;

  /** Timer for highlight fade */
  private _fadeTimer: ReturnType<typeof setTimeout> | undefined;

  /** Keyboard shortcut text */
  private _shortcut: string;

  /** Whether to show the completion hint (from settings) */
  private _showCompletionHint: boolean;

  /** Delay in ms before showing the completion hint (from settings) */
  private _completionHintDelayMs: number;

  /** Whether inline completions are enabled (`sidekick.enabled`) */
  private completionsEnabled: boolean;

  /** Timer that returns an error state to idle */
  private _errorTimer: ReturnType<typeof setTimeout> | undefined;

  /**
   * Creates a new StatusBarManager.
   *
   * Initializes the status bar item with right alignment, priority 100,
   * and the toggle command. Shows the status bar immediately.
   */
  constructor() {
    // A distinct id and name give this item its own entry in the status bar's
    // hide menu instead of sharing one with the other Sidekick items.
    this.statusBarItem = vscode.window.createStatusBarItem(
      'sidekick.status',
      vscode.StatusBarAlignment.Right,
      100,
    );
    this.statusBarItem.name = 'Sidekick';
    this.statusBarItem.command = 'sidekick.showMenu';

    const isMac = process.platform === 'darwin';
    this._shortcut = isMac ? '\u2318K \u2318\u21E7Space' : 'Ctrl+K Ctrl+Shift+Space';

    // Read completion hint settings
    const config = vscode.workspace.getConfiguration('sidekick');
    this._showCompletionHint = config.get<boolean>('showCompletionHint', true);
    this._completionHintDelayMs = config.get<number>('completionHintDelayMs', 1500);
    this.completionsEnabled = config.get<boolean>('enabled', true);
    this.state = this.completionsEnabled ? 'connected' : 'disconnected';

    this.update();
    this.statusBarItem.show();

    // Track active editor
    this._activeEditor = vscode.window.activeTextEditor;

    // Listen for text document changes to trigger highlight
    this._disposables.push(
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (this._activeEditor && e.document === this._activeEditor.document) {
          this.onTextChange();
        }
      }),
    );

    // Listen for active editor changes
    this._disposables.push(
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        this._activeEditor = editor;
        this.clearHighlight();
      }),
    );

    // Listen for configuration changes
    this._disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('sidekick.enabled')) {
          this.setCompletionsEnabled(
            vscode.workspace.getConfiguration('sidekick').get<boolean>('enabled', true),
          );
        }
        if (
          e.affectsConfiguration('sidekick.showCompletionHint') ||
          e.affectsConfiguration('sidekick.completionHintDelayMs')
        ) {
          const updated = vscode.workspace.getConfiguration('sidekick');
          this._showCompletionHint = updated.get<boolean>('showCompletionHint', true);
          this._completionHintDelayMs = updated.get<number>('completionHintDelayMs', 1500);

          // If hint was disabled, clear any active highlight
          if (!this._showCompletionHint) {
            this.clearHighlight();
          }
        }
      }),
    );
  }

  /**
   * Handle text change - schedule highlight after delay.
   */
  private onTextChange(): void {
    // Clear any pending timers
    this.clearTimers();

    // Remove highlight while typing
    if (this.highlightActive) {
      this.highlightActive = false;
      this.update();
    }

    // Don't highlight if not in connected state or if hint is disabled
    if (this.state !== 'connected' || !this._showCompletionHint) {
      return;
    }

    // Only for file documents
    const scheme = this._activeEditor?.document.uri.scheme;
    if (scheme !== 'file' && scheme !== 'untitled') {
      return;
    }

    // Schedule highlight after configured delay of no typing
    this._highlightTimer = setTimeout(() => {
      this._highlightTimer = undefined;
      this.highlightActive = true;
      this.update();

      // Schedule fade after 4 seconds
      this._fadeTimer = setTimeout(() => {
        this._fadeTimer = undefined;
        this.highlightActive = false;
        this.update();
      }, 4000);
    }, this._completionHintDelayMs);
  }

  /**
   * Clear highlight timers.
   */
  private clearTimers(): void {
    if (this._highlightTimer) {
      clearTimeout(this._highlightTimer);
      this._highlightTimer = undefined;
    }
    if (this._fadeTimer) {
      clearTimeout(this._fadeTimer);
      this._fadeTimer = undefined;
    }
  }

  /**
   * Clear highlight state.
   */
  public clearHighlight(): void {
    this.clearTimers();
    if (this.highlightActive) {
      this.highlightActive = false;
      this.update();
    }
  }

  /**
   * Records whether inline completions are enabled and, when idle, shows it.
   *
   * @param enabled - The effective `sidekick.enabled` value
   */
  setCompletionsEnabled(enabled: boolean): void {
    this.completionsEnabled = enabled;
    if (this.state === 'connected' || this.state === 'disconnected') {
      this.setConnected();
    }
  }

  /**
   * Returns the status bar to its idle state after an operation.
   *
   * Idle shows whether inline completions are enabled; finishing an AI
   * action must not turn a disabled indicator back on.
   */
  setConnected(): void {
    this.clearErrorTimer();
    if (!this.completionsEnabled) {
      this.setDisconnected();
      return;
    }
    this.state = 'connected';
    this.errorMessage = undefined;
    this.update();
  }

  /**
   * Sets the status bar to disconnected state.
   *
   * Shows circle-slash icon indicating the extension is disabled.
   */
  setDisconnected(): void {
    this.clearErrorTimer();
    this.state = 'disconnected';
    this.errorMessage = undefined;
    this.clearHighlight();
    this.update();
  }

  /**
   * Sets the status bar to loading state.
   *
   * Shows spinning sync icon during API operations.
   *
   * @param operation - Optional description of the current operation
   */
  setLoading(operation?: string): void {
    this.clearErrorTimer();
    this.state = 'loading';
    this.errorMessage = undefined;
    this.clearTimers();
    this.highlightActive = false;
    this.update(operation);
  }

  /**
   * Sets the status bar to error state.
   *
   * Shows error icon with red background indicating a failure.
   *
   * @param message - Error message describing what went wrong
   */
  setError(message: string): void {
    this.clearErrorTimer();
    this.state = 'error';
    this.errorMessage = message;
    this.clearTimers();
    this.highlightActive = false;
    this.update();
    // The failure was already reported; don't leave the bar red indefinitely.
    this._errorTimer = setTimeout(() => {
      this._errorTimer = undefined;
      if (this.state === 'error') this.setConnected();
    }, StatusBarManager.ERROR_DISPLAY_MS);
  }

  /** How long an error state stays visible before returning to idle. */
  static readonly ERROR_DISPLAY_MS = 15_000;

  private clearErrorTimer(): void {
    if (this._errorTimer) {
      clearTimeout(this._errorTimer);
      this._errorTimer = undefined;
    }
  }

  /**
   * Updates the current model name displayed in tooltip.
   *
   * @param model - Model shorthand (haiku, sonnet, opus)
   */
  setModel(model: string): void {
    this.currentModel = model;
    this.update();
  }

  /**
   * Updates the current inference provider name displayed in status bar text.
   *
   * @param name - Provider display name (e.g., 'Claude', 'OpenCode', 'Codex')
   */
  setProvider(name: string): void {
    this.currentProvider = name;
    this.update();
  }

  /**
   * Gets the current connection state.
   *
   * @returns The current ConnectionState
   */
  getState(): ConnectionState {
    return this.state;
  }

  /**
   * Updates the status bar item appearance based on current state.
   *
   * @param operation - Optional operation name for loading state
   */
  private update(operation?: string): void {
    switch (this.state) {
      case 'connected':
        if (this.highlightActive) {
          this.statusBarItem.text = `$(sparkle) ${this._shortcut}`;
          this.statusBarItem.tooltip = `Press ${this._shortcut} for an AI completion`;
          this.statusBarItem.backgroundColor = new vscode.ThemeColor(
            'statusBarItem.warningBackground',
          );
        } else {
          this.statusBarItem.text = `$(sparkle) Sidekick \u00B7 ${this.currentProvider}`;
          this.statusBarItem.tooltip = `Sidekick (${this.currentProvider} \u00B7 ${this.currentModel}) \u00B7 AI Complete: ${this._shortcut}`;
          this.statusBarItem.backgroundColor = undefined;
        }
        break;

      case 'disconnected':
        this.statusBarItem.text = '$(circle-slash) Sidekick';
        this.statusBarItem.tooltip =
          'Sidekick: inline completions are off. Click for the Sidekick menu, or run "Sidekick: Toggle Inline Completions".';
        this.statusBarItem.backgroundColor = undefined;
        break;

      case 'loading':
        this.statusBarItem.text = '$(sync~spin) Sidekick';
        this.statusBarItem.tooltip = `Sidekick: ${operation || 'Working'}...`;
        this.statusBarItem.backgroundColor = undefined;
        break;

      case 'error':
        this.statusBarItem.text = '$(error) Sidekick';
        this.statusBarItem.tooltip = `Sidekick Error: ${this.errorMessage}`;
        this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
        break;
    }
  }

  /**
   * Disposes of the status bar item.
   *
   * Called automatically when removed from context.subscriptions.
   */
  dispose(): void {
    this.clearTimers();
    this.clearErrorTimer();
    this.statusBarItem.dispose();
    this._disposables.forEach((d) => d.dispose());
    this._disposables = [];
  }
}
