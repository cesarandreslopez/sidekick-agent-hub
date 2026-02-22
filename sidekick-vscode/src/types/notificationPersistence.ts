/**
 * @fileoverview Type definitions for notification persistence.
 *
 * Stores fired notifications to disk so they survive extension reloads
 * and can be reviewed in the dashboard notification history panel.
 *
 * Storage location: ~/.config/sidekick/notifications/{projectSlug}.json
 *
 * @module types/notificationPersistence
 */

/** Current schema version for notification store */
export const NOTIFICATION_SCHEMA_VERSION = 1;

/**
 * A single persisted notification entry.
 */
export interface PersistedNotification {
  /** Unique identifier (crypto.randomUUID()) */
  id: string;

  /** Trigger ID that fired this notification (e.g., 'env-access', 'destructive-cmd') */
  triggerId: string;

  /** Human-readable trigger name */
  triggerName: string;

  /** Notification severity */
  severity: 'info' | 'warning' | 'error';

  /** Notification title */
  title: string;

  /** Notification body text */
  body: string;

  /** ISO 8601 timestamp when the notification fired */
  timestamp: string;

  /** Whether the user has read this notification */
  isRead: boolean;

  /** Whether this notification was throttled (suppressed from VS Code UI) */
  wasThrottled?: boolean;

  /** Optional context about what triggered the notification */
  context?: {
    filePath?: string;
    command?: string;
    toolName?: string;
    tokenCount?: number;
    compactionBefore?: number;
    compactionAfter?: number;
  };
}

/**
 * On-disk store for persisted notifications.
 */
export interface NotificationStore {
  /** Schema version for future migrations */
  schemaVersion: number;

  /** Persisted notifications, newest first (max 100) */
  notifications: PersistedNotification[];

  /** Session ID of the most recently saved session */
  lastSessionId: string;

  /** ISO 8601 timestamp of last save */
  lastSaved: string;
}
