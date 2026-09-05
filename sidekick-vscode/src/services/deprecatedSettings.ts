/**
 * Deprecated `sidekick.*` settings still present in the user's configuration,
 * reported by `Sidekick: Doctor` and the dashboard's Health tab through the
 * shared doctor.
 *
 * @module services/deprecatedSettings
 */

import type { DeprecatedSetting } from 'sidekick-shared';

/** The subset of `vscode.WorkspaceConfiguration` needed, for testability. */
export interface SettingsInspector {
  inspect(key: string):
    | {
        globalValue?: unknown;
        workspaceValue?: unknown;
        workspaceFolderValue?: unknown;
      }
    | undefined;
}

const DEPRECATED: Array<{ key: string; replacement?: string }> = [
  { key: 'inlineTimeout', replacement: 'sidekick.timeouts.inlineCompletion' },
  { key: 'authMode', replacement: 'sidekick.inferenceProvider' },
  { key: 'zai.tier' },
];

/** Deprecated settings the user has explicitly configured at any scope. */
export function collectDeprecatedSettings(config: SettingsInspector): DeprecatedSetting[] {
  return DEPRECATED.filter(({ key }) => {
    const inspected = config.inspect(key);
    return (
      inspected?.globalValue !== undefined ||
      inspected?.workspaceValue !== undefined ||
      inspected?.workspaceFolderValue !== undefined
    );
  }).map(({ key, replacement }) =>
    replacement ? { key: `sidekick.${key}`, replacement } : { key: `sidekick.${key}` },
  );
}
