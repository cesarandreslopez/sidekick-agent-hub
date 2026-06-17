/**
 * Stable opaque identifier for the currently-open VS Code workspace.
 *
 * Backs the per-workspace quota history JSONL files written by sidekick-shared
 * (`appendQuotaHistorySample`). The hash is shared with the CLI so the same
 * workspace yields the same id whether sampled from VS Code or `process.cwd()`.
 */

import * as vscode from 'vscode';
import { getWorkspaceIdFromPath } from 'sidekick-shared';

export function getWorkspaceId(): string | undefined {
  // Vitest mocks throw on missing exports rather than returning undefined, so guard the lookup.
  let folder: string | undefined;
  try {
    folder = vscode.workspace?.workspaceFolders?.[0]?.uri.fsPath;
  } catch {
    return undefined;
  }
  if (!folder) return undefined;
  return getWorkspaceIdFromPath(folder);
}
