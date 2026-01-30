/**
 * @fileoverview TimeoutManager - Context-aware timeout handling with retry support.
 *
 * Provides consistent timeout handling across all Claude API calls with:
 * - Configurable timeouts per operation type
 * - Context-size-aware timeout calculation
 * - Progress indication with cancellation support
 * - "Retry with longer timeout" option on timeout
 * - Auto-adjustment based on context/prompt size
 *
 * @module TimeoutManager
 */

import * as vscode from 'vscode';
import { TimeoutError } from '../types';
import { log } from './Logger';

/**
 * Configuration for timeout calculation.
 */
export interface TimeoutConfig {
  /** Base timeout in milliseconds */
  baseTimeout: number;
  /** Maximum timeout cap in milliseconds */
  maxTimeout: number;
  /** Additional milliseconds per KB of context */
  perKbTimeout: number;
  /** Multiplier for retry timeout (e.g., 1.5 = 50% longer) */
  retryMultiplier: number;
}

/**
 * Result from an operation executed with timeout management.
 */
export interface TimeoutResult<T> {
  /** Whether the operation completed successfully */
  success: boolean;
  /** The result if successful */
  result?: T;
  /** Error if failed (non-timeout) */
  error?: Error;
  /** Whether the operation timed out */
  timedOut: boolean;
  /** The timeout used in milliseconds */
  timeoutMs: number;
  /** Context size in KB if provided */
  contextSizeKb?: number;
}

/**
 * Options for executing an operation with timeout management.
 */
export interface ExecuteOptions<T> {
  /** Human-readable operation name for UI (e.g., "Generating explanation") */
  operation: string;
  /** The async task to execute, receives AbortSignal for cancellation */
  task: (signal: AbortSignal) => Promise<T>;
  /** Timeout configuration */
  config: TimeoutConfig;
  /** Context size in bytes for timeout scaling */
  contextSize?: number;
  /** Show progress notification (default: true) */
  showProgress?: boolean;
  /** Allow user cancellation via progress UI (default: true) */
  cancellable?: boolean;
  /** Callback when timeout occurs, returns whether to retry */
  onTimeout?: (timeoutMs: number, contextKb: number) => Promise<'retry' | 'cancel'>;
}

/**
 * Operation types for timeout configuration.
 */
export type OperationType =
  | 'inlineCompletion'
  | 'explanation'
  | 'commitMessage'
  | 'documentation'
  | 'codeTransform'
  | 'review'
  | 'prDescription'
  | 'inlineChat'
  | 'errorExplanation';

/**
 * Default timeout configurations per operation type.
 */
export const DEFAULT_TIMEOUTS: Record<OperationType, number> = {
  inlineCompletion: 15000,
  explanation: 30000,
  commitMessage: 30000,
  documentation: 45000,
  codeTransform: 60000,
  review: 45000,
  prDescription: 45000,
  inlineChat: 60000,
  errorExplanation: 30000,
};

/**
 * TimeoutManager - Centralized timeout handling for Claude API calls.
 *
 * Provides:
 * - Context-aware timeout calculation
 * - VS Code progress integration
 * - Retry dialogs on timeout
 * - Consistent error handling
 *
 * @example
 * ```typescript
 * const manager = new TimeoutManager();
 * const result = await manager.executeWithTimeout({
 *   operation: 'Generating explanation',
 *   task: (signal) => authService.complete(prompt, { signal }),
 *   config: manager.getTimeoutConfig('explanation'),
 *   contextSize: prompt.length,
 *   showProgress: true,
 *   onTimeout: (ms, kb) => manager.promptRetry('explanation', ms, kb),
 * });
 * ```
 */
export class TimeoutManager {
  /**
   * Calculate the effective timeout based on context size.
   *
   * Formula: min(baseTimeout + (contextSizeKb * perKbTimeout), maxTimeout)
   *
   * @param config - Timeout configuration
   * @param contextSizeBytes - Size of context/prompt in bytes
   * @returns Effective timeout in milliseconds
   */
  calculateTimeout(config: TimeoutConfig, contextSizeBytes: number): number {
    const contextSizeKb = contextSizeBytes / 1024;
    const calculatedTimeout = config.baseTimeout + (contextSizeKb * config.perKbTimeout);
    const effectiveTimeout = Math.min(calculatedTimeout, config.maxTimeout);

    log(`TimeoutManager: baseTimeout=${config.baseTimeout}, contextKb=${contextSizeKb.toFixed(1)}, ` +
        `perKb=${config.perKbTimeout}, calculated=${calculatedTimeout.toFixed(0)}, ` +
        `capped=${effectiveTimeout.toFixed(0)}`);

    return Math.round(effectiveTimeout);
  }

