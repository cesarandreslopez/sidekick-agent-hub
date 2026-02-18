/**
 * @fileoverview Monitor status bar service for displaying Claude Code session metrics.
 *
 * This module provides a dedicated status bar item that displays real-time
 * token usage, cost, context consumption, and quota timing from Claude Code sessions.
 * It subscribes to SessionMonitor events and updates dynamically.
 *
 * Key features:
 * - Displays total tokens (K/M suffix formatting)
 * - Shows session cost in USD
 * - Shows context window usage %
 * - Shows quota window time remaining
 * - Click to open dashboard
 * - Update throttling to prevent excessive updates
 *
 * @module services/MonitorStatusBar
 */

import * as vscode from 'vscode';
import { SessionMonitor } from './SessionMonitor';
import type { TokenUsage } from '../types/claudeSession';

/**
 * Status bar service for Claude Code session monitoring.
 *
 * Displays real-time metrics from SessionMonitor in a status bar item.
 * Updates are throttled to prevent excessive updates during rapid events.
 *
 * @example
 * ```typescript
 * const monitor = new SessionMonitor();
 * const statusBar = new MonitorStatusBar(monitor);
 * // Status bar now shows: "$(pulse) 12.5K | $0.02 | 15% | 4h32m"
 * // Click opens dashboard
 * ```
 */
export class MonitorStatusBar implements vscode.Disposable {
  /** Status bar item for displaying metrics */
  private readonly statusBarItem: vscode.StatusBarItem;

  /** Session monitor to track */
  private readonly monitor: SessionMonitor;

  /** Accumulated session state */
  private totalTokens: number = 0;
  private contextPercent: number = 0;

  /** Update throttling */
  private lastUpdateTime: number = 0;
  private readonly UPDATE_THROTTLE_MS = 500;

  /** Disposables for cleanup */
  private readonly disposables: vscode.Disposable[] = [];

  /**
   * Creates a new MonitorStatusBar.
   *
   * @param monitor - SessionMonitor instance to subscribe to
   */
  constructor(monitor: SessionMonitor) {
    this.monitor = monitor;

    // Create status bar item
    this.statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      99 // Appear next to existing Sidekick status bar
    );
    this.statusBarItem.command = 'sidekick.openDashboard';

    // Subscribe to session events
    this.disposables.push(
      this.monitor.onSessionStart(() => this.handleSessionStart()),
      this.monitor.onSessionEnd(() => this.handleSessionEnd()),
      this.monitor.onTokenUsage(usage => this.handleTokenUsage(usage))
    );

    // Initialize display
    if (this.monitor.isActive()) {
      this.handleSessionStart();
    } else {
      this.updateNoSession();
    }

    this.statusBarItem.show();
  }

  /**
   * Handles session start event.
   *
   * Resets state.
   */
  private handleSessionStart(): void {
    this.syncFromMonitor();
    this.updateDisplay();
  }

  /**
   * Handles session end event.
   *
   * Updates display to show no active session.
   */
  private handleSessionEnd(): void {
    this.updateNoSession();
  }

  /**
   * Handles token usage event.
   *
   * Updates accumulated totals and recalculates metrics.
   * Throttles updates to prevent excessive refreshes.
   *
   * @param usage - Token usage event
   */
  private handleTokenUsage(usage: TokenUsage): void {
    this.syncFromMonitor(usage);

    // Throttle updates
    const now = Date.now();
    if (now - this.lastUpdateTime < this.UPDATE_THROTTLE_MS) {
      return;
    }
    this.lastUpdateTime = now;

    this.updateDisplay();
  }

  /**
   * Syncs display metrics from SessionMonitor stats.
   *
   * @param usageHint - Optional latest usage event to help with model fallback
   */
  private syncFromMonitor(usageHint?: TokenUsage): void {
    const stats = this.monitor.getStats();
    const provider = this.monitor.getProvider();

    this.totalTokens = stats.totalInputTokens
      + stats.totalOutputTokens
      + stats.totalCacheWriteTokens
      + stats.totalCacheReadTokens;

    const modelId = stats.lastModelId ?? usageHint?.model;
    const contextLimit = provider.getContextWindowLimit?.(modelId) ?? 200_000;
    this.contextPercent = contextLimit > 0
      ? Math.round((stats.currentContextSize / contextLimit) * 100)
      : 0;
  }

  /**
   * Updates status bar display with current metrics.
   */
  private updateDisplay(): void {
    // Format: "$(pulse) 12.5K | 15%"
    const tokensFormatted = this.formatTokenCount(this.totalTokens);
    const contextFormatted = `${this.contextPercent}%`;

    // Add skull emoji when context is critically high (>= 80%)
    const icon = this.contextPercent >= 80 ? '💀' : '$(pulse)';
    this.statusBarItem.text = `${icon} ${tokensFormatted} | ${contextFormatted}`;

    // Color code based on context usage (matching Claude Code statusline)
    // >= 80%: red (danger), 50-79%: yellow/orange (warning), < 50%: normal
    if (this.contextPercent >= 80) {
      this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
    } else if (this.contextPercent >= 50) {
      this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    } else {
      this.statusBarItem.backgroundColor = undefined;
    }

    // Build detailed tooltip
    const stats = this.monitor.getStats();
    const provider = this.monitor.getProvider();
    const contextLimit = provider.getContextWindowLimit?.(stats.lastModelId) ?? 200_000;
    this.statusBarItem.tooltip = [
      `${provider.displayName} Session`,
      `Tokens: ${this.totalTokens.toLocaleString()} (${stats.totalInputTokens.toLocaleString()} in + ${stats.totalOutputTokens.toLocaleString()} out)`,
      `Context: ${this.contextPercent}% of ${this.formatTokenCount(contextLimit)}`,
      'Click to open dashboard'
    ].join('\n');
  }

  /**
   * Updates status bar to show no active session.
   */
  private updateNoSession(): void {
    this.statusBarItem.text = '$(pulse) --';
    this.statusBarItem.tooltip = 'No active session';
    this.statusBarItem.backgroundColor = undefined;
  }

  /**
   * Formats token count with K/M suffix.
   *
   * @param tokens - Token count
   * @returns Formatted string (e.g., "12.5K", "1.2M")
   */
  private formatTokenCount(tokens: number): string {
    if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
    if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}K`;
    return tokens.toString();
  }

  /**
   * Disposes the status bar and cleans up resources.
   */
  dispose(): void {
    this.statusBarItem.dispose();
    this.disposables.forEach(d => d.dispose());
  }
}
