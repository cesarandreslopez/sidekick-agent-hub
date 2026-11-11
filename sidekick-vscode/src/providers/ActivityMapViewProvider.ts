/**
 * The Activity Map sidebar view: the monitored session's map, now.
 *
 * Constructed on first show (`registerLazyWebviewView`) and not retained
 * when hidden: rebuilding is cheap, every animation offset is computed from
 * the current time so nothing visibly restarts, and the webview keeps its
 * small UI state (open sections, station filter) with `vscode.setState`.
 *
 * @module providers/ActivityMapViewProvider
 */

import * as vscode from 'vscode';
import type { SessionMonitor } from '../services/SessionMonitor';
import { ActivityMapConnection } from './ActivityMapConnection';
import {
  activityMapWebviewOptions,
  buildActivityMapDocument,
  exportActivityMapFile,
  readActivityMapViewOptions,
} from './activityMapHost';
import { LiveActivitySource } from './activityMapSources';

export class ActivityMapViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewType = 'sidekick.activityMap';

  private connection: ActivityMapConnection | undefined;
  private viewDisposables: vscode.Disposable[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly monitor: SessionMonitor,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.disposeView();
    view.webview.options = activityMapWebviewOptions(this.extensionUri);
    view.webview.html = buildActivityMapDocument(view.webview, this.extensionUri, 'sidebar');
    const source = new LiveActivitySource(this.monitor);
    this.connection = new ActivityMapConnection(view.webview, source, {
      isVisible: () => view.visible,
      onDidChangeVisibility: (listener) => view.onDidChangeVisibility(listener),
      onPopOut: (request) => {
        void vscode.commands.executeCommand('sidekick.openActivityMap', request);
      },
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
    this.viewDisposables.push(view.onDidDispose(() => this.disposeView()));
  }

  /** Sends changed drawing settings to the open view. */
  updateOptions(): void {
    this.connection?.updateOptions(readActivityMapViewOptions());
  }

  dispose(): void {
    this.disposeView();
  }

  private disposeView(): void {
    this.connection?.dispose();
    this.connection = undefined;
    for (const disposable of this.viewDisposables.splice(0)) disposable.dispose();
  }
}