  /**
   * Get timeout configuration for an operation type.
   *
   * Reads user settings with fallback to defaults.
   *
   * @param operationType - The type of operation
   * @returns TimeoutConfig for the operation
   */
  getTimeoutConfig(operationType: OperationType): TimeoutConfig {
    const config = vscode.workspace.getConfiguration('sidekick');

    // Read user-configured timeouts or use defaults
    const timeouts = config.get<Record<string, number>>('timeouts') ?? {};
    const baseTimeout = timeouts[operationType] ?? DEFAULT_TIMEOUTS[operationType];

    const perKbTimeout = config.get<number>('timeoutPerKb') ?? 500;
    const maxTimeout = config.get<number>('maxTimeout') ?? 120000;

    return {
      baseTimeout,
      maxTimeout,
      perKbTimeout,
      retryMultiplier: 1.5,
    };
  }

  /**
   * Execute an operation with timeout management, progress, and retry support.
   *
   * @param options - Execution options
   * @returns Promise resolving to TimeoutResult
   */
  async executeWithTimeout<T>(options: ExecuteOptions<T>): Promise<TimeoutResult<T>> {
    const {
      operation,
      task,
      config,
      contextSize = 0,
      showProgress = true,
      cancellable = true,
      onTimeout,
    } = options;

    const contextSizeKb = contextSize / 1024;
    let timeoutMs = this.calculateTimeout(config, contextSize);
    let attempt = 1;

    while (true) {
      log(`TimeoutManager: ${operation} attempt ${attempt}, timeout=${timeoutMs}ms, contextKb=${contextSizeKb.toFixed(1)}`);

      const result = await this.executeOnce<T>(
        operation,
        task,
        timeoutMs,
        contextSizeKb,
        showProgress,
        cancellable
      );

      // If successful or non-timeout error, return
      if (result.success || !result.timedOut) {
        return result;
      }

      // Timeout occurred - check if we should retry
      if (onTimeout) {
        const decision = await onTimeout(timeoutMs, contextSizeKb);
        if (decision === 'retry') {
          // Increase timeout for retry
          timeoutMs = Math.min(
            Math.round(timeoutMs * config.retryMultiplier),
            config.maxTimeout
          );
          attempt++;
          log(`TimeoutManager: Retrying ${operation} with timeout=${timeoutMs}ms`);
          continue;
        }
      }

      // No retry - return timeout result
      return result;
    }
  }

