/**
 * Aggregate actionable assets for exactly one working directory.
 *
 * Portions adapted from `trawl` by Juan Fourie (B33pBeeps), MIT licensed:
 * https://github.com/B33pBeeps/trawl
 *
 * @module extractors/gatherAssets
 */

import { resolve } from 'node:path';
import { readClaudeAssets } from './sources/claudeAssets';
import { readCodexAssets } from './sources/codexAssets';
import {
  byTimestampDesc,
  capped,
  dedupeAssets,
  dedupePlansByTitle,
  DEFAULT_CAPS,
  type ExtractedAsset,
  type ExtractedAssets,
  type ExtractedAssetType,
  type SourceAssets,
} from './sessionAssets';

export type AssetAgent = 'claude' | 'codex';

export interface GatherAssetsOptions {
  cwd?: string;
  agents?: AssetAgent[];
  sessionsPerAgent?: number;
  caps?: Partial<Record<ExtractedAssetType, number>>;
}

export interface GatherAssetsResult extends ExtractedAssets {
  inChat: boolean;
}

const ALL_AGENTS: AssetAgent[] = ['claude', 'codex'];

export function gatherAssetsForCwd(options: GatherAssetsOptions = {}): GatherAssetsResult {
  const cwd = resolve(options.cwd || process.cwd());
  const sessionLimit = options.sessionsPerAgent ?? 3;
  const agents = options.agents ?? ALL_AGENTS;
  const caps = { ...DEFAULT_CAPS, ...(options.caps || {}) };
  const sources: SourceAssets[] = [];

  if (agents.includes('claude')) sources.push(readClaudeAssets(cwd, sessionLimit));
  if (agents.includes('codex')) sources.push(readCodexAssets(cwd, sessionLimit));

  const merge = (key: 'urls' | 'paths' | 'commands', cap: number): ExtractedAsset[] =>
    capped(dedupeAssets(sources.flatMap((source) => source[key]).sort(byTimestampDesc)), cap);

  return {
    urls: merge('urls', caps.url),
    paths: merge('paths', caps.path),
    commands: merge('commands', caps.command),
    plans: capped(
      dedupePlansByTitle(sources.flatMap((source) => source.plans).sort(byTimestampDesc)),
      caps.plan,
    ),
    inChat: sources.some((source) => source.hadSession),
  };
}
