/**
 * @fileoverview Notification trigger service for Claude Code session monitoring.
 *
 * Subscribes to SessionMonitor events and fires VS Code notifications
 * when configurable conditions are met. Provides built-in triggers for
 * common concerns (credential file access, destructive commands, high
 * token usage, tool errors, compaction events).
 *
 * @module services/NotificationTriggerService
 */

import * as vscode from 'vscode';
import type { SessionMonitor } from './SessionMonitor';
import type { ToolCall, CompactionEvent } from '../types/claudeSession';
import { log } from './Logger';

/**
 * Trigger definition for pattern-based notifications.
 */
interface NotificationTrigger {
  /** Unique trigger ID */
  id: string;
  /** Human-readable name */
  name: string;
  /** Whether this trigger is enabled */
  enabled: boolean;
  /** Severity of the notification */
  severity: 'info' | 'warning' | 'error';
  /** What to match against */
  matchTarget: 'tool_name' | 'file_path' | 'command' | 'content';
  /** Regex pattern to match */
  pattern: string;
  /** Throttle: minimum seconds between notifications for this trigger */
  throttleSeconds: number;
}

/** Default built-in triggers */
const BUILT_IN_TRIGGERS: NotificationTrigger[] = [
  {
    id: 'env-access',
    name: 'Credential file access',
    enabled: true,
    severity: 'warning',
    matchTarget: 'file_path',
    pattern: '\\.(env|pem|key|secret|credentials)$|id_rsa|id_ed25519',
    throttleSeconds: 30
  },
  {
    id: 'destructive-cmd',
    name: 'Destructive command',
    enabled: true,
    severity: 'error',
    matchTarget: 'command',
    pattern: 'rm\\s+-[a-zA-Z]*[rf]|git\\s+push\\s+(-f|--force)|git\\s+reset\\s+--hard|git\\s+clean\\s+-[a-zA-Z]*[fd]|drop\\s+(table|database)|chmod\\s+-R|chown\\s+-R|>\\s*/dev/',
    throttleSeconds: 10
  },
  {
    id: 'sensitive-path-write',
    name: 'Sensitive path modification',
    enabled: true,
    severity: 'warning',
    matchTarget: 'file_path',
    pattern: '^/(etc|boot|usr/(s?bin|lib))|/\\.ssh/|/\\.gnupg/',
    throttleSeconds: 30
  },
  {
    id: 'tool-error',
    name: 'Tool error burst',
    enabled: true,
    severity: 'warning',
    matchTarget: 'tool_name',
    pattern: '.*', // Matches any tool -- triggered by error rate logic, not pattern alone
    throttleSeconds: 60
  },
  {
    id: 'compaction',
    name: 'Context compaction',
    enabled: true,
    severity: 'info',
    matchTarget: 'content',
    pattern: '', // Not pattern-based -- handled by compaction event handler
    throttleSeconds: 30
  }
];

/**
 * Service that monitors session events and fires VS Code notifications
 * based on configurable triggers.
 */
export class NotificationTriggerService implements vscode.Disposable {
  private disposables: vscode.Disposable[] = [];
  private triggers: NotificationTrigger[];
  private compiledPatterns: Map<string, RegExp> = new Map();
  private lastFiredAt: Map<string, number> = new Map();

  /** Track consecutive tool errors for burst detection */
  private recentToolErrors: number = 0;
  private readonly ERROR_BURST_THRESHOLD = 3;

  /** Token threshold for high-usage warning (configurable) */
  private tokenThreshold: number;

  /** Total tokens seen, used for threshold crossing */
  private lastNotifiedTokenTotal: number = 0;

