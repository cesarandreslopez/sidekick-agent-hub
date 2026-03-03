/**
 * @fileoverview Cross-session notification persistence service.
 *
 * Persists fired notifications to disk so they carry forward across
 * extension reloads.
 *
 * Storage location: ~/.config/sidekick/notifications/{projectSlug}.json
 *
 * @module services/NotificationPersistenceService
 */

import * as vscode from 'vscode';
import * as crypto from 'crypto';
import type {
  PersistedNotification,
  NotificationStore,
} from '../types/notificationPersistence';
import { NOTIFICATION_SCHEMA_VERSION } from '../types/notificationPersistence';
import { PersistenceService, resolveSidekickDataPath } from './PersistenceService';
import { log } from './Logger';

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
export class NotificationPersistenceService extends PersistenceService<NotificationStore> {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  /** Fires when notifications are added/modified */
  readonly onDidChange = this._onDidChange.event;

  constructor(projectSlug: string) {
    super(
      resolveSidekickDataPath('notifications', `${projectSlug}.json`),
      'Notification',
      NOTIFICATION_SCHEMA_VERSION,
      createEmptyStore,
    );
  }

  protected override onStoreLoaded(): void {
    log(`Loaded persisted notifications: ${this.store.notifications.length} entries`);
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

    this.markDirtyAndNotify();
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
      this.markDirtyAndNotify();
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
      this.markDirtyAndNotify();
    }
  }

  /**
   * Clears all notifications.
   */
  clearAll(): void {
    const count = this.store.notifications.length;
    this.store.notifications = [];
    if (count > 0) {
      this.markDirtyAndNotify();
      log(`Cleared all ${count} notifications`);
    }
  }

  setLastSessionId(sessionId: string): void {
    this.store.lastSessionId = sessionId;
    this.markDirty();
  }

  override dispose(): void {
    this._onDidChange.dispose();
    super.dispose();
  }

  private markDirtyAndNotify(): void {
    this.markDirty();
    this._onDidChange.fire();
  }
}
