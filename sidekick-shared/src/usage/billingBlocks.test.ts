import { describe, expect, it } from 'vitest';
import {
  BILLING_BLOCK_DURATION_MS,
  computeBillingBlocks,
  findActiveBillingBlock,
} from './billingBlocks';
import type { BillingBlockInput } from './billingBlocks';

const T0 = Date.parse('2026-09-04T12:34:00Z');
const HOUR = 3_600_000;
const MINUTE = 60_000;

function event(
  offsetMs: number,
  overrides: Partial<BillingBlockInput> & { total?: number } = {},
): BillingBlockInput {
  const total = overrides.total ?? 1000;
  return {
    timestamp: T0 + offsetMs,
    tokens: { inputTokens: total / 2, outputTokens: total / 4, cacheReadTokens: total / 4 },
    costUsd: 0.01,
    costProvenance: 'model-catalog',
    model: 'claude-sonnet-4-5',
    ...overrides,
  };
}

describe('computeBillingBlocks', () => {
  it('opens one block aligned to the UTC hour and reports it active', () => {
    const now = new Date(T0 + 2 * HOUR);
    const blocks = computeBillingBlocks([event(0), event(30 * MINUTE), event(HOUR)], { now });

    expect(blocks).toHaveLength(1);
    const [block] = blocks;
    expect(block.start).toBe('2026-09-04T12:00:00.000Z');
    expect(block.end).toBe('2026-09-04T17:00:00.000Z');
    expect(block.firstEvent).toBe('2026-09-04T12:34:00.000Z');
    expect(block.lastEvent).toBe('2026-09-04T13:34:00.000Z');
    expect(block.isActive).toBe(true);
    expect(block.calls).toBe(3);
    expect(block.tokens).toEqual({
      inputTokens: 1500,
      outputTokens: 750,
      cacheWriteTokens: 0,
      cacheReadTokens: 750,
      total: 3000,
    });
    expect(block.costUsd).toBeCloseTo(0.03, 9);
    expect(block.costProvenance).toBe('estimated');
    expect(block.models).toEqual({
      'claude-sonnet-4-5': { calls: 3, tokens: 3000, costUsd: 0.03 },
    });
    expect(block.remainingMs).toBe(Date.parse(block.end) - now.getTime());
    expect(block.elapsedMs).toBe(2 * HOUR);
  });

  it('projects the active block from tokens per minute over the elapsed span', () => {
    // 1,000 tokens at t0 and 1,000 at t0 + 10 min, observed at t0 + 20 min: 100 tokens/min.
    const now = new Date(T0 + 20 * MINUTE);
    const [block] = computeBillingBlocks([event(0), event(10 * MINUTE)], { now });

    expect(block.burnRatePerMinute).toBeCloseTo(100, 6);
    const remainingMinutes = block.remainingMs / MINUTE;
    expect(block.projectedTokens).toBe(Math.round(2000 + 100 * remainingMinutes));
    // Cost projects at the block's cost per token.
    expect(block.projectedCostUsd).toBeCloseTo(
      0.02 + (0.02 / 2000) * (block.projectedTokens - 2000),
      9,
    );
  });

  it('closes a block after five hours and after a five-hour gap', () => {
    const now = new Date(T0 + 30 * HOUR);
    const blocks = computeBillingBlocks(
      [
        event(0),
        event(2 * HOUR),
        event(4 * HOUR),
        // 12:34 + 4h26m = 17:00 is the aligned block end: a new block opens here.
        event(4 * HOUR + 26 * MINUTE),
        // Inside the second block's five hours but more than five hours after the previous event.
        event(4 * HOUR + 26 * MINUTE + 5 * HOUR + 1),
      ],
      { now },
    );

    expect(blocks.map((block) => block.start)).toEqual([
      '2026-09-04T12:00:00.000Z',
      '2026-09-04T17:00:00.000Z',
      '2026-09-04T22:00:00.000Z',
    ]);
    expect(blocks.map((block) => block.calls)).toEqual([3, 1, 1]);
    for (const block of blocks) {
      expect(block.isActive).toBe(false);
      expect(block.remainingMs).toBe(0);
      expect(block.projectedTokens).toBe(block.tokens.total);
      expect(block.projectedCostUsd).toBe(block.costUsd);
    }
    // A closed block's rate spans first to last event (at least one minute).
    expect(blocks[0].elapsedMs).toBe(4 * HOUR);
    expect(blocks[0].burnRatePerMinute).toBeCloseTo(3000 / 240, 6);
    expect(blocks[1].burnRatePerMinute).toBe(1000);
    expect(findActiveBillingBlock(blocks)).toBeNull();
  });

  it('honours alignToHour and blockDurationMs', () => {
    const [block] = computeBillingBlocks([event(0)], {
      now: new Date(T0 + MINUTE),
      alignToHour: false,
      blockDurationMs: HOUR,
    });
    expect(block.start).toBe('2026-09-04T12:34:00.000Z');
    expect(block.end).toBe('2026-09-04T13:34:00.000Z');
    expect(BILLING_BLOCK_DURATION_MS).toBe(5 * HOUR);
  });

  it('classifies cost provenance and counts unpriced calls', () => {
    const now = new Date(T0 + HOUR);
    const [mixed] = computeBillingBlocks(
      [
        event(0, { costUsd: 0.5, costProvenance: 'provider-reported' }),
        event(MINUTE, { costUsd: 0.01, costProvenance: 'model-catalog' }),
        event(2 * MINUTE, { costUsd: null, model: 'mystery' }),
      ],
      { now },
    );
    expect(mixed.costProvenance).toBe('mixed');
    expect(mixed.unpricedCalls).toBe(1);
    expect(mixed.costUsd).toBeCloseTo(0.51, 9);
    expect(mixed.models.mystery).toEqual({ calls: 1, tokens: 1000, costUsd: 0 });

    const [unpriced] = computeBillingBlocks([event(0, { costUsd: null })], { now });
    expect(unpriced.costProvenance).toBe('unpriced');
    expect(unpriced.costUsd).toBe(0);
  });

  it('sorts unordered input and drops events without a usable timestamp', () => {
    const now = new Date(T0 + HOUR);
    const blocks = computeBillingBlocks(
      [event(30 * MINUTE), { ...event(0), timestamp: 'not a date' }, event(0)],
      { now },
    );
    expect(blocks).toHaveLength(1);
    expect(blocks[0].calls).toBe(2);
    expect(blocks[0].firstEvent).toBe('2026-09-04T12:34:00.000Z');
    expect(computeBillingBlocks([], { now })).toEqual([]);
  });

  it('finds the active block when it is not the last one written', () => {
    const now = new Date(T0 + HOUR);
    const blocks = computeBillingBlocks([event(-20 * HOUR), event(0)], { now });
    expect(blocks).toHaveLength(2);
    expect(findActiveBillingBlock(blocks)?.start).toBe('2026-09-04T12:00:00.000Z');
  });
});
