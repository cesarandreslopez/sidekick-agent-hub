import { describe, expect, it, vi } from 'vitest';
import { CodexQuotaWatcher } from './codexQuotaWatcher';
import type { SavedAccountProfile } from './accountRegistry';
import type { QuotaState } from './quota';
import type { CodexProvider } from './providers/codex';
import type { SessionReader } from './providers/types';
import type { CodexRateLimits } from './types/codex';

function makeReader(): SessionReader {
  return {
    readNew: vi.fn(() => []),
    readAll: vi.fn(() => []),
    reset: vi.fn(),
    exists: vi.fn(() => true),
    flush: vi.fn(),
    getPosition: vi.fn(() => 0),
    seekTo: vi.fn(),
    wasTruncated: vi.fn(() => false),
  };
}

function makeAccount(): SavedAccountProfile {
  return {
    id: 'codex-account',
    providerId: 'codex',
    addedAt: '2026-05-08T10:00:00Z',
    label: 'Work',
    email: 'codex@example.com',
  };
}

describe('CodexQuotaWatcher', () => {
  it('emits live quota and writes an account-scoped snapshot', () => {
    const reader = makeReader();
    const rateLimits: CodexRateLimits = {
      primary: { used_percent: 42, window_minutes: 300, resets_at: 1_900_000_000 },
      secondary: { used_percent: 7, window_minutes: 10_080, resets_at: 1_900_100_000 },
    };
    const provider = {
      findActiveSession: vi.fn(() => '/tmp/rollout.jsonl'),
      createReader: vi.fn(() => reader),
      getLastRateLimits: vi.fn(() => rateLimits),
      dispose: vi.fn(),
    } as unknown as CodexProvider;
    const writes: Array<{ accountId: string; quota: QuotaState }> = [];
    const states: QuotaState[] = [];

    const watcher = new CodexQuotaWatcher('/workspace', {
      providerFactory: () => provider,
      getActiveAccount: () => makeAccount(),
      readSnapshot: () => null,
      writeSnapshot: (_providerId, accountId, quota) => {
        writes.push({ accountId, quota });
      },
      watchFile: () => ({ close: vi.fn() } as unknown as import('fs').FSWatcher),
    });
    watcher.onUpdate(state => states.push(state));

    watcher.start();
    watcher.dispose();

    expect(reader.readAll).toHaveBeenCalled();
    expect(writes).toHaveLength(1);
    expect(writes[0].accountId).toBe('codex-account');
    expect(states[0]).toMatchObject({
      runtimeProvider: 'codex',
      providerId: 'codex',
      available: true,
      accountLabel: 'Work',
      accountDetail: 'codex@example.com',
      fiveHour: { utilization: 42 },
      sevenDay: { utilization: 7 },
    });
  });

  it('falls back to cached quota when no active session exists', () => {
    const cached: QuotaState = {
      fiveHour: { utilization: 11, resetsAt: '2026-05-08T12:00:00Z' },
      sevenDay: { utilization: 22, resetsAt: '2026-05-09T12:00:00Z' },
      available: true,
      providerId: 'codex',
      source: 'cache',
      stale: true,
    };
    const provider = {
      findActiveSession: vi.fn(() => null),
      dispose: vi.fn(),
    } as unknown as CodexProvider;
    const states: QuotaState[] = [];

    const watcher = new CodexQuotaWatcher('/workspace', {
      providerFactory: () => provider,
      getActiveAccount: () => makeAccount(),
      readSnapshot: () => cached,
      writeSnapshot: vi.fn(),
    });
    watcher.onUpdate(state => states.push(state));

    watcher.start();
    watcher.dispose();

    expect(states[0]).toMatchObject({
      runtimeProvider: 'codex',
      providerId: 'codex',
      available: true,
      source: 'cache',
      stale: true,
      accountLabel: 'Work',
    });
  });
});
