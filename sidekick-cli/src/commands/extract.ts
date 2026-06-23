/**
 * Extract actionable session assets from recent Claude Code and Codex chats.
 *
 * Feature contributed by Juan Fourie (B33pBeeps), adapted from `trawl`:
 * https://github.com/B33pBeeps/trawl
 */

import type { Command } from 'commander';
import chalk from 'chalk';
import { resolve } from 'node:path';
import { gatherAssetsForCwd } from 'sidekick-shared';
import type {
  AssetAgent,
  ExtractedAsset,
  ExtractedAssets,
  ExtractedAssetType,
  GatherAssetsResult,
} from 'sidekick-shared';

const ALL_TYPES: ExtractedAssetType[] = ['url', 'path', 'command', 'plan'];

const TYPE_META: Record<
  ExtractedAssetType,
  { tag: string; color: (value: string) => string; heading: string }
> = {
  url: { tag: 'url', color: chalk.cyan, heading: 'URLs' },
  path: { tag: 'path', color: chalk.yellow, heading: 'Paths' },
  command: { tag: 'cmd', color: chalk.green, heading: 'Commands' },
  plan: { tag: 'plan', color: chalk.magenta, heading: 'Plans' },
};

const TYPE_ALIASES: Record<string, ExtractedAssetType> = {
  url: 'url',
  urls: 'url',
  path: 'path',
  paths: 'path',
  file: 'path',
  files: 'path',
  command: 'command',
  commands: 'command',
  cmd: 'command',
  cmds: 'command',
  plan: 'plan',
  plans: 'plan',
};

type AssetFilterResult = ExtractedAssets & { inChat?: boolean };

export function parseTypes(raw: string | undefined): ExtractedAssetType[] {
  if (!raw) return ALL_TYPES;

  const types: ExtractedAssetType[] = [];
  for (const token of raw
    .split(',')
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean)) {
    const type = TYPE_ALIASES[token];
    if (!type) {
      throw new Error(`Invalid asset type '${token}'. Use one of: url, path, command, plan.`);
    }
    if (type && !types.includes(type)) types.push(type);
  }

  return types.length > 0 ? types : ALL_TYPES;
}

export function parseLimit(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  if (!/^[1-9]\d*$/.test(raw)) {
    throw new Error('Limit must be a positive integer.');
  }
  return Number.parseInt(raw, 10);
}

export function filterByTypes(
  assets: ExtractedAssets & { inChat?: boolean },
  types: ExtractedAssetType[],
): AssetFilterResult {
  const wanted = new Set(types);
  return {
    urls: wanted.has('url') ? assets.urls : [],
    paths: wanted.has('path') ? assets.paths : [],
    commands: wanted.has('command') ? assets.commands : [],
    plans: wanted.has('plan') ? assets.plans : [],
    ...(typeof assets.inChat === 'boolean' ? { inChat: assets.inChat } : {}),
  };
}

export function flattenAssets(assets: ExtractedAssets): ExtractedAsset[] {
  return [...assets.urls, ...assets.paths, ...assets.commands, ...assets.plans];
}

export function resolveAssetAgents(globalOpts: { provider?: string }): {
  agents: AssetAgent[] | undefined;
  unsupportedProvider?: string;
} {
  if (globalOpts.provider === 'claude-code') return { agents: ['claude'] };
  if (globalOpts.provider === 'codex') return { agents: ['codex'] };
  if (globalOpts.provider === 'opencode') return { agents: [], unsupportedProvider: 'opencode' };
  return { agents: undefined };
}

function listFor(assets: ExtractedAssets, type: ExtractedAssetType): ExtractedAsset[] {
  switch (type) {
    case 'url':
      return assets.urls;
    case 'path':
      return assets.paths;
    case 'command':
      return assets.commands;
    case 'plan':
      return assets.plans;
  }
}

export function formatAssetsForText(
  assets: AssetFilterResult,
  types: ExtractedAssetType[],
): string {
  if (flattenAssets(assets).length === 0) {
    const message =
      assets.inChat === false
        ? 'No recent Claude Code or Codex sessions found for this project.'
        : 'No extractable assets found in recent sessions.';
    return `${chalk.dim(message)}\n`;
  }

  let output = '';
  for (const type of types) {
    const items = listFor(assets, type);
    if (items.length === 0) continue;

    const meta = TYPE_META[type];
    output += `${chalk.bold(meta.heading)} ${chalk.dim(`(${items.length})`)}\n`;
    for (const item of items) {
      const tag = item.agent ? `${item.agent} ${meta.tag}` : meta.tag;
      output += `  ${meta.color(`[${tag}]`)} ${item.display}\n`;
    }
    output += '\n';
  }
  return output;
}

function printAssets(assets: AssetFilterResult, types: ExtractedAssetType[]): void {
  process.stdout.write(formatAssetsForText(assets, types));
}

export async function extractAction(_opts: Record<string, unknown>, cmd: Command): Promise<void> {
  const globalOpts = cmd.parent!.opts();
  const opts = cmd.opts();
  const workspacePath = resolve((globalOpts.project as string | undefined) || process.cwd());
  const jsonOutput = !!globalOpts.json;

  try {
    const types = parseTypes(opts.type as string | undefined);
    const limit = parseLimit(opts.limit as string | undefined);
    const { agents, unsupportedProvider } = resolveAssetAgents(globalOpts);

    if (unsupportedProvider) {
      process.stderr.write(
        `Error: sidekick extract supports Claude Code and Codex sessions; provider '${unsupportedProvider}' is not supported yet.\n`,
      );
      process.exit(1);
    }

    const caps =
      limit && limit > 0 ? { url: limit, path: limit, command: limit, plan: limit } : undefined;
    const assets: GatherAssetsResult = gatherAssetsForCwd({ cwd: workspacePath, agents, caps });
    const filtered = filterByTypes(assets, types);

    if (opts.interactive) {
      const items = flattenAssets(filtered);
      if (items.length === 0) {
        process.stderr.write('No extractable assets found in recent sessions.\n');
        return;
      }
      const { showAssetPicker } = await import('./AssetPickerInk');
      await showAssetPicker(items);
      return;
    }

    if (jsonOutput) {
      process.stdout.write(JSON.stringify(filtered, null, 2) + '\n');
      return;
    }

    printAssets(filtered, types);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Error: ${message}\n`);
    process.exit(1);
  }
}
