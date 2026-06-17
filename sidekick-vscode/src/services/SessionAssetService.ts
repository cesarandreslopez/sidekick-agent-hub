/**
 * Native VS Code actions for extracted Claude Code and Codex session assets.
 *
 * Uses the shared filesystem-backed extractor from `sidekick-shared`; safe for
 * extension-host code, not webviews.
 */

import * as vscode from 'vscode';
import {
  gatherAssetsForCwd,
  type AssetAgent,
  type ExtractedAsset,
  type GatherAssetsOptions,
  type GatherAssetsResult,
} from 'sidekick-shared';
import { logError } from './Logger';

type GatherAssetsFn = (options: GatherAssetsOptions) => GatherAssetsResult;

export interface ShowExtractedSessionAssetsOptions {
  workspacePath?: string;
  providerId?: string;
  gatherAssets?: GatherAssetsFn;
}

export interface AssetQuickPickItem extends vscode.QuickPickItem {
  asset: ExtractedAsset;
  buttons: vscode.QuickInputButton[];
}

const COPY_BUTTON: vscode.QuickInputButton = {
  iconPath: new vscode.ThemeIcon('copy'),
  tooltip: 'Copy asset text',
};

const TYPE_META: Record<ExtractedAsset['type'], { tag: string; icon: string }> = {
  url: { tag: 'url', icon: '$(link-external)' },
  path: { tag: 'path', icon: '$(file-code)' },
  command: { tag: 'cmd', icon: '$(terminal)' },
  plan: { tag: 'plan', icon: '$(checklist)' },
};

export function resolveAssetAgentsForProvider(providerId: string | undefined): {
  agents: AssetAgent[] | undefined;
  unsupportedProvider?: string;
} {
  if (!providerId || providerId === 'auto') return { agents: undefined };
  if (providerId === 'claude-code' || providerId === 'claude-max') return { agents: ['claude'] };
  if (providerId === 'codex') return { agents: ['codex'] };
  if (providerId === 'opencode') return { agents: [], unsupportedProvider: 'opencode' };
  return { agents: undefined };
}

function flattenAssets(assets: GatherAssetsResult): ExtractedAsset[] {
  return [...assets.urls, ...assets.paths, ...assets.commands, ...assets.plans];
}

export function buildAssetQuickPickItems(assets: GatherAssetsResult): AssetQuickPickItem[] {
  return flattenAssets(assets).map((asset) => {
    const meta = TYPE_META[asset.type];
    const sourceLabel = `${asset.agent ?? 'session'} ${meta.tag}`;
    return {
      label: `${meta.icon} ${asset.display}`,
      description: sourceLabel,
      detail: [asset.source, asset.sessionPath].filter(Boolean).join(' • '),
      asset,
      buttons: [COPY_BUTTON],
      alwaysShow: true,
    };
  });
}

function parsePathTarget(text: string): { file: string; line?: number } {
  const match = /^(.+):(\d+)$/.exec(text);
  if (!match) return { file: text };
  return { file: match[1], line: Number(match[2]) };
}

async function copyAssetText(asset: ExtractedAsset, message = 'Copied asset to clipboard.'): Promise<void> {
  await vscode.env.clipboard.writeText(asset.text);
  vscode.window.showInformationMessage(message);
}

export async function runAssetDefaultAction(asset: ExtractedAsset): Promise<void> {
  switch (asset.type) {
    case 'url':
      await vscode.env.openExternal(vscode.Uri.parse(asset.text));
      break;
    case 'path': {
      const target = parsePathTarget(asset.text);
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(target.file));
      if (target.line !== undefined) {
        const position = new vscode.Position(Math.max(0, target.line - 1), 0);
        await vscode.window.showTextDocument(document, {
          selection: new vscode.Range(position, position),
        });
      } else {
        await vscode.window.showTextDocument(document);
      }
      break;
    }
    case 'command':
      await copyAssetText(asset, 'Copied command to clipboard.');
      break;
    case 'plan': {
      const document = await vscode.workspace.openTextDocument({
        content: asset.text,
        language: 'markdown',
      });
      await vscode.window.showTextDocument(document);
      break;
    }
  }
}

export async function showExtractedSessionAssets(options: ShowExtractedSessionAssetsOptions = {}): Promise<void> {
  const workspacePath = options.workspacePath ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspacePath) {
    vscode.window.showErrorMessage('Open a workspace folder before extracting session assets.');
    return;
  }

  const { agents, unsupportedProvider } = resolveAssetAgentsForProvider(options.providerId);
  if (unsupportedProvider) {
    vscode.window.showInformationMessage(
      `Session asset extraction supports Claude Code and Codex sessions; provider '${unsupportedProvider}' is not supported yet.`,
    );
    return;
  }

  let assets: GatherAssetsResult;
  try {
    assets = (options.gatherAssets ?? gatherAssetsForCwd)({ cwd: workspacePath, agents });
  } catch (error) {
    logError('Failed to extract session assets', error);
    vscode.window.showErrorMessage('Failed to extract session assets. See Sidekick logs for details.');
    return;
  }

  const items = buildAssetQuickPickItems(assets);
  if (items.length === 0) {
    vscode.window.showInformationMessage(
      assets.inChat
        ? 'No extractable assets found in recent sessions.'
        : 'No recent Claude Code or Codex sessions found for this project.',
    );
    return;
  }

  const quickPick = vscode.window.createQuickPick<AssetQuickPickItem>();
  quickPick.title = 'Extract Session Assets';
  quickPick.placeholder = 'Search URLs, files, commands, and plans from recent sessions';
  quickPick.matchOnDescription = true;
  quickPick.matchOnDetail = true;
  quickPick.items = items;

  quickPick.onDidAccept(() => {
    const selected = quickPick.selectedItems[0];
    quickPick.hide();
    if (selected) {
      runAssetDefaultAction(selected.asset).catch((error) => {
        logError('Failed to open extracted session asset', error);
        vscode.window.showErrorMessage('Failed to open extracted session asset. See Sidekick logs for details.');
      });
    }
  });

  quickPick.onDidTriggerItemButton((event) => {
    copyAssetText(event.item.asset).catch((error) => {
      logError('Failed to copy extracted session asset', error);
      vscode.window.showErrorMessage('Failed to copy extracted session asset. See Sidekick logs for details.');
    });
  });

  quickPick.onDidHide(() => quickPick.dispose());
  quickPick.show();
}
