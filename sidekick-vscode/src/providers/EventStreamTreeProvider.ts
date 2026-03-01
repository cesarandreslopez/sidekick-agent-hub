/**
 * @fileoverview Tree data provider for displaying live session events.
 *
 * Shows a scrollable list of FollowEvent-style entries from the current
 * session in the VS Code sidebar. Each event has an icon by type,
 * colored description, and timestamp. Ring buffer of 200 events.
 *
 * @module providers/EventStreamTreeProvider
 */

import * as vscode from 'vscode';
import type { SessionMonitor } from '../services/SessionMonitor';
import type { TimelineEvent } from '../types/claudeSession';

/**
 * Represents a single event in the tree view.
 */
interface EventItem {
  /** Display label */
  label: string;
  /** Event type for icon selection */
  type: string;
  /** Formatted timestamp */
  time: string;
  /** Full description text */
  description: string;
  /** Index in the ring buffer */
  index: number;
}

const MAX_EVENTS = 200;

const EVENT_ICONS: Record<string, vscode.ThemeIcon> = {
  user_prompt: new vscode.ThemeIcon('account', new vscode.ThemeColor('charts.green')),
  assistant_response: new vscode.ThemeIcon('hubot', new vscode.ThemeColor('charts.blue')),
  tool_call: new vscode.ThemeIcon('tools', new vscode.ThemeColor('charts.yellow')),
  tool_result: new vscode.ThemeIcon('output', new vscode.ThemeColor('charts.orange')),
  error: new vscode.ThemeIcon('error', new vscode.ThemeColor('charts.red')),
  compaction: new vscode.ThemeIcon('fold', new vscode.ThemeColor('descriptionForeground')),
};

/**
 * Tree data provider for live session events.
 *
 * Monitors timeline events from SessionMonitor and displays them in
 * the sidebar as a flat list, most recent first.
 */
export class EventStreamTreeProvider implements vscode.TreeDataProvider<EventItem>, vscode.Disposable {
  static readonly viewType = 'sidekick.eventStream';

  private readonly _onDidChangeTreeData = new vscode.EventEmitter<EventItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  /** Ring buffer of events */
  private events: EventItem[] = [];

  /** Disposables */
  private disposables: vscode.Disposable[] = [];

  /** Debounce timer for refresh */
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(sessionMonitor: SessionMonitor) {
    this.disposables.push(
      sessionMonitor.onTimelineEvent((event: TimelineEvent) => {
        this.addEvent(event);
      })
    );

    this.disposables.push(
      sessionMonitor.onSessionStart(() => {
        this.events = [];
        this.scheduleRefresh();
      })
    );
  }

  private addEvent(event: TimelineEvent): void {
    const time = event.timestamp
      ? new Date(event.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
      : '';

    const item: EventItem = {
      label: event.description.length > 80
        ? event.description.substring(0, 77) + '...'
        : event.description,
      type: event.type,
      time,
      description: event.description,
      index: this.events.length,
    };

    this.events.push(item);

    // Trim to ring buffer size
    if (this.events.length > MAX_EVENTS) {
      this.events = this.events.slice(this.events.length - MAX_EVENTS);
    }

    this.scheduleRefresh();
  }

  private scheduleRefresh(): void {
    if (this.refreshTimer) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      this._onDidChangeTreeData.fire(undefined);
    }, 300);
  }

  getTreeItem(element: EventItem): vscode.TreeItem {
    const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
    item.description = element.time;
    item.iconPath = EVENT_ICONS[element.type] || new vscode.ThemeIcon('circle-outline');
    item.tooltip = new vscode.MarkdownString(
      `**${element.type}** at ${element.time}\n\n${element.description}`
    );
    return item;
  }

  getChildren(): EventItem[] {
    // Return events in reverse chronological order (most recent first)
    return [...this.events].reverse();
  }

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  dispose(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    for (const d of this.disposables) d.dispose();
    this._onDidChangeTreeData.dispose();
  }
}
