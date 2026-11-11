/**
 * The Activity Map pop-out: one editor panel with the replay bar, showing the
 * monitored session (live) or any past session of the workspace (replayed
 * from its file). Retained when hidden, since the scrub position and
 * playback state are the user's.
 *
 * @module providers/ActivityMapPanel
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { replayActivity } from 'sidekick-shared';
import type { ActivityStationId } from 'sidekick-shared';
import type { SessionMonitor } from '../services/SessionMonitor';
import type { ActivityMapFocus } from '../types/activityMap';
import { toClassificationOptions } from '../utils/activityMapSettings';
import { ActivityMapConnection, type ActivitySource } from './ActivityMapConnection';
import {
  activityMapWebviewOptions,
  buildActivityMapDocument,
  exportActivityMapFile,
  readActivityMapViewOptions,
  readActivitySettingsFromConfig,
} from './activityMapHost';
import {
  ArchiveActivitySource,
  LiveActivitySource,
  activitySourceLabel,
} from './activityMapSources';

export interface ActivityMapOpenRequest {
  /** A session file; omitted (or the monitored one) means the live session. */
  sessionPath?: string;
  at?: number;
  station?: ActivityStationId;
}

/** Accepts the command argument shapes: nothing, a path, a URI, or a request object. */
export function parseActivityMapOpenRequest(arg: unknown): ActivityMapOpenRequest {
  if (typeof arg === 'string') return { sessionPath: arg };
  if (arg instanceof vscode.Uri) return { sessionPath: arg.fsPath };
  if (!arg || typeof arg !== 'object') return {};
  const raw = arg as Record<string, unknown>;
  return {
    ...(typeof raw.sessionPath === 'string' ? { sessionPath: raw.sessionPath } : {}),
    ...(typeof raw.at === 'number' && Number.isFinite(raw.at) ? { at: raw.at } : {}),
    ...(typeof raw.station === 'string' ? { station: raw.station as ActivityStationId } : {}),
  };
}

export class ActivityMapPanel implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private connection: ActivityMapConnection | undefined;
  private source: ActivitySource | undefined;
  private sourceKey: string | undefined;
  private readonly panelDisposables: vscode.Disposable[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly getMonitor: () => SessionMonitor,
  ) {}

  /** The source the panel shows, for exports started outside the webview. */
  activeSource(): ActivitySource | undefined {
    return this.panel ? this.source : undefined;
  }

  async open(request: ActivityMapOpenRequest = {}): Promise<void> {
    const monitor = this.getMonitor();
    const livePath = monitor.getSessionPath();
    let sessionPath = request.sessionPath;
    if (!sessionPath && !livePath) {
      sessionPath = await this.pickSession(monitor);
      if (!sessionPath) return;
    }
    const live = !sessionPath || sessionPath === livePath;
    const key = live ? 'live' : `archive:${sessionPath}`;
    const focus: ActivityMapFocus | undefined =
      request.at !== undefined || request.station
        ? {
            ...(request.at !== undefined ? { at: request.at } : {}),
            ...(request.station ? { station: request.station } : {}),
          }
        : undefined;

    if (this.panel && this.connection && this.sourceKey === key) {
      this.panel.reveal(undefined, false);
      if (focus) this.connection.refocus(focus);
      return;
    }

    const source = live
      ? new LiveActivitySource(monitor)
      : await this.loadArchive(monitor, sessionPath as string);
    if (!source) return;
    this.show(source, key, focus);
  }

  updateOptions(): void {
    this.connection?.updateOptions(readActivityMapViewOptions());
  }

  dispose(): void {
    this.panel?.dispose();
    this.disposePanelState();
  }

  private show(source: ActivitySource, key: string, focus: ActivityMapFocus | undefined): void {
    this.connection?.dispose();
    this.source = source;
    this.sourceKey = key;
    const title = `Activity Map — ${source.info()?.label ?? 'no session'}`;
    if (!this.panel) {
      this.panel = vscode.window.createWebviewPanel(
        'sidekick.activityMapPanel',
        title,
        vscode.ViewColumn.One,
        { ...activityMapWebviewOptions(this.extensionUri), retainContextWhenHidden: true },
      );
      this.panelDisposables.push(
        this.panel.onDidDispose(() => {
          this.panel = undefined;
          this.disposePanelState();
        }),
      );
    } else {
      this.panel.title = title;
      this.panel.reveal(undefined, false);
    }
    const panel = this.panel;
    panel.webview.html = buildActivityMapDocument(panel.webview, this.extensionUri, 'panel', focus);
    this.connection = new ActivityMapConnection(panel.webview, source, {
      isVisible: () => panel.visible,
      onDidChangeVisibility: (listener) => panel.onDidChangeViewState(() => listener()),
      focus,
      onExport: (request) => {
        void exportActivityMapFile(source, request);
      },
      onOpenSettings: () => {
        void vscode.commands.executeCommand(
          'workbench.action.openSettings',
          'sidekick.activityMap',
        );
      },
    });
    if (source.kind === 'live') {
      // The monitor may move to a newer session; keep the title in step.
      this.panelDisposables.push(
        this.getMonitor().onSessionStart(() => {
          if (this.panel && this.source === source) {
            this.panel.title = `Activity Map — ${source.info()?.label ?? 'no session'}`;
          }
        }),
      );
    }
  }

  private disposePanelState(): void {
    this.connection?.dispose();
    this.connection = undefined;
    this.source?.dispose?.();
    this.source = undefined;
    this.sourceKey = undefined;
    for (const disposable of this.panelDisposables.splice(0)) disposable.dispose();
  }

  private async loadArchive(
    monitor: SessionMonitor,
    sessionPath: string,
  ): Promise<ActivitySource | undefined> {
    const provider = monitor.getProvider();
    try {
      return await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Replaying session activity…' },
        async () => {
          // A past session has no host measurements: context comes from its usage.
          const replay = replayActivity({
            provider,
            sessionPath,
            includeSubagents: true,
            settle: true,
            ...toClassificationOptions(readActivitySettingsFromConfig()),
            deriveContext: true,
          });
          return new ArchiveActivitySource(
            {
              kind: 'archive',
              providerId: replay.providerId,
              sessionId: replay.sessionId,
              label: activitySourceLabel(provider.displayName, replay.sessionId),
            },
            replay.timeline,
          );
        },
      );
    } catch (error) {
      vscode.window.showErrorMessage(
        `Could not replay ${path.basename(sessionPath)}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return undefined;
    }
  }

  /** With no live session: choose one of the workspace's recent sessions. */
  private async pickSession(monitor: SessionMonitor): Promise<string | undefined> {
    const workspacePath =
      monitor.getWorkspacePath() ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const provider = monitor.getProvider();
    const sessions = workspacePath ? provider.findAllSessions(workspacePath).slice(0, 25) : [];
    if (sessions.length === 0) {
      vscode.window.showInformationMessage(
        `No ${provider.displayName} sessions found for this workspace.`,
      );
      return undefined;
    }
    const items = sessions.map((sessionPath) => {
      let detail = '';
      try {
        detail = new Date(fs.statSync(sessionPath).mtimeMs).toLocaleString();
      } catch {
        // DB-backed sessions have no file to stat.
      }
      return {
        label: provider.getSessionId(sessionPath).slice(0, 8),
        description: detail,
        sessionPath,
      };
    });
    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: 'Replay which session on the activity map?',
    });
    return picked?.sessionPath;
  }
}
