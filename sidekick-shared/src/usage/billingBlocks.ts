/**
 * Five-hour billing blocks computed from usage events.
 *
 * Mirrors the ccusage convention: a block opens at the first usage event
 * (aligned down to the UTC hour), lasts five hours, and an event that lands
 * after the block's end or more than five hours after the previous event opens
 * a new block. The active block also reports a burn rate and an end-of-block
 * projection. Browser-safe: no Node imports.
 *
 * @module usage/billingBlocks
 */

import { classifyCostProvenance } from '../aggregation/costProvenance';
import type { AggregatedCostProvenance } from '../aggregation/types';
import { BurnRateCalculator } from '../statusline/BurnRateCalculator';
import { summarizeTokens } from '../tokenSummary';
import type { TokenTotalsLike } from '../tokenSummary';
import type { PricingProvenance } from '../usageNormalization';

/** Length of one billing block. */
export const BILLING_BLOCK_DURATION_MS = 5 * 3_600_000;

/** Minimal usage event the block calculator needs. */
export interface BillingBlockInput {
  /** Event time (ms since epoch, ISO string, or Date). */
  timestamp: number | string | Date;
  tokens: TokenTotalsLike;
  /** Priced cost for the event, or null when it could not be priced. */
  costUsd: number | null;
  costProvenance?: PricingProvenance;
  model?: string;
}

export interface BillingBlockTokens {
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  /** Cache-inclusive total (`summarizeTokens().total`). */
  total: number;
}

export interface BillingBlockModelUsage {
  calls: number;
  /** Cache-inclusive tokens. */
  tokens: number;
  costUsd: number;
}

export interface BillingBlock {
  /** Block identifier: the ISO start time. */
  id: string;
  /** ISO start (aligned to the hour when `alignToHour` is set). */
  start: string;
  /** ISO end (`start` + block duration). */
  end: string;
  firstEvent: string;
  lastEvent: string;
  /** `now` is inside the block and within one block length of the last event. */
  isActive: boolean;
  calls: number;
  tokens: BillingBlockTokens;
  costUsd: number;
  costProvenance: AggregatedCostProvenance;
  unpricedCalls: number;
  models: Record<string, BillingBlockModelUsage>;
  /** Time from the first event to `now` (active) or to the last event (closed). */
  elapsedMs: number;
  /** Time left until `end` for the active block; 0 otherwise. */
  remainingMs: number;
  /** Tokens per minute over `elapsedMs`. */
  burnRatePerMinute: number;
  /** Tokens expected by `end` at the current burn rate (equals `tokens.total` for closed blocks). */
  projectedTokens: number;
  /** Cost expected by `end` at the current cost per token (equals `costUsd` for closed blocks). */
  projectedCostUsd: number;
}

export interface ComputeBillingBlocksOptions {
  /** Clock used for activity and projections (default `Date.now()`). */
  now?: Date | number;
  /** Block length (default five hours). */
  blockDurationMs?: number;
  /** Align each block's start down to the UTC hour (default true, as ccusage does). */
  alignToHour?: boolean;
}

interface NormalizedInput {
  timestamp: number;
  tokens: TokenTotalsLike;
  costUsd: number | null;
  costProvenance: PricingProvenance;
  model: string;
}

function toMs(value: number | string | Date): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  return Date.parse(value);
}

function normalizeInput(event: BillingBlockInput): NormalizedInput | null {
  const timestamp = toMs(event.timestamp);
  if (!Number.isFinite(timestamp)) return null;
  const costUsd =
    typeof event.costUsd === 'number' && Number.isFinite(event.costUsd) ? event.costUsd : null;
  return {
    timestamp,
    tokens: event.tokens,
    costUsd,
    costProvenance: costUsd === null ? 'unpriced' : (event.costProvenance ?? 'model-catalog'),
    model: event.model ?? 'unknown',
  };
}

function floorToUtcHour(ms: number): number {
  return ms - (ms % 3_600_000);
}

