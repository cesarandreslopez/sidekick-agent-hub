/**
 * One `readSessionStats()` implementation for every session provider.
 *
 * Claude Code, Codex, and OpenCode used to compute session stats three
 * different ways (a hand-rolled JSONL scan, an aggregator drain, and a direct
 * SQLite read with hardcoded zeros). Every provider now drains its reader once
 * into the shared `EventAggregator`, so per-model totals use the
 * cache-inclusive vocabulary, cost carries provenance, tool failures are
 * split out, and compaction and truncation counts are real for all three.
 */

import { EventAggregator } from './aggregation/EventAggregator';
import type { EventAggregatorOptions } from './aggregation/types';
import type {
  ProviderId,
  SessionFileStats,
  SessionFileStatsAvailability,
  SessionProviderBase,
  SessionReader,
} from './providers/types';
import type { SessionEvent, TokenUsage } from './types/sessionEvent';

export interface ComputeSessionFileStatsOptions {
  providerId: ProviderId;
  sessionId: string;
  filePath: string;
  /** Label to use; derived from the first user prompt when omitted or null. */
  label?: string | null;
  /** Provider-specific context formula, forwarded to the aggregator. */
  computeContextSize?: EventAggregatorOptions['computeContextSize'];
  /** Defaults to `full`. */
  availability?: SessionFileStatsAvailability;
  unavailableReason?: string;
}

export interface ReadSessionFileStatsOptions {
  /**
   * Cheap label source consulted before the events (for example a SQLite
   * thread title). Return null to fall back to the first user prompt.
   */
  resolveLabel?: () => string | null;
}

const LABEL_MAX_LENGTH = 60;

function isTextBlock(block: unknown): block is { type: string; text: string } {
  return (
    typeof block === 'object' &&
    block !== null &&
    typeof (block as { text?: unknown }).text === 'string' &&
    typeof (block as { type?: unknown }).type === 'string' &&
    ['text', 'input_text', 'output_text'].includes((block as { type: string }).type)
  );
}

function messageText(content: unknown): string | null {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  const block = content.find((item) => isTextBlock(item) && item.text.trim().length > 0);
  return block && isTextBlock(block) ? block.text : null;
}

/**
 * First user prompt in a session, compacted to one line and truncated the
 * way every provider's `extractSessionLabel()` truncates (60 characters).
 */
export function firstUserPrompt(
  events: readonly SessionEvent[],
  maxLength = LABEL_MAX_LENGTH,
): string | null {
  for (const event of events) {
    if (event.type !== 'user') continue;
    const text = messageText(event.message?.content);
    if (!text) continue;
    const compact = text.replace(/\s+/g, ' ').trim();
    if (!compact) continue;
    return compact.length > maxLength ? `${compact.slice(0, maxLength - 3)}...` : compact;
  }
  return null;
}

/** Compute stats for an already-read event array through the shared aggregator. */
export function computeSessionFileStats(
  events: readonly SessionEvent[],
  options: ComputeSessionFileStatsOptions,
): SessionFileStats {
  const aggregator = new EventAggregator({
    providerId: options.providerId,
    computeContextSize: options.computeContextSize,
  });
  for (const event of events) aggregator.processEvent(event);
  const metrics = aggregator.getMetrics();

  const modelUsage: SessionFileStats['modelUsage'] = {};
  for (const model of metrics.modelStats) {
    // `tokens` is the aggregator's cache-inclusive total for the model, the
    // same figure `summarizeTokens().total` reports.
    modelUsage[model.model] = {
      calls: model.calls,
      tokens: model.tokens,
      costUsd: model.cost,
      priced: model.priced !== false,
    };
  }

  const toolUsage: SessionFileStats['toolUsage'] = {};
  const toolFailures: SessionFileStats['toolFailures'] = {};
  for (const tool of metrics.toolStats) {
    toolUsage[tool.name] = tool.successCount + tool.failureCount + tool.pendingCount;
    if (tool.failureCount > 0) toolFailures[tool.name] = tool.failureCount;
  }

  return {
    providerId: options.providerId,
    sessionId: options.sessionId,
    filePath: options.filePath,
    label: options.label ?? firstUserPrompt(events),
    startTime: metrics.sessionStartTime ?? '',
    endTime: metrics.lastEventTime ?? '',
    messageCount: metrics.messageCount,
    tokens: {
      input: metrics.tokens.inputTokens,
      output: metrics.tokens.outputTokens,
      cacheWrite: metrics.tokens.cacheWriteTokens,
      cacheRead: metrics.tokens.cacheReadTokens,
    },
    modelUsage,
    toolUsage,
    toolFailures,
    compactionEstimate: metrics.compactionCount,
    truncationCount: metrics.truncationCount,
    costUsd: metrics.tokens.costUsd,
    costProvenance: metrics.tokens.costProvenance,
    unpricedCalls: metrics.tokens.unpricedCalls,
    availability: options.availability ?? 'full',
    ...(options.unavailableReason ? { unavailableReason: options.unavailableReason } : {}),
    reportedCost: metrics.tokens.costUsd,
  };
}

/** The aggregator's context-size hook for a provider, or undefined for the default formula. */
export function providerContextSizeFn(
  provider: SessionProviderBase,
): EventAggregatorOptions['computeContextSize'] {
  if (!provider.computeContextSize) return undefined;
  return (usage) =>
    provider.computeContextSize!({ ...usage, model: '', timestamp: new Date() } as TokenUsage);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function describeMissingSource(provider: SessionProviderBase): string {
  const status = provider.getRuntimeStatus?.();
  if (status && !status.available) {
    return status.message ?? `Provider runtime unavailable (${status.kind}).`;
  }
  return 'Session source not found.';
}

/**
 * Read a session once through the provider's reader and compute its stats.
 *
 * The reader is drained with `readAll()` and then `flush()`ed so a final line
 * without a trailing newline is included, and it is never opened a second
 * time for the label. A source that cannot be read yields
 * `availability: 'unavailable'` with a reason instead of silent zeros; a
 * reader that reports truncation yields `partial`.
 */
export function readSessionFileStats(
  provider: SessionProviderBase,
  sessionPath: string,
  options: ReadSessionFileStatsOptions = {},
): SessionFileStats {
  const base = {
    providerId: provider.id,
    sessionId: provider.getSessionId(sessionPath),
    filePath: sessionPath,
  };

  let reader: SessionReader;
  let events: SessionEvent[];
  try {
    reader = provider.createReader(sessionPath);
    events = reader.readAll();
    // Readers buffer line-oriented input; flushing emits a trailing partial
    // line into the same array `readAll()` returned.
    reader.flush();
  } catch (error) {
    return computeSessionFileStats([], {
      ...base,
      availability: 'unavailable',
      unavailableReason: errorMessage(error),
    });
  }

  if (events.length === 0 && !reader.exists()) {
    return computeSessionFileStats([], {
      ...base,
      availability: 'unavailable',
      unavailableReason: describeMissingSource(provider),
    });
  }

  return computeSessionFileStats(events, {
    ...base,
    label: options.resolveLabel?.() ?? undefined,
    computeContextSize: providerContextSizeFn(provider),
    availability: reader.wasTruncated() ? 'partial' : 'full',
  });
}
