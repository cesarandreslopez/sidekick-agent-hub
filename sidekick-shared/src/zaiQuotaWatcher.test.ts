import { describe, expect, it, vi } from 'vitest';
import { ZaiQuotaWatcher } from './zaiQuotaWatcher';
import type { ProviderQuotaState } from './providerQuota';
import type { QuotaState } from './quota';
import type { QuotaHistorySample } from './quotaHistory';

const NOW = Date.parse('2025-06-01T12:00:00Z');

function makeTurn(minutesAgo: number) {
  return {
    timestampMs: NOW - minutesAgo * 60_000,
    inputTokens: 1000,
    outputTokens: 200,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
  };
}

describe('ZaiQuotaWatcher', () => {
  it('emits an unavailable state on start when no turns have been ingested', () => {
    const states: ProviderQuotaState<'zai'>[] = [];
    const writeSnapshot = vi.fn();
    const readSnapshot = vi.fn(() => null);
    const watcher = new ZaiQuotaWatcher({
      tier: 'max',
      now: () => NOW,
      readSnapshot,
      writeSnapshot,
      appendHistorySample: vi.fn(),
    });
    watcher.onUpdate((state) => states.push(state));
    watcher.start();

    expect(states).toHaveLength(1);
    expect(states[0].available).toBe(false);
    expect(states[0].providerId).toBe('zai');
    expect(states[0].runtimeProvider).toBe('zai');
    expect(states[0].planType).toBe('max');
    watcher.dispose();
  });

  it('emits a derived quota state once turns are ingested', () => {
    const states: ProviderQuotaState<'zai'>[] = [];
    const writeSnapshot = vi.fn();
    const appendHistorySample = vi.fn();
    const watcher = new ZaiQuotaWatcher({
      tier: 'lite', // small budget so a handful of turns is visible
      now: () => NOW,
      recomputeDebounceMs: 0,
      readSnapshot: vi.fn(() => null),
      writeSnapshot,
      appendHistorySample,
    });
    watcher.onUpdate((state) => states.push(state));
    watcher.start();
    // Feed enough turns to register >0% on Lite (80 prompts/5h).
    // 1 prompt ≈ 17.5 turns, so 18 turns ≈ 1 prompt ≈ 1.25% of 80.
    for (let i = 0; i < 18; i++) watcher.ingestAssistantTurn(makeTurn(10 + i));
    watcher.refresh();

    // Initial cached-unavailable + post-refresh derived state.
    expect(states.length).toBeGreaterThanOrEqual(2);
    const derived = states[states.length - 1];
    expect(derived.available).toBe(true);
    expect(derived.providerId).toBe('zai');
    expect(derived.fiveHour.utilization).toBeGreaterThan(0);
    // Snapshot + history should be written.
    expect(writeSnapshot).toHaveBeenCalledWith('zai', 'default', expect.objectContaining({ providerId: 'zai' }));
    watcher.dispose();
  });

  it('does not emit duplicate states (debounced + same-payload)', () => {
    const states: ProviderQuotaState<'zai'>[] = [];
    const watcher = new ZaiQuotaWatcher({
      tier: 'lite',
      now: () => NOW,
      recomputeDebounceMs: 0,
      readSnapshot: vi.fn(() => null),
      writeSnapshot: vi.fn(),
      appendHistorySample: vi.fn(),
    });
    watcher.onUpdate((state) => states.push(state));
    watcher.start();
    watcher.ingestAssistantTurn(makeTurn(10));
    watcher.refresh();
    watcher.refresh(); // identical payload — should be suppressed
    expect(states).toHaveLength(2);
    watcher.dispose();
  });

  it('overrides reset timestamps when an error event is ingested', () => {
    const states: ProviderQuotaState<'zai'>[] = [];
    const watcher = new ZaiQuotaWatcher({
      tier: 'max',
      now: () => NOW,
      recomputeDebounceMs: 0,
      readSnapshot: vi.fn(() => null),
      writeSnapshot: vi.fn(),
      appendHistorySample: vi.fn(),
    });
    watcher.onUpdate((state) => states.push(state));
    watcher.start();
    watcher.ingestAssistantTurn(makeTurn(10));
    watcher.refresh();
    const beforeError = states[states.length - 1];

    const trapped = watcher.ingestError({
      code: '1308',
      message: 'Usage limit reached, next_flush_time: 2025-06-01T15:00:00Z',
    });
    watcher.refresh();
    const afterError = states[states.length - 1];

    expect(trapped).toBe(true);
    expect(beforeError.fiveHour.resetsAt).not.toBe('2025-06-01T15:00:00.000Z');
    expect(afterError.fiveHour.resetsAt).toBe('2025-06-01T15:00:00.000Z');
    expect(afterError.error).toContain('Usage limit reached');
    expect(afterError.failureKind).toBe('rate_limit');
    watcher.dispose();
  });

  it('appends a history sample when a workspaceId is configured', () => {
    const samples: QuotaHistorySample[] = [];
    const appendHistorySample = vi.fn((sample: QuotaHistorySample) => {
      samples.push(sample);
    });
    const watcher = new ZaiQuotaWatcher({
      tier: 'max',
      workspaceId: 'ws-1',
      now: () => NOW,
      recomputeDebounceMs: 0,
      readSnapshot: vi.fn(() => null),
      writeSnapshot: vi.fn(),
      appendHistorySample,
    });
    watcher.start();
    watcher.ingestAssistantTurn(makeTurn(10));
    watcher.refresh();
    expect(samples.length).toBeGreaterThan(0);
    expect(samples[0].runtimeProvider).toBe('zai');
    expect(samples[0].workspaceId).toBe('ws-1');
    watcher.dispose();
  });

  it('seeds from cached snapshot on start when one exists', () => {
    const states: ProviderQuotaState<'zai'>[] = [];
    const cached: QuotaState = {
      fiveHour: { utilization: 42, resetsAt: '2025-06-01T15:00:00Z' },
      sevenDay: { utilization: 10, resetsAt: '2025-06-05T00:00:00Z' },
      available: true,
      providerId: 'zai',
      source: 'cache',
      capturedAt: '2025-06-01T11:00:00Z',
      fiveHourLabel: '5-Hour',
      sevenDayLabel: 'Weekly',
      planType: 'max',
    };
    const watcher = new ZaiQuotaWatcher({
      tier: 'max',
      now: () => NOW,
      readSnapshot: vi.fn(() => cached),
      writeSnapshot: vi.fn(),
      appendHistorySample: vi.fn(),
    });
    watcher.onUpdate((state) => states.push(state));
    watcher.start();
    expect(states).toHaveLength(1);
    expect(states[0].available).toBe(true);
    expect(states[0].source).toBe('cache');
    expect(states[0].stale).toBe(true);
    expect(states[0].fiveHour.utilization).toBe(42);
    watcher.dispose();
  });

  it('prunes turns older than 7 days when pruneOldTurns runs', () => {
    const watcher = new ZaiQuotaWatcher({
      tier: 'max',
      now: () => NOW,
      recomputeDebounceMs: 0,
      pruneIntervalMs: 10,
      readSnapshot: vi.fn(() => null),
      writeSnapshot: vi.fn(),
      appendHistorySample: vi.fn(),
    });
    watcher.start();
    watcher.ingestAssistantTurns([
      makeTurn(60),                // 1h ago — inside 5h
      makeTurn(60 * 24 * 8),       // 8d ago — outside 7d
    ]);
    watcher.refresh();
    expect(watcher.bufferedTurnCount).toBe(2);
    // Wait briefly so the prune interval fires.
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        // Advance the clock so the prune is meaningful.
        watcher.refresh();
        expect(watcher.bufferedTurnCount).toBe(1);
        watcher.dispose();
        resolve();
      }, 30);
    });
  });
});
