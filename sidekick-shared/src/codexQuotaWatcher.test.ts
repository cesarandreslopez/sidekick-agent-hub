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
      findAllSessions: vi.fn(() => []),
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
      watchFile: () => ({ close: vi.fn() }) as unknown as import('fs').FSWatcher,
    });
    watcher.onUpdate((state) => states.push(state));

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
      findAllSessions: vi.fn(() => []),
      dispose: vi.fn(),
    } as unknown as CodexProvider;
    const states: QuotaState[] = [];

    const watcher = new CodexQuotaWatcher('/workspace', {
      providerFactory: () => provider,
      getActiveAccount: () => makeAccount(),
      readSnapshot: () => cached,
      writeSnapshot: vi.fn(),
      maxSessionFiles: 0,
    });
    watcher.onUpdate((state) => states.push(state));

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

  it('throttles rollout-tail fallback scans while retaining cached fallback', () => {
    const cached: QuotaState = {
      fiveHour: { utilization: 11, resetsAt: '2026-05-08T12:00:00Z' },
      sevenDay: { utilization: 22, resetsAt: '2026-05-09T12:00:00Z' },
      available: true,
    };
    const providerFactory = vi.fn(
      () =>
        ({
          findActiveSession: vi.fn(() => null),
          findAllSessions: vi.fn(() => []),
          dispose: vi.fn(),
        }) as unknown as CodexProvider,
    );
    const watcher = new CodexQuotaWatcher('/workspace', {
      providerFactory,
      getActiveAccount: () => makeAccount(),
      readSnapshot: () => cached,
      writeSnapshot: vi.fn(),
      maxSessionFiles: 0,
      localScanCacheMs: 300_000,
      now: () => 1_000,
    });

    watcher.start();
    watcher.refresh();
    watcher.dispose();

    // Each refresh needs discovery, but only the first performs a second,
    // potentially expensive local-source scan.
    expect(providerFactory).toHaveBeenCalledTimes(3);
  });

  it('does not construct or scan a provider until a Codex account appears', () => {
    let account: SavedAccountProfile | null = null;
    let accountListener: (() => void) | undefined;
    const provider = {
      findActiveSession: vi.fn(() => null),
      findAllSessions: vi.fn(() => []),
      dispose: vi.fn(),
    } as unknown as CodexProvider;
    const providerFactory = vi.fn(() => provider);
    const watcher = new CodexQuotaWatcher('/workspace', {
      providerFactory,
      getActiveAccount: () => account,
      maxSessionFiles: 0,
      subscribeAccountsChanged: (listener) => {
        accountListener = () => listener({} as never);
        return { dispose: vi.fn() };
      },
    });

    watcher.start();
    expect(providerFactory).not.toHaveBeenCalled();

    account = makeAccount();
    accountListener?.();
    expect(providerFactory).toHaveBeenCalled();
    watcher.dispose();
  });
});