  /**
   * Execute a single attempt of an operation.
   *
   * @param operation - Operation name for UI
   * @param task - The async task to execute
   * @param timeoutMs - Timeout in milliseconds
   * @param contextSizeKb - Context size for display
   * @param showProgress - Whether to show progress
   * @param cancellable - Whether user can cancel
   * @returns Promise resolving to TimeoutResult
   */
  private async executeOnce<T>(
    operation: string,
    task: (signal: AbortSignal) => Promise<T>,
    timeoutMs: number,
    contextSizeKb: number,
    showProgress: boolean,
    cancellable: boolean
  ): Promise<TimeoutResult<T>> {
    const abortController = new AbortController();

    // Set up timeout
    const timeoutId = setTimeout(() => {
      abortController.abort();
    }, timeoutMs);

    try {
      if (showProgress) {
        // Execute with progress notification
        const result = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: this.formatProgressTitle(operation, contextSizeKb, timeoutMs),
            cancellable,
          },
          async (_progress, token) => {
            // Link VS Code cancellation to our abort controller
            if (cancellable) {
              token.onCancellationRequested(() => {
                abortController.abort();
              });
            }

            return task(abortController.signal);
          }
        );

        return {
          success: true,
          result,
          timedOut: false,
          timeoutMs,
          contextSizeKb,
        };
      } else {
        // Execute without progress
        const result = await task(abortController.signal);
        return {
          success: true,
          result,
          timedOut: false,
          timeoutMs,
          contextSizeKb,
        };
      }
    } catch (error) {
      // Check if it was a timeout
      if (error instanceof TimeoutError) {
        return {
          success: false,
          timedOut: true,
          timeoutMs,
          contextSizeKb,
          error,
        };
      }

      // Check if it was an abort (user cancellation)
      if (error instanceof Error && error.name === 'AbortError') {
        return {
          success: false,
          timedOut: false, // User cancelled, not timeout
          timeoutMs,
          contextSizeKb,
          error,
        };
      }

      // Other error
      return {
        success: false,
        timedOut: false,
        timeoutMs,
        contextSizeKb,
        error: error instanceof Error ? error : new Error(String(error)),
      };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Format progress title with context info.
   *
   * @param operation - Operation name
   * @param contextSizeKb - Context size in KB
   * @param timeoutMs - Timeout in milliseconds
   * @returns Formatted title string
   */
  private formatProgressTitle(operation: string, contextSizeKb: number, timeoutMs: number): string {
    const timeoutSec = Math.round(timeoutMs / 1000);

    if (contextSizeKb > 1) {
      return `${operation} (${contextSizeKb.toFixed(1)}KB, ~${timeoutSec}s)`;
    }

    return `${operation}...`;
  }

  /**
   * Show retry dialog when timeout occurs.
   *
   * @param operation - Operation name for display
   * @param timeoutMs - The timeout that was exceeded
   * @param contextSizeKb - Context size for display
   * @returns Promise resolving to 'retry' or 'cancel'
   */
  async promptRetry(
    operation: string,
    timeoutMs: number,
    contextSizeKb: number
  ): Promise<'retry' | 'cancel'> {
    // Check if auto-retry is enabled
    const config = vscode.workspace.getConfiguration('sidekick');
    const autoRetry = config.get<boolean>('autoRetryOnTimeout') ?? false;

    if (autoRetry) {
      return 'retry';
    }

    const timeoutSec = Math.round(timeoutMs / 1000);
    const newTimeoutSec = Math.round(timeoutMs * 1.5 / 1000);

    const contextInfo = contextSizeKb > 1 ? ` (context: ${contextSizeKb.toFixed(1)}KB)` : '';

    const action = await vscode.window.showWarningMessage(
      `${operation} timed out after ${timeoutSec}s${contextInfo}. Claude servers may be slow.`,
      { modal: false },
      `Retry (${newTimeoutSec}s)`,
      'Open Settings',
      'Cancel'
    );

    if (action === `Retry (${newTimeoutSec}s)`) {
      return 'retry';
    }

    if (action === 'Open Settings') {
      await vscode.commands.executeCommand(
        'workbench.action.openSettings',
        'sidekick.timeouts'
      );
    }

    return 'cancel';
  }

  /**
   * Execute an operation with simplified API (no retry support).
   *
   * Useful for operations that don't need retry dialogs.
   *
   * @param operation - Operation name
   * @param task - The async task
   * @param operationType - Type of operation for timeout config
   * @param contextSize - Context size in bytes
   * @returns Promise resolving to result or throwing on error
   */
  async execute<T>(
    operation: string,
    task: (signal: AbortSignal) => Promise<T>,
    operationType: OperationType,
    contextSize: number = 0
  ): Promise<T> {
    const config = this.getTimeoutConfig(operationType);
    const result = await this.executeWithTimeout({
      operation,
      task,
      config,
      contextSize,
      showProgress: true,
      cancellable: true,
    });

    if (result.success && result.result !== undefined) {
      return result.result;
    }

    if (result.timedOut) {
      throw new TimeoutError(
        `${operation} timed out after ${result.timeoutMs}ms`,
        result.timeoutMs
      );
    }

    throw result.error ?? new Error(`${operation} failed`);
  }
}

/**
 * Singleton instance for convenience.
 * Services can either use this or create their own instance.
 */
let defaultInstance: TimeoutManager | undefined;

/**
 * Get the default TimeoutManager instance.
 *
 * @returns The default TimeoutManager
 */
export function getTimeoutManager(): TimeoutManager {
  if (!defaultInstance) {
    defaultInstance = new TimeoutManager();
  }
  return defaultInstance;
}
