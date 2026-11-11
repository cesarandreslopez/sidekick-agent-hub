/**
 * Host-side pieces shared by the Activity Map sidebar view and panel: the
 * webview document, its drawing options, and exporting the map to a file.
 *
 * @module providers/activityMapHost
 */

import * as path from 'path';
import * as vscode from 'vscode';
import { exportActivity, renderActivityMapSvg } from 'sidekick-shared';
import { ACTIVITY_MAP_PROTOCOL } from '../types/activityMap';
import type {
  ActivityMapFocus,
  ActivityMapMode,
  ActivityMapViewOptions,
} from '../types/activityMap';
import {
  ACTIVITY_MAP_SETTINGS_SECTION,
  readActivityMapSettings,
  type ActivityMapSettings,
} from '../utils/activityMapSettings';
import { getNonce } from '../utils/nonce';
import { renderActivityMapHtml } from './activityMapTemplate';
import type { ActivitySource } from './ActivityMapConnection';

export function readActivitySettingsFromConfig(): ActivityMapSettings {
  const config = vscode.workspace.getConfiguration(ACTIVITY_MAP_SETTINGS_SECTION);
  return readActivityMapSettings((key) => config.get(key));
}

/** Drawing options for the webview, from the settings and `workbench.reduceMotion`. */
export function readActivityMapViewOptions(): ActivityMapViewOptions {
  const settings = readActivitySettingsFromConfig();
  const reduce = vscode.workspace.getConfiguration('workbench').get<string>('reduceMotion');
  return {
    motion: settings.motion,
    reduceMotion: reduce === 'on' || reduce === 'off' ? reduce : 'auto',
    layout: settings.layout,
    coreName: settings.coreName,
  };
}

export function activityMapWebviewOptions(extensionUri: vscode.Uri): vscode.WebviewOptions {
  return {
    enableScripts: true,
    localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'out', 'webview')],
  };
}

export function buildActivityMapDocument(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  mode: ActivityMapMode,
  focus?: ActivityMapFocus,
): string {
  const scriptUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, 'out', 'webview', 'activityMap.js'),
  );
  return renderActivityMapHtml({
    cspSource: webview.cspSource,
    nonce: getNonce(),
    scriptUri: scriptUri.toString(),
    mode,
    init: {
      protocol: ACTIVITY_MAP_PROTOCOL,
      mode,
      options: readActivityMapViewOptions(),
      ...(focus ? { focus } : {}),
    },
  });
}

/** `light` on light themes, otherwise `dark`: an exported file has no theme of its own. */
export function exportThemeFor(kind: vscode.ColorThemeKind): 'dark' | 'light' {
  return kind === vscode.ColorThemeKind.Light || kind === vscode.ColorThemeKind.HighContrastLight
    ? 'light'
    : 'dark';
}

function stamp(at: number): string {
  const date = new Date(at);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`;
}

/**
 * Writes the map (as of `at`, default now) to a file the user picks: an SVG
 * drawn in the current theme without animation, or the JSON export
 * (records, snapshot, insights).
 */
export async function exportActivityMapFile(
  source: ActivitySource,
  request: { format?: 'svg' | 'json'; at?: number } = {},
): Promise<void> {
  const info = source.info();
  if (!info) {
    vscode.window.showInformationMessage('There is no agent session to export yet.');
    return;
  }
  let format = request.format;
  if (!format) {
    const picked = await vscode.window.showQuickPick(
      [
        {
          label: 'SVG image',
          description: 'The map as drawn now, without animation',
          format: 'svg' as const,
        },
        {
          label: 'JSON',
          description: 'Records, snapshot and insights (content-free)',
          format: 'json' as const,
        },
      ],
      { placeHolder: 'Export the activity map as…' },
    );
    if (!picked) return;
    format = picked.format;
  }

  const snapshot = source.snapshot(request.at);
  const insights = source.insights(request.at);
  const at = request.at ?? snapshot.at;
  const settings = readActivitySettingsFromConfig();
  let content: string;
  if (format === 'svg') {
    content = renderActivityMapSvg(snapshot, {
      now: at,
      theme: exportThemeFor(vscode.window.activeColorTheme.kind),
      motion: 'none',
      layout: settings.layout,
      ...(settings.coreName ? { coreName: settings.coreName } : {}),
      insights,
      idPrefix: 'activity-map',
    });
  } else {
    const records =
      request.at === undefined ? source.records() : source.records().filter((r) => r.at <= at);
    content = `${JSON.stringify(
      exportActivity({
        snapshot,
        insights,
        records,
        providerId: info.providerId,
        ...(info.sessionId ? { sessionId: info.sessionId } : {}),
        at,
      }),
      null,
      2,
    )}\n`;
  }

  const fileName = `activity-map-${(info.sessionId ?? info.providerId).slice(0, 8)}-${stamp(at)}.${format}`;
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
  const target = await vscode.window.showSaveDialog({
    defaultUri: folder ? vscode.Uri.joinPath(folder, fileName) : undefined,
    filters: format === 'svg' ? { 'SVG image': ['svg'] } : { JSON: ['json'] },
    saveLabel: 'Export',
  });
  if (!target) return;
  await vscode.workspace.fs.writeFile(target, Buffer.from(content, 'utf8'));
  vscode.window.showInformationMessage(`Activity map exported to ${path.basename(target.fsPath)}.`);
}
