/**
 * `sidekick extract` — Extract actionable assets (URLs, file paths, shell
 * commands, plans) from recent session transcripts.
 *
 * Reads the newest sessions for the resolved provider, runs the shared
 * `extractAssetsFromEvents` extractor, and outputs grouped/colored text, JSON,
 * or an interactive picker (`--interactive`) that can copy/open selections.
 */

import type { Command } from 'commander';
import chalk from 'chalk';
import { gatherAssetsForCwd } from 'sidekick-shared';
import type {
  AssetAgent,
  ExtractedAsset,
  ExtractedAssetType,
  ExtractedAssets,
} from 'sidekick-shared';

const ALL_TYPES: ExtractedAssetType[] = ['url', 'path', 'command', 'plan'];

const TYPE_META: Record<ExtractedAssetType, { tag: string; color: (s: string) => string; heading: string }> = {
  url: { tag: 'url', color: chalk.cyan, heading: 'URLs' },
  path: { tag: 'path', color: chalk.yellow, heading: 'Paths' },
  command: { tag: 'cmd', color: chalk.green, heading: 'Commands' },
  plan: { tag: 'plan', color: chalk.magenta, heading: 'Plans' },
};

const TYPE_ALIASES: Record<string, ExtractedAssetType> = {
  url: 'url', urls: 'url',
  path: 'path', paths: 'path', file: 'path', files: 'path',
  command: 'command', commands: 'command', cmd: 'command', cmds: 'command',
  plan: 'plan', plans: 'plan',
};

/** Parse a `--type` comma list into a deduped, ordered list of asset types. */
export function parseTypes(raw: string | undefined): ExtractedAssetType[] {
  if (!raw) return ALL_TYPES;
  const out: ExtractedAssetType[] = [];
  for (const token of raw.split(',').map(s => s.trim().toLowerCase()).filter(Boolean)) {
    const mapped = TYPE_ALIASES[token];
    if (mapped && !out.includes(mapped)) out.push(mapped);
  }
  return out.length > 0 ? out : ALL_TYPES;
}

/** Return a new ExtractedAssets containing only the requested types. */
export function filterByTypes(assets: ExtractedAssets, types: ExtractedAssetType[]): ExtractedAssets {
  const want = new Set(types);
  return {
    urls: want.has('url') ? assets.urls : [],
    paths: want.has('path') ? assets.paths : [],
    commands: want.has('command') ? assets.commands : [],
    plans: want.has('plan') ? assets.plans : [],
  };
}

/** Flatten ExtractedAssets into a single ordered list (URLs, paths, cmds, plans). */
export function flattenAssets(assets: ExtractedAssets): ExtractedAsset[] {
  return [...assets.urls, ...assets.paths, ...assets.commands, ...assets.plans];
}

function listFor(assets: ExtractedAssets, type: ExtractedAssetType): ExtractedAsset[] {
  switch (type) {
    case 'url': return assets.urls;
    case 'path': return assets.paths;
    case 'command': return assets.commands;
    case 'plan': return assets.plans;
  }
}

function printAssets(assets: ExtractedAssets, types: ExtractedAssetType[]): void {
  const total = flattenAssets(assets).length;
  if (total === 0) {
    process.stdout.write(chalk.dim('No extractable assets found in recent sessions.\n'));
    return;
  }

  for (const type of types) {
    const items = listFor(assets, type);
    if (items.length === 0) continue;
    const meta = TYPE_META[type];
    process.stdout.write(`${chalk.bold(meta.heading)} ${chalk.dim(`(${items.length})`)}\n`);
    for (const item of items) {
      process.stdout.write(`  ${meta.color(`[${meta.tag}]`)} ${item.display}\n`);
    }
    process.stdout.write('\n');
  }
}

/**
 * Resolve which agents to read. An explicit `--provider claude-code|codex`
 * scopes to that one; otherwise read BOTH Claude and Codex for the cwd (trawl
 * behavior). Returning `undefined` lets the shared gatherer default to both.
 */
function resolveAgents(globalOpts: { provider?: string }): AssetAgent[] | undefined {
  if (globalOpts.provider === 'claude-code') return ['claude'];
  if (globalOpts.provider === 'codex') return ['codex'];
  return undefined;
}

export async function extractAction(_opts: Record<string, unknown>, cmd: Command): Promise<void> {
  const globalOpts = cmd.parent!.opts();
  const opts = cmd.opts();
  const workspacePath: string = globalOpts.project || process.cwd();
  const jsonOutput: boolean = !!globalOpts.json;
  const types = parseTypes(opts.type as string | undefined);
  const limit = opts.limit ? parseInt(opts.limit as string, 10) : undefined;

  try {
    const caps = limit && limit > 0
      ? { url: limit, path: limit, command: limit, plan: limit }
      : undefined;
    const assets = gatherAssetsForCwd({
      cwd: workspacePath,
      agents: resolveAgents(globalOpts),
      caps,
    });
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
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Error: ${msg}\n`);
    process.exit(1);
  }
}
