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
import type { NotificationPersistenceService } from './NotificationPersistenceService';
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
    throttleSeconds: 30,
  },
  {
    id: 'destructive-cmd',
    name: 'Destructive command',
    enabled: true,
    severity: 'error',
    matchTarget: 'command',
    pattern:
      'rm\\s+-[a-zA-Z]*[rf]|git\\s+push\\s+(-f|--force)|git\\s+reset\\s+--hard|git\\s+clean\\s+-[a-zA-Z]*[fd]|drop\\s+(table|database)|chmod\\s+-R|chown\\s+-R|>\\s*/dev/(?!null|std(out|err)|fd/|tty)',
    throttleSeconds: 10,
  },
  {
    id: 'sensitive-path-write',
    name: 'Sensitive path modification',
    enabled: true,
    severity: 'warning',
    matchTarget: 'file_path',
    pattern: '^/(etc|boot|usr/(s?bin|lib))|/\\.ssh/|/\\.gnupg/',
    throttleSeconds: 30,
  },
  {
    id: 'tool-error',
    name: 'Tool error burst',
    enabled: true,
    severity: 'warning',
    matchTarget: 'tool_name',
    pattern: '.*', // Matches any tool -- triggered by error rate logic, not pattern alone
    throttleSeconds: 60,
  },
  {
    id: 'compaction',
    name: 'Context compaction',
    enabled: true,
    severity: 'info',
    matchTarget: 'content',
    pattern: '', // Not pattern-based -- handled by compaction event handler
    throttleSeconds: 30,
  },
];

/** Labels for the action buttons shown on trigger notifications. */
export const NOTIFICATION_BUTTONS = {
  openDashboard: 'Open Dashboard',
  snooze: 'Snooze 1h',
  mute: 'Mute This Trigger',
} as const;

/** How long a snoozed trigger stays quiet (in-memory; cleared on reload). */
const SNOOZE_DURATION_MS = 60 * 60 * 1000;

/**
 * Action buttons per trigger ID.
 *
 * Security triggers (env-access, destructive-cmd, sensitive-path-write) get
 * no Snooze: temporarily quieting a security alert is a mixed signal, so the
 * only opt-out is a deliberate, persistent Mute. Noisy mid-session triggers
 * (tool-error, compaction, cycle-detected) get Snooze plus Mute.
 * high-token-usage gets no Mute because it has no boolean config key (only
 * the numeric `sidekick.notifications.tokenThreshold`); it gets Open
 * Dashboard instead since token burn is exactly what the dashboard shows.
 * Unknown trigger IDs fall back to a button-less notification.
 */
export const TRIGGER_BUTTONS: Record<string, string[]> = {
  'env-access': [NOTIFICATION_BUTTONS.openDashboard, NOTIFICATION_BUTTONS.mute],
  'destructive-cmd': [NOTIFICATION_BUTTONS.openDashboard, NOTIFICATION_BUTTONS.mute],
  'sensitive-path-write': [NOTIFICATION_BUTTONS.openDashboard, NOTIFICATION_BUTTONS.mute],
  'tool-error': [NOTIFICATION_BUTTONS.snooze, NOTIFICATION_BUTTONS.mute],
  compaction: [NOTIFICATION_BUTTONS.snooze, NOTIFICATION_BUTTONS.mute],
  'cycle-detected': [NOTIFICATION_BUTTONS.snooze, NOTIFICATION_BUTTONS.mute],
  'high-token-usage': [NOTIFICATION_BUTTONS.openDashboard, NOTIFICATION_BUTTONS.snooze],
};

/**
 * Service that monitors session events and fires VS Code notifications
 * based on configurable triggers.
 */
export class NotificationTriggerService implements vscode.Disposable {
  private disposables: vscode.Disposable[] = [];
  private triggers: NotificationTrigger[];
  private compiledPatterns: Map<string, RegExp> = new Map();
  private lastFiredAt: Map<string, number> = new Map();

  /** Trigger ID -> epoch ms until which the trigger is snoozed */
  private snoozedUntil: Map<string, number> = new Map();

  /** Guards notification button handlers that resolve after dispose() */
  private disposed = false;

  /** Track consecutive tool errors for burst detection */
  private recentToolErrors: number = 0;
  private readonly ERROR_BURST_THRESHOLD = 3;

  /** Token threshold for high-usage warning (configurable) */
  private tokenThreshold: number;

  /** Total tokens seen, used for threshold crossing */
  private lastNotifiedTokenTotal: number = 0;

  /** Optional persistence service for notification history */
  private notificationPersistence?: NotificationPersistenceService;

