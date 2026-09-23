/**
 * A session's token total, main thread plus subagents, in the shared
 * `summarizeTokens` vocabulary.
 *
 * Subagents run in their own transcripts (Claude Code `subagents/agent-*.jsonl`,
 * Codex spawned rollouts, OpenCode child sessions), so the main-thread reader
 * never sees their usage. Every surface that shows "the session total" goes
 * through this module so dump, report, and both dashboards agree.
 *
 * @module sessionTokenTotals
 */

import * as path from 'path';
import type { SessionProviderBase } from './providers/types';
import type { SubagentStats } from './types/sessionEvent';
import { extractNormalizedUsage } from './usageNormalization';
import {
  summarizeTokens,
  sumTokenTotals,
  type TokenSummary,
  type TokenTotalsLike,
} from './tokenSummary';

export interface SubagentTokenSummary {
  agentId: string;
  agentType?: string;
  description?: string;
  summary: TokenSummary;
}

export interface SessionTokenTotals {
  /** Tokens the session's own transcript billed. */
  mainThread: TokenSummary;
  /** One entry per subagent, in provider order. */
  subagents: SubagentTokenSummary[];
  /** All subagents together. */
  subagentTotal: TokenSummary;
  /** Main thread plus subagents. */
  combined: TokenSummary;
}

/** Token record of one subagent, in `TokenTotalsLike` form. */
export function subagentTokenTotals(stats: SubagentStats): TokenTotalsLike {
  return {
    inputTokens: stats.inputTokens,
    outputTokens: stats.outputTokens,
    cacheReadTokens: stats.cacheReadTokens,
    cacheWriteTokens: stats.cacheWriteTokens,
    reasoningTokens: stats.reasoningTokens,
    ...(typeof stats.totalTokens === 'number' ? { totalTokens: stats.totalTokens } : {}),
  };
}

/** Combine an already-known main-thread total with a session's subagent stats. */
export function combineSessionTokenTotals(
  mainThread: TokenTotalsLike,
  subagents: readonly SubagentStats[],
): SessionTokenTotals {
  const subagentRecords = subagents.map(subagentTokenTotals);
  const main = summarizeTokens(mainThread);
  const mainRecord: TokenTotalsLike = {
    inputTokens: main.input,
    outputTokens: main.output,
    cacheReadTokens: main.cacheRead,
    cacheWriteTokens: main.cacheWrite,
    reasoningTokens: main.reasoning,
    totalTokens: main.total,
  };
  return {
    mainThread: main,
    subagents: subagents.map((stats, index) => ({
      agentId: stats.agentId,
      ...(stats.agentType ? { agentType: stats.agentType } : {}),
      ...(stats.description ? { description: stats.description } : {}),
      summary: summarizeTokens(subagentRecords[index]),
    })),
    subagentTotal: summarizeTokens(sumTokenTotals(subagentRecords)),
    combined: summarizeTokens(sumTokenTotals([mainRecord, ...subagentRecords])),
  };
}

/** Sum the usage a provider reader reports for one session transcript. */
export function readMainThreadTokenTotals(
  provider: SessionProviderBase,
  sessionPath: string,
): TokenTotalsLike {
  const reader = provider.createReader(sessionPath);
  const events = reader.readAll();
  reader.flush();
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let reasoningTokens = 0;
  let totalTokens = 0;
  for (const event of events) {
    const usage = extractNormalizedUsage(event);
    if (!usage) continue;
    inputTokens += usage.uncachedInputTokens;
    outputTokens += usage.outputTokens;
    cacheReadTokens += usage.cacheReadTokens;
    cacheWriteTokens += usage.cacheWriteTokens;
    reasoningTokens += usage.reasoningTokens;
    totalTokens += usage.totalTokens;
  }
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    reasoningTokens,
    totalTokens,
  };
}

/**
 * Main thread plus subagents for one session. Pass `mainThread` when the
 * caller already aggregated the transcript (an `EventAggregator`'s tokens) to
 * skip re-reading it. Subagent discovery failures degrade to "no subagents".
 */
export function collectSessionTokenTotals(
  provider: SessionProviderBase,
  sessionPath: string,
  options: { mainThread?: TokenTotalsLike } = {},
): SessionTokenTotals {
  const mainThread = options.mainThread ?? readMainThreadTokenTotals(provider, sessionPath);
  return combineSessionTokenTotals(mainThread, scanSessionSubagents(provider, sessionPath));
}

/** A session's subagents by transcript path; discovery failures yield none. */
export function scanSessionSubagents(
  provider: SessionProviderBase,
  sessionPath: string,
): SubagentStats[] {
  try {
    return provider.scanSubagents(path.dirname(sessionPath), provider.getSessionId(sessionPath));
  } catch {
    return [];
  }
}