function buildBlock(
  events: NormalizedInput[],
  start: number,
  durationMs: number,
  nowMs: number,
): BillingBlock {
  const end = start + durationMs;
  const first = events[0].timestamp;
  const last = events[events.length - 1].timestamp;
  const isActive = nowMs >= start && nowMs < end && nowMs - last < durationMs;

  const tokens = { inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0 };
  let total = 0;
  let costUsd = 0;
  let reportedCalls = 0;
  let estimatedCalls = 0;
  let unpricedCalls = 0;
  const models: Record<string, BillingBlockModelUsage> = {};
  const burn = new BurnRateCalculator(durationMs / 60_000);

  for (const event of events) {
    const summary = summarizeTokens(event.tokens);
    tokens.inputTokens += summary.input;
    tokens.outputTokens += summary.output;
    tokens.cacheWriteTokens += summary.cacheWrite;
    tokens.cacheReadTokens += summary.cacheRead;
    total += summary.total;
    burn.addEvent(summary.total, new Date(event.timestamp));

    const model = models[event.model] ?? { calls: 0, tokens: 0, costUsd: 0 };
    model.calls += 1;
    model.tokens += summary.total;
    if (event.costUsd !== null) {
      costUsd += event.costUsd;
      model.costUsd += event.costUsd;
      if (event.costProvenance === 'provider-reported') reportedCalls += 1;
      else estimatedCalls += 1;
    } else {
      unpricedCalls += 1;
    }
    models[event.model] = model;
  }

  const rateAt = isActive ? nowMs : last;
  const elapsedMs = Math.max(0, rateAt - first);
  const burnRatePerMinute = burn.calculateBurnRate(new Date(rateAt));
  const remainingMs = isActive ? Math.max(0, end - nowMs) : 0;
  const projectedTokens = isActive
    ? Math.round(total + burnRatePerMinute * (remainingMs / 60_000))
    : total;
  const costPerToken = total > 0 ? costUsd / total : 0;
  const projectedCostUsd = isActive ? costUsd + costPerToken * (projectedTokens - total) : costUsd;

  const startIso = new Date(start).toISOString();
  return {
    id: startIso,
    start: startIso,
    end: new Date(end).toISOString(),
    firstEvent: new Date(first).toISOString(),
    lastEvent: new Date(last).toISOString(),
    isActive,
    calls: events.length,
    tokens: { ...tokens, total },
    costUsd,
    costProvenance: classifyCostProvenance({ reportedCalls, estimatedCalls, unpricedCalls }),
    unpricedCalls,
    models,
    elapsedMs,
    remainingMs,
    burnRatePerMinute,
    projectedTokens,
    projectedCostUsd,
  };
}

/**
 * Group usage events into billing blocks, oldest first.
 *
 * Events with an unparseable timestamp are ignored. Events are sorted before
 * grouping, so callers may pass them in any order.
 */
export function computeBillingBlocks(
  events: readonly BillingBlockInput[],
  options: ComputeBillingBlocksOptions = {},
): BillingBlock[] {
  const durationMs = options.blockDurationMs ?? BILLING_BLOCK_DURATION_MS;
  const alignToHour = options.alignToHour ?? true;
  const nowMs = options.now === undefined ? Date.now() : toMs(options.now);

  const sorted = events
    .map(normalizeInput)
    .filter((event): event is NormalizedInput => event !== null)
    .sort((a, b) => a.timestamp - b.timestamp);

  const blocks: BillingBlock[] = [];
  let current: NormalizedInput[] = [];
  let currentStart = 0;

  for (const event of sorted) {
    const previous = current[current.length - 1];
    const opensNewBlock =
      !previous ||
      event.timestamp >= currentStart + durationMs ||
      event.timestamp - previous.timestamp > durationMs;
    if (opensNewBlock) {
      if (current.length > 0) blocks.push(buildBlock(current, currentStart, durationMs, nowMs));
      current = [];
      currentStart = alignToHour ? floorToUtcHour(event.timestamp) : event.timestamp;
    }
    current.push(event);
  }
  if (current.length > 0) blocks.push(buildBlock(current, currentStart, durationMs, nowMs));
  return blocks;
}

/** The block that is still open at the calculator's `now`, if any. */
export function findActiveBillingBlock(blocks: readonly BillingBlock[]): BillingBlock | null {
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    if (blocks[index].isActive) return blocks[index];
  }
  return null;
}
