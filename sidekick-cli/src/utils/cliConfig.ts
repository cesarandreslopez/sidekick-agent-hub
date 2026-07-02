/**
 * Typed read/write access to ~/.config/sidekick/cli-config.json.
 * Extracted from commands/account.ts so the dashboard and other commands
 * persist preferences through one code path. Writes are atomic
 * (tmp + rename) with owner-only permissions.
 */

import * as fs from 'fs';
import * as path from 'path';
import { getConfigDir } from 'sidekick-shared';
import type { AutoSwitchConfig } from 'sidekick-shared';

/** Dashboard UI preferences persisted across runs. */
export interface DashboardCliConfig {
  mouseEnabled?: boolean;
}

export interface CliConfig {
  accounts?: { autoSwitch?: AutoSwitchConfig } & Record<string, unknown>;
  dashboard?: DashboardCliConfig;
  [key: string]: unknown;
}

export function cliConfigPath(): string {
  return path.join(getConfigDir(), 'cli-config.json');
}

export function readCliConfig(): CliConfig {
  try {
    return JSON.parse(fs.readFileSync(cliConfigPath(), 'utf8')) as CliConfig;
  } catch {
    return {};
  }
}

export function writeCliConfig(config: CliConfig): void {
  const filePath = cliConfigPath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, filePath);
}

export function readDashboardConfig(): DashboardCliConfig {
  return readCliConfig().dashboard ?? {};
}

/** Merge a partial patch into the persisted dashboard section, keeping other sections intact. */
export function updateDashboardConfig(patch: Partial<DashboardCliConfig>): void {
  const config = readCliConfig();
  writeCliConfig({ ...config, dashboard: { ...(config.dashboard ?? {}), ...patch } });
}