  constructor(
    private readonly sessionMonitor: SessionMonitor
  ) {
    // Load triggers from settings, falling back to built-in defaults
    this.triggers = this.loadTriggers();
    this.tokenThreshold = this.getTokenThreshold();

    // Subscribe to session events
    this.disposables.push(
      this.sessionMonitor.onToolCall(call => this.handleToolCall(call))
    );

    this.disposables.push(
      this.sessionMonitor.onCompaction(event => this.handleCompaction(event))
    );

    this.disposables.push(
      this.sessionMonitor.onTokenUsage(usage => this.handleTokenUsage(usage))
    );

    // Listen for settings changes
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('sidekick.notifications')) {
          this.triggers = this.loadTriggers();
          this.tokenThreshold = this.getTokenThreshold();
          log('NotificationTriggerService: triggers reloaded from settings');
        }
      })
    );

    log('NotificationTriggerService initialized');
  }

  /**
   * Loads trigger configuration from settings.
   */
  private loadTriggers(): NotificationTrigger[] {
    const config = vscode.workspace.getConfiguration('sidekick.notifications');
    const enabled = config.get<boolean>('enabled', true);

    if (!enabled) {
      return []; // All notifications disabled
    }

    // Use built-in triggers with per-trigger enable/disable from settings
    const triggers = BUILT_IN_TRIGGERS.map(trigger => ({
      ...trigger,
      enabled: config.get<boolean>(`triggers.${trigger.id}`, trigger.enabled)
    }));

    // Precompile regex patterns once instead of on every tool call event
    this.compiledPatterns = new Map();
    for (const trigger of triggers) {
      if (!trigger.pattern) continue;
      try {
        this.compiledPatterns.set(trigger.id, new RegExp(trigger.pattern, 'i'));
      } catch (e) {
        log(`NotificationTriggerService: invalid regex for trigger '${trigger.id}': ${e}`);
      }
    }

    return triggers;
  }

  /**
   * Gets token threshold from settings.
   */
  private getTokenThreshold(): number {
    const config = vscode.workspace.getConfiguration('sidekick.notifications');
    return config.get<number>('tokenThreshold', 500000);
  }

  /**
   * Checks if a trigger is throttled (fired too recently).
   */
  private isThrottled(triggerId: string, throttleSeconds: number): boolean {
    const lastFired = this.lastFiredAt.get(triggerId);
    if (!lastFired) return false;
    return (Date.now() - lastFired) < throttleSeconds * 1000;
  }

  /**
   * Records that a trigger fired.
   */
  private recordFire(triggerId: string): void {
    this.lastFiredAt.set(triggerId, Date.now());
  }

  /**
   * Fires a VS Code notification.
   */
  private fireNotification(title: string, body: string, severity: 'info' | 'warning' | 'error'): void {
    const message = `${title}: ${body}`;

    switch (severity) {
      case 'error':
        vscode.window.showErrorMessage(message);
        break;
      case 'warning':
        vscode.window.showWarningMessage(message);
        break;
      default:
        vscode.window.showInformationMessage(message);
        break;
    }
  }

  /**
   * Handles tool call events, matching against triggers.
   */
  private handleToolCall(call: ToolCall): void {
    // Track errors for burst detection
    if (call.isError) {
      this.recentToolErrors++;
      if (this.recentToolErrors >= this.ERROR_BURST_THRESHOLD) {
        const trigger = this.triggers.find(t => t.id === 'tool-error');
        if (trigger?.enabled && !this.isThrottled(trigger.id, trigger.throttleSeconds)) {
          this.fireNotification(
            'Tool Error Burst',
            `${this.recentToolErrors} consecutive tool errors detected`,
            trigger.severity
          );
          this.recordFire(trigger.id);
          this.recentToolErrors = 0;
        }
      }
    } else {
      this.recentToolErrors = 0;
    }

    // Check file path triggers
    const filePath = call.input?.file_path as string | undefined;
    if (filePath) {
      for (const trigger of this.triggers) {
        if (!trigger.enabled || trigger.matchTarget !== 'file_path') continue;
        if (this.isThrottled(trigger.id, trigger.throttleSeconds)) continue;

        const regex = this.compiledPatterns.get(trigger.id);
        if (!regex) continue;
        if (regex.test(filePath)) {
          this.fireNotification(
            trigger.name,
            `${call.name} accessing: ${filePath}`,
            trigger.severity
          );
          this.recordFire(trigger.id);
        }
      }
    }

    // Check command triggers (Bash tool)
    const command = call.input?.command as string | undefined;
    if (command) {
      for (const trigger of this.triggers) {
        if (!trigger.enabled || trigger.matchTarget !== 'command') continue;
        if (this.isThrottled(trigger.id, trigger.throttleSeconds)) continue;

        const regex = this.compiledPatterns.get(trigger.id);
        if (!regex) continue;
        if (regex.test(command)) {
          const description = call.input?.description as string | undefined;
          const body = description
            ? `${description} (${command.substring(0, 60)})`
            : `Command: ${command.substring(0, 80)}`;
          this.fireNotification(
            trigger.name,
            body,
            trigger.severity
          );
          this.recordFire(trigger.id);
        }
      }
    }
  }

  /**
   * Handles compaction events.
   */
  private handleCompaction(event: CompactionEvent): void {
    const trigger = this.triggers.find(t => t.id === 'compaction');
    if (!trigger?.enabled) return;
    if (this.isThrottled(trigger.id, trigger.throttleSeconds)) return;

    const reclaimedK = Math.round(event.tokensReclaimed / 1000);
    const beforeK = Math.round(event.contextBefore / 1000);
    const afterK = Math.round(event.contextAfter / 1000);

    this.fireNotification(
      'Context Compacted',
      `${beforeK}K -> ${afterK}K tokens (reclaimed ${reclaimedK}K)`,
      trigger.severity
    );
    this.recordFire(trigger.id);
  }

  /**
   * Handles token usage events for threshold crossing detection.
   */
  private handleTokenUsage(_usage: { inputTokens: number; outputTokens: number }): void {
    if (this.tokenThreshold <= 0) return;

    const stats = this.sessionMonitor.getStats();
    const totalTokens = stats.totalInputTokens + stats.totalOutputTokens;

    // Check if we crossed a threshold boundary since last notification
    const crossedThreshold = Math.floor(totalTokens / this.tokenThreshold) >
      Math.floor(this.lastNotifiedTokenTotal / this.tokenThreshold);

    if (crossedThreshold) {
      const totalK = Math.round(totalTokens / 1000);
      this.fireNotification(
        'High Token Usage',
        `Session has consumed ${totalK}K tokens`,
        'warning'
      );
      this.lastNotifiedTokenTotal = totalTokens;
    }
  }

  dispose(): void {
    this.disposables.forEach(d => d.dispose());
    this.disposables = [];
    this.lastFiredAt.clear();
    this.compiledPatterns.clear();
    log('NotificationTriggerService disposed');
  }
}