  constructor(
    private readonly sessionMonitor: SessionMonitor,
    notificationPersistence?: NotificationPersistenceService,
  ) {
    this.notificationPersistence = notificationPersistence;
    // Load triggers from settings, falling back to built-in defaults
    this.triggers = this.loadTriggers();
    this.tokenThreshold = this.getTokenThreshold();

    // Subscribe to session events
    this.disposables.push(this.sessionMonitor.onToolCall((call) => this.handleToolCall(call)));

    this.disposables.push(
      this.sessionMonitor.onCompaction((event) => this.handleCompaction(event)),
    );

    this.disposables.push(
      this.sessionMonitor.onTokenUsage((usage) => this.handleTokenUsage(usage)),
    );

    this.disposables.push(
      this.sessionMonitor.onCycleDetected((cycle) => this.handleCycleDetected(cycle)),
    );

    // Listen for settings changes
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('sidekick.notifications')) {
          this.triggers = this.loadTriggers();
          this.tokenThreshold = this.getTokenThreshold();
          log('NotificationTriggerService: triggers reloaded from settings');
        }
      }),
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
    const triggers = BUILT_IN_TRIGGERS.map((trigger) => ({
      ...trigger,
      enabled: config.get<boolean>(`triggers.${trigger.id}`, trigger.enabled),
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
   * Checks if a trigger is currently snoozed via the "Snooze 1h" button.
   */
  private isSnoozed(triggerId: string): boolean {
    const until = this.snoozedUntil.get(triggerId);
    return until !== undefined && Date.now() < until;
  }

  /**
   * Checks if a trigger is throttled (fired too recently) or snoozed.
   */
  private isThrottled(triggerId: string, throttleSeconds: number): boolean {
    if (this.isSnoozed(triggerId)) return true;
    const lastFired = this.lastFiredAt.get(triggerId);
    if (!lastFired) return false;
    return Date.now() - lastFired < throttleSeconds * 1000;
  }

  /**
   * Records that a trigger fired.
   */
  private recordFire(triggerId: string): void {
    this.lastFiredAt.set(triggerId, Date.now());
  }

  /**
   * Handles cycle detection events from SessionMonitor.
   * SessionMonitor already throttles to 60s, so no additional throttle needed.
   */
  private handleCycleDetected(cycle: { description: string; affectedFiles: string[] }): void {
    if (this.sessionMonitor.isReplaying) return;
    const config = vscode.workspace.getConfiguration('sidekick.notifications');
    if (!config.get<boolean>('triggers.cycle-detected', true)) return;
    const files =
      cycle.affectedFiles.length > 0
        ? cycle.affectedFiles.map((f) => f.split('/').pop()).join(', ')
        : 'unknown files';
    this.fireNotification(
      'Sidekick',
      `Agent cycling on ${files}: ${cycle.description}`,
      'warning',
      {
        triggerId: 'cycle-detected',
        triggerName: 'Agent Cycle Detected',
      },
    );
  }

  /**
   * Fires a VS Code notification and persists it to history.
   */
  private fireNotification(
    title: string,
    body: string,
    severity: 'info' | 'warning' | 'error',
    persistParams?: {
      triggerId: string;
      triggerName: string;
      wasThrottled?: boolean;
      context?: {
        filePath?: string;
        command?: string;
        toolName?: string;
        tokenCount?: number;
        compactionBefore?: number;
        compactionAfter?: number;
      };
    },
  ): void {
    const message = `${title}: ${body}`;

    // Snoozed triggers stay quiet but keep history complete. Checked here
    // (not only in isThrottled) because cycle-detected and high-token-usage
    // never go through isThrottled.
    if (persistParams && this.isSnoozed(persistParams.triggerId)) {
      if (this.notificationPersistence) {
        this.notificationPersistence.addNotification({
          triggerId: persistParams.triggerId,
          triggerName: persistParams.triggerName,
          severity,
          title,
          body,
          wasThrottled: true,
          context: persistParams.context,
        });
      }
      return;
    }

    const buttons = persistParams ? (TRIGGER_BUTTONS[persistParams.triggerId] ?? []) : [];

    let result: Thenable<string | undefined>;
    switch (severity) {
      case 'error':
        result = vscode.window.showErrorMessage(message, ...buttons);
        break;
      case 'warning':
        result = vscode.window.showWarningMessage(message, ...buttons);
        break;
      default:
        result = vscode.window.showInformationMessage(message, ...buttons);
        break;
    }

    // Fire-and-forget: the promise resolves only when the user clicks a
    // button or dismisses the toast, potentially long after this returns.
    result.then(
      (selection) => this.handleNotificationAction(selection, persistParams?.triggerId),
      () => {},
    );

    // Persist to notification history
    if (this.notificationPersistence && persistParams) {
      this.notificationPersistence.addNotification({
        triggerId: persistParams.triggerId,
        triggerName: persistParams.triggerName,
        severity,
        title,
        body,
        wasThrottled: persistParams.wasThrottled,
        context: persistParams.context,
      });
    }
  }

  /**
   * Handles a click on a notification action button. May run long after the
   * notification fired, so it guards against the service being disposed.
   */
  private handleNotificationAction(selection: string | undefined, triggerId?: string): void {
    if (this.disposed || !selection || !triggerId) return;

    switch (selection) {
      case NOTIFICATION_BUTTONS.openDashboard:
        vscode.commands.executeCommand('sidekick.openDashboard');
        break;
      case NOTIFICATION_BUTTONS.snooze:
        this.snoozedUntil.set(triggerId, Date.now() + SNOOZE_DURATION_MS);
        log(`NotificationTriggerService: trigger '${triggerId}' snoozed for 1h`);
        break;
      case NOTIFICATION_BUTTONS.mute:
        this.muteTrigger(triggerId);
        break;
    }
  }

  /**
   * Persists `sidekick.notifications.triggers.<id> = false`. Writes to the
   * workspace when a folder is open (matching the setSessionProvider
   * pattern), falling back to the user settings if the workspace write
   * fails. The onDidChangeConfiguration listener reloads triggers, so the
   * mute takes effect immediately.
   */
  private muteTrigger(triggerId: string): void {
    const target =
      vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0
        ? vscode.ConfigurationTarget.Workspace
        : vscode.ConfigurationTarget.Global;

    vscode.workspace
      .getConfiguration('sidekick.notifications')
      .update(`triggers.${triggerId}`, false, target)
      .then(
        () => log(`NotificationTriggerService: trigger '${triggerId}' muted`),
        () => {
          vscode.workspace
            .getConfiguration('sidekick.notifications')
            .update(`triggers.${triggerId}`, false, vscode.ConfigurationTarget.Global)
            .then(
              () => log(`NotificationTriggerService: trigger '${triggerId}' muted (user settings)`),
              (err) => log(`NotificationTriggerService: failed to mute '${triggerId}': ${err}`),
            );
        },
      );
  }

  /**
   * Handles tool call events, matching against triggers.
   * Skips notifications during initial session replay (historical events).
   */
  private handleToolCall(call: ToolCall): void {
    if (this.sessionMonitor.isReplaying) return;
    // Track errors for burst detection
    if (call.isError) {
      this.recentToolErrors++;
      if (this.recentToolErrors >= this.ERROR_BURST_THRESHOLD) {
        const trigger = this.triggers.find((t) => t.id === 'tool-error');
        if (trigger?.enabled && !this.isThrottled(trigger.id, trigger.throttleSeconds)) {
          this.fireNotification(
            'Tool Error Burst',
            `${this.recentToolErrors} consecutive tool errors detected`,
            trigger.severity,
            { triggerId: trigger.id, triggerName: trigger.name },
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
            trigger.severity,
            {
              triggerId: trigger.id,
              triggerName: trigger.name,
              context: { filePath, toolName: call.name },
            },
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
          this.fireNotification(trigger.name, body, trigger.severity, {
            triggerId: trigger.id,
            triggerName: trigger.name,
            context: { command },
          });
          this.recordFire(trigger.id);
        }
      }
    }
  }

  /**
   * Handles compaction events.
   * Skips notifications during initial session replay.
   */
  private handleCompaction(event: CompactionEvent): void {
    if (this.sessionMonitor.isReplaying) return;
    const trigger = this.triggers.find((t) => t.id === 'compaction');
    if (!trigger?.enabled) return;
    if (this.isThrottled(trigger.id, trigger.throttleSeconds)) return;

    const reclaimedK = Math.round(event.tokensReclaimed / 1000);
    const beforeK = Math.round(event.contextBefore / 1000);
    const afterK = Math.round(event.contextAfter / 1000);

    this.fireNotification(
      'Context Compacted',
      `${beforeK}K -> ${afterK}K tokens (reclaimed ${reclaimedK}K)`,
      trigger.severity,
      {
        triggerId: trigger.id,
        triggerName: trigger.name,
        context: { compactionBefore: event.contextBefore, compactionAfter: event.contextAfter },
      },
    );
    this.recordFire(trigger.id);
  }

  /**
   * Handles token usage events for threshold crossing detection.
   * Skips notifications during initial session replay.
   */
  private handleTokenUsage(_usage: { inputTokens: number; outputTokens: number }): void {
    if (this.sessionMonitor.isReplaying) return;
    if (this.tokenThreshold <= 0) return;

    const stats = this.sessionMonitor.getStats();
    const totalTokens = stats.totalInputTokens + stats.totalOutputTokens;

    // Check if we crossed a threshold boundary since last notification
    const crossedThreshold =
      Math.floor(totalTokens / this.tokenThreshold) >
      Math.floor(this.lastNotifiedTokenTotal / this.tokenThreshold);

    if (crossedThreshold) {
      const totalK = Math.round(totalTokens / 1000);
      this.fireNotification(
        'High Token Usage',
        `Session has consumed ${totalK}K tokens`,
        'warning',
        {
          triggerId: 'high-token-usage',
          triggerName: 'High Token Usage',
          context: { tokenCount: totalTokens },
        },
      );
      this.lastNotifiedTokenTotal = totalTokens;
    }
  }

  dispose(): void {
    this.disposed = true;
    this.disposables.forEach((d) => d.dispose());
    this.disposables = [];
    this.lastFiredAt.clear();
    this.compiledPatterns.clear();
    this.snoozedUntil.clear();
    log('NotificationTriggerService disposed');
  }
}
