/**
 * Aggregate actionable assets for EXACTLY one working directory across both
 * agents — a direct port of trawl's `catches.mjs` `gather()`.
 *
 * Reads Claude Code and Codex sessions whose cwd is exactly this directory
 * (no walking up or down, no fuzzy discovery, no single-provider detection),
 * then merges: recency-sorted, deduped, capped. Plans are deduped by title so
 * re-plans of the same thing don't flood.
 *
 * @module extractors/gatherAssets
 */

import { readClaudeAssets } from './sources/claudeAssets';
import { readCodexAssets } from './sources/codexAssets';
import {
  byTimestampDesc,
  dedupeAssets,
  dedupePlansByTitle,
  capped,
  DEFAULT_CAPS,
  type ExtractedAsset,
  type ExtractedAssets,
  type ExtractedAssetType,
  type SourceAssets,
} from './sessionAssets';

/** Which agent transcripts to read. */
export type AssetAgent = 'claude' | 'codex';

export interface GatherAssetsOptions {
  /** Working directory to scope sessions to (defaults to process.cwd()). */
  cwd?: string;
  /** Agents to read (defaults to both Claude and Codex, like trawl). */
  agents?: AssetAgent[];
  /** Newest sessions to read per agent (default 3, matching trawl). */
  sessionsPerAgent?: number;
  /** Per-type maximums (defaults: commands 60, paths 60, urls 40, plans 25). */
  caps?: Partial<Record<ExtractedAssetType, number>>;
}

export interface GatherAssetsResult extends ExtractedAssets {
  /** True if any agent had a session for this cwd. */
  inChat: boolean;
}

const ALL_AGENTS: AssetAgent[] = ['claude', 'codex'];

/**
 * Read and merge actionable assets for a single directory across agents.
 * Mirrors trawl `gather(cwd)`.
 */
export function gatherAssetsForCwd(options: GatherAssetsOptions = {}): GatherAssetsResult {
  const cwd = options.cwd || process.cwd();
  const n = options.sessionsPerAgent ?? 3;
  const agents = options.agents ?? ALL_AGENTS;
  const caps = { ...DEFAULT_CAPS, ...(options.caps || {}) };

  const sources: SourceAssets[] = [];
  if (agents.includes('claude')) sources.push(readClaudeAssets(cwd, n));
  if (agents.includes('codex')) sources.push(readCodexAssets(cwd, n));

  // newest-first, deduped, capped so merged sessions stay scannable
  const merge = (key: 'urls' | 'paths' | 'commands', cap: number): ExtractedAsset[] =>
    capped(dedupeAssets(sources.flatMap((s) => s[key]).sort(byTimestampDesc)), cap);

  const plans = capped(
    dedupePlansByTitle(sources.flatMap((s) => s.plans).sort(byTimestampDesc)),
    caps.plan,
  );

  return {
    urls: merge('urls', caps.url),
    paths: merge('paths', caps.path),
    commands: merge('commands', caps.command),
    plans,
    inChat: sources.some((s) => s.hadSession),
  };
}
