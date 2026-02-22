/**
 * @fileoverview Cross-session notification persistence service.
 *
 * Persists fired notifications to disk so they carry forward across
 * extension reloads. Follows the DecisionLogService pattern:
 * dirty tracking, debounced saves, synchronous dispose.
 *
 * Storage location: ~/.config/sidekick/notifications/{projectSlug}.json
 *
 * @module services/NotificationPersistenceService
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import type {
  PersistedNotification,
  NotificationStore,
} from '../types/notificationPersistence';
import { NOTIFICATION_SCHEMA_VERSION } from '../types/notificationPersistence';
import { log, logError } from './Logger';

const MAX_NOTIFICATIONS = 100;

function createEmptyStore(): NotificationStore {
  return {
    schemaVersion: NOTIFICATION_SCHEMA_VERSION,
    notifications: [],
    lastSessionId: '',
    lastSaved: new Date().toISOString(),
  };
}

/**
 * Service for persisting notifications across extension reloads.
 */
export class NotificationPersistenceService implements vscode.Disposable {
  private store: NotificationStore;
  private dataFilePath: string;
  private isDirty: boolean = false;
  private saveTimer: NodeJS.Timeout | null = null;
  private readonly SAVE_DEBOUNCE_MS = 5000;

  private readonly _onDidChange = new vscode.EventEmitter<void>();
  /** Fires when notifications are added/modified */
  readonly onDidChange = this._onDidChange.event;

  constructor(private readonly projectSlug: string) {
    this.store = createEmptyStore();
    this.dataFilePath = this.getDataFilePath();
  }

  private getDataFilePath(): string {
    let configDir: string;

    if (process.platform === 'win32') {
      configDir = path.join(process.env.APPDATA || os.homedir(), 'sidekick', 'notifications');
    } else {
      configDir = path.join(os.homedir(), '.config', 'sidekick', 'notifications');
    }

    return path.join(configDir, `${this.projectSlug}.json`);
  }

  async initialize(): Promise<void> {
    try {
      const dir = path.dirname(this.dataFilePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
        log(`Created notification directory: ${dir}`);
      }

      if (fs.existsSync(this.dataFilePath)) {
        const content = await fs.promises.readFile(this.dataFilePath, 'utf-8');
        const loaded = JSON.parse(content) as NotificationStore;

        if (loaded.schemaVersion !== NOTIFICATION_SCHEMA_VERSION) {
          log(`Notification store schema version mismatch: ${loaded.schemaVersion} vs ${NOTIFICATION_SCHEMA_VERSION}`);
        }

        this.store = loaded;
        log(`Loaded persisted notifications: ${this.store.notifications.length} entries`);
      } else {
        this.store = createEmptyStore();
        log('Initialized new notification store');
      }
    } catch (error) {
      logError('Failed to load persisted notifications, starting with empty store', error);
      this.store = createEmptyStore();
    }
  }

  /**
   * Adds a notification to the store.
   */
  addNotification(params: {
    triggerId: string;
    triggerName: string;
    severity: 'info' | 'warning' | 'error';
    title: string;
    body: string;
    wasThrottled?: boolean;
    context?: PersistedNotification['context'];
  }): void {
    const notification: PersistedNotification = {
      id: crypto.randomUUID(),
      triggerId: params.triggerId,
      triggerName: params.triggerName,
      severity: params.severity,
      title: params.title,
      body: params.body,
      timestamp: new Date().toISOString(),
      isRead: false,
      wasThrottled: params.wasThrottled,
      context: params.context,
    };

    // Prepend (newest first)
    this.store.notifications.unshift(notification);

    // Cap at MAX_NOTIFICATIONS
    if (this.store.notifications.length > MAX_NOTIFICATIONS) {
      this.store.notifications = this.store.notifications.slice(0, MAX_NOTIFICATIONS);
    }

    this.isDirty = true;
    this.scheduleSave();
    this._onDidChange.fire();
  }

  /**
   * Returns notifications for display, with optional pagination.
   */
  getNotifications(limit?: number, offset?: number): PersistedNotification[] {
    const start = offset ?? 0;
    const end = limit ? start + limit : undefined;
    return this.store.notifications.slice(start, end);
  }

  /**
   * Returns count of unread notifications.
   */
  getUnreadCount(): number {
    return this.store.notifications.filter(n => !n.isRead).length;
  }

  /**
   * Marks a single notification as read.
   */
  markRead(id: string): void {
    const notification = this.store.notifications.find(n => n.id === id);
    if (notification && !notification.isRead) {
      notification.isRead = true;
      this.isDirty = true;
      this.scheduleSave();
      this._onDidChange.fire();
    }
  }

  /**
   * Marks all notifications as read.
   */
  markAllRead(): void {
    let changed = false;
    for (const n of this.store.notifications) {
      if (!n.isRead) {
        n.isRead = true;
        changed = true;
      }
    }
    if (changed) {
      this.isDirty = true;
      this.scheduleSave();
      this._onDidChange.fire();
    }
  }

  /**
   * Clears all notifications.
   */
  clearAll(): void {
    const count = this.store.notifications.length;
    this.store.notifications = [];
    if (count > 0) {
      this.isDirty = true;
      this.scheduleSave();
      this._onDidChange.fire();
      log(`Cleared all ${count} notifications`);
    }
  }

  setLastSessionId(sessionId: string): void {
    this.store.lastSessionId = sessionId;
    this.isDirty = true;
    this.scheduleSave();
  }

  private scheduleSave(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
    }

    this.saveTimer = setTimeout(() => {
      this.save();
    }, this.SAVE_DEBOUNCE_MS);
  }

  private async save(): Promise<void> {
    if (!this.isDirty) return;

    try {
      this.store.lastSaved = new Date().toISOString();
      const content = JSON.stringify(this.store, null, 2);
      await fs.promises.writeFile(this.dataFilePath, content, 'utf-8');
      this.isDirty = false;
      log('Notification data saved to disk');
    } catch (error) {
      logError('Failed to save notification data', error);
    }
  }

  dispose(): void {
    this._onDidChange.dispose();

    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }

    if (this.isDirty) {
      try {
        this.store.lastSaved = new Date().toISOString();
        const content = JSON.stringify(this.store, null, 2);
        fs.writeFileSync(this.dataFilePath, content, 'utf-8');
        log('Notification data saved on dispose');
      } catch (error) {
        logError('Failed to save notification data on dispose', error);
      }
    }
  }
}
