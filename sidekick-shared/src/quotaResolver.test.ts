import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { QuotaState } from './quota';
import { classifyQuotaFreshness } from './quota';
import type { QuotaSnapshotProviderId } from './quotaSnapshots';

const { mockLocalCodex, mockCodexApi, mockZaiApi } = vi.hoisted(() => ({
  mockLocalCodex: vi.fn(),
  mockCodexApi: vi.fn(),
  mockZaiApi: vi.fn(),
}));

let tmpDir: string;

vi.mock('./paths', () => ({
  getConfigDir: () => tmpDir,
}));

vi.mock('./codexQuota', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./codexQuota')>()),
  resolveCodexQuotaFromLocalSources: (...args: unknown[]) => mockLocalCodex(...args),
  fetchCodexQuotaFromApi: (...args: unknown[]) => mockCodexApi(...args),
}));

vi.mock('./zaiQuotaApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./zaiQuotaApi')>()),
  fetchZaiQuotaFromApi: (...args: unknown[]) => mockZaiApi(...args),
}));

import { resolveQuota } from './quotaResolver';
import { readQuotaSnapshot, writeQuotaSnapshot } from './quotaSnapshots';

const NOW = new Date('2026-09-04T12:00:00Z');

function minutesAgo(minutes: number): string {
  return new Date(NOW.getTime() - minutes * 60_000).toISOString();
}

function sample(
  overrides: Partial<QuotaState> & { capturedAt: string; source: QuotaState['source'] },
): QuotaState {
  return {
    fiveHour: { utilization: 42, resetsAt: '2026-09-04T15:00:00Z' },
    sevenDay: { utilization: 61, resetsAt: '2026-09-08T09:00:00Z' },
    available: true,
    ...overrides,
  };
}

/** In-memory snapshot store shaped like `readQuotaSnapshot`'s output. */
function memoryStore(initial: Record<string, QuotaState> = {}) {
  const records = new Map(Object.entries(initial));
  const key = (providerId: QuotaSnapshotProviderId, accountId: string) =>
    `${providerId}:${accountId}`;
  const writes: Array<{
    providerId: QuotaSnapshotProviderId;
    accountId: string;
    quota: QuotaState;
  }> = [];
  return {
    writes,
    readSnapshot: (providerId: QuotaSnapshotProviderId, accountId: string, now: Date = NOW) => {
      const stored = records.get(key(providerId, accountId));
      if (!stored) return null;
      const ageMs = now.getTime() - Date.parse(stored.capturedAt!);
      const freshness = ageMs < 5 * 60_000 ? 'fresh' : ageMs < 60 * 60_000 ? 'aging' : 'stale';
      return {
        ...stored,
        capturedSource: stored.source === 'cache' ? undefined : stored.source,
        source: 'cache' as const,
        stale: true,
        ageMs,
        freshness: freshness as QuotaState['freshness'],
      };
    },
    writeSnapshot: (providerId: QuotaSnapshotProviderId, accountId: string, quota: QuotaState) => {
      writes.push({ providerId, accountId, quota });
      records.set(key(providerId, accountId), quota);
    },
  };
}

const okJson = (body: unknown) =>
  ({ ok: true, status: 200, json: async () => body, headers: new Headers() }) as Response;

const claudeAccount = () => ({
  email: 'dev@example.com',
  label: 'Work',
  registryAccountId: 'claude-1',
  source: 'live' as const,
});

describe('resolveQuota', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-quota-resolver-'));
    mockLocalCodex.mockReset();
    mockCodexApi.mockReset();
    mockZaiApi.mockReset();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns a fresh status-line snapshot without touching the network', async () => {
    const store = memoryStore({
      'claude-code:claude-1': sample({ source: 'statusline', capturedAt: minutesAgo(2) }),
    });
    const fetchImpl = vi.fn();

    const result = await resolveQuota({
      providerId: 'claude-code',
      now: NOW,
      fetchImpl,
      ...store,
      resolveClaudeAccount: claudeAccount,
      getClaudeAccessToken: async () => 'token',
    });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      runtimeProvider: 'claude',
      providerId: 'claude-code',
      resolution: 'snapshot-fresh',
      source: 'cache',
      capturedSource: 'statusline',
      freshness: 'fresh',
      ageMs: 2 * 60_000,
      accountLabel: 'Work',
      accountDetail: 'dev@example.com',
      failure: null,
    });
    expect(result.fiveHour.utilization).toBe(42);
    expect(store.writes).toHaveLength(0);
  });

  it('skips a fresh snapshot when preferFresh is false and persists the API answer', async () => {
    const store = memoryStore({
      'claude-code:claude-1': sample({ source: 'statusline', capturedAt: minutesAgo(1) }),
    });
    const fetchImpl = vi.fn(async () =>
      okJson({
        five_hour: { utilization: 55, resets_at: '2026-09-04T16:00:00Z' },
        seven_day: { utilization: 70, resets_at: '2026-09-09T00:00:00Z' },
      }),
    );

    const result = await resolveQuota({
      providerId: 'claude-code',
      now: NOW,
      preferFresh: false,
      fetchImpl,
      ...store,
      resolveClaudeAccount: claudeAccount,
      getClaudeAccessToken: async () => 'token',
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      resolution: 'api',
      source: 'api',
      freshness: 'fresh',
      ageMs: 0,
      capturedAt: NOW.toISOString(),
    });
    expect(result.fiveHour.utilization).toBe(55);
    expect(store.writes).toEqual([
      expect.objectContaining({
        providerId: 'claude-code',
        accountId: 'claude-1',
        quota: expect.objectContaining({ source: 'api', fiveHour: expect.anything() }),
      }),
    ]);
  });

  it('falls back to an aging snapshot when the API fails, keeping the failure reason', async () => {
    const store = memoryStore({
      'claude-code:claude-1': sample({ source: 'api', capturedAt: minutesAgo(30) }),
    });
    const fetchImpl = vi.fn(async () => {
      throw new Error('offline');
    });

    const result = await resolveQuota({
      providerId: 'claude-code',
      now: NOW,
      fetchImpl,
      ...store,
      resolveClaudeAccount: claudeAccount,
      getClaudeAccessToken: async () => 'token',
    });

    expect(result).toMatchObject({
      available: true,
      resolution: 'snapshot-aging',
      source: 'cache',
      capturedSource: 'api',
      freshness: 'aging',
    });
    expect(result.fiveHour.utilization).toBe(42);
    expect(result.failure).toMatchObject({ title: 'Quota API unreachable', isRetryable: true });
  });

  it('reports an auth failure when no credentials and no snapshot exist', async () => {
    const store = memoryStore();

    const result = await resolveQuota({
      providerId: 'claude-code',
      now: NOW,
      ...store,
      resolveClaudeAccount: claudeAccount,
      getClaudeAccessToken: async () => null,
    });

    expect(result).toMatchObject({
      available: false,
      resolution: 'unavailable',
      failureKind: 'auth',
      error: 'No OAuth token available',
    });
    expect(result.failure?.title).toBe('Sign in required');
  });

  it('labels a stale snapshot when the API is not allowed', async () => {
    const store = memoryStore({
      'claude-code:claude-1': sample({ source: 'session', capturedAt: minutesAgo(3 * 60) }),
    });
    const fetchImpl = vi.fn();

    const result = await resolveQuota({
      providerId: 'claude-code',
      now: NOW,
      allowApi: false,
      fetchImpl,
      ...store,
      resolveClaudeAccount: claudeAccount,
    });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      available: true,
      resolution: 'snapshot-stale',
      capturedSource: 'session',
      freshness: 'stale',
      failure: null,
    });
  });

  it('returns an unavailable state when nothing is recorded and the API is not allowed', async () => {
    const result = await resolveQuota({
      providerId: 'claude-code',
      now: NOW,
      allowApi: false,
      ...memoryStore(),
      resolveClaudeAccount: claudeAccount,
    });

    expect(result).toMatchObject({ available: false, resolution: 'unavailable' });
    expect(result.error).toContain('No quota data is available yet');
  });

  describe('codex', () => {
    const codexProfile = {
      id: 'codex-1',
      providerId: 'codex' as const,
      addedAt: '2026-01-01T00:00:00Z',
      label: 'Personal',
      email: 'codex@example.com',
    };

    it('prefers a fresh snapshot over a rollout scan', async () => {
      const store = memoryStore({
        'codex:codex-1': sample({
          source: 'session',
          capturedAt: minutesAgo(1),
          fiveHourLabel: 'Primary',
          sevenDayLabel: 'Secondary',
        }),
      });

      const result = await resolveQuota({
        providerId: 'codex',
        now: NOW,
        ...store,
        resolveCodexAccount: () => codexProfile,
      });

      expect(mockLocalCodex).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        runtimeProvider: 'codex',
        resolution: 'snapshot-fresh',
        capturedSource: 'session',
        accountLabel: 'Personal',
        accountDetail: 'codex@example.com',
      });
    });

    it('uses session-derived rate limits before the API when the snapshot is aging', async () => {
      const store = memoryStore({
        'codex:codex-1': sample({ source: 'session', capturedAt: minutesAgo(20) }),
      });
      mockLocalCodex.mockReturnValue({
        ...sample({ source: 'session', capturedAt: minutesAgo(4) }),
        fiveHour: { utilization: 9, resetsAt: '2026-09-04T14:00:00Z' },
        runtimeProvider: 'codex',
        providerId: 'codex',
      });

      const result = await resolveQuota({
        providerId: 'codex',
        now: NOW,
        workspacePath: '/work/project',
        ...store,
        resolveCodexAccount: () => codexProfile,
      });

      expect(mockLocalCodex).toHaveBeenCalledWith(
        expect.objectContaining({ workspacePath: '/work/project', activeAccount: codexProfile }),
      );
      // The local scan must not return the cache itself; the resolver labels that by age.
      const localOptions = mockLocalCodex.mock.calls[0][0] as { readSnapshot: () => unknown };
      expect(localOptions.readSnapshot()).toBeNull();
      expect(mockCodexApi).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        resolution: 'session',
        source: 'session',
        freshness: 'fresh',
      });
      expect(result.fiveHour.utilization).toBe(9);
    });

    it('calls the API when no rollout carries rate limits and persists the answer', async () => {
      const store = memoryStore();
      mockLocalCodex.mockReturnValue(null);
      mockCodexApi.mockResolvedValue(
        sample({ source: 'api', capturedAt: NOW.toISOString(), providerId: 'codex' }),
      );

      const result = await resolveQuota({
        providerId: 'codex',
        now: NOW,
        ...store,
        resolveCodexAccount: () => codexProfile,
      });

      expect(mockCodexApi).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({ resolution: 'api', source: 'api' });
      expect(store.writes).toEqual([
        expect.objectContaining({ providerId: 'codex', accountId: 'codex-1' }),
      ]);
    });

    it.each(['api', 'session', null] as const)(
      'fetches live quota before logs and a fresh %s snapshot when preferFresh is false',
      async (source) => {
        const store = memoryStore(
          source ? { 'codex:codex-1': sample({ source, capturedAt: minutesAgo(1) }) } : {},
        );
        mockLocalCodex.mockReturnValue(
          sample({
            source: 'session',
            capturedAt: minutesAgo(60),
            fiveHour: { utilization: 30, resetsAt: '2026-09-11T13:00:00Z' },
          }),
        );
        const api = sample({
          source: 'api',
          capturedAt: NOW.toISOString(),
          providerId: 'codex',
          fiveHour: { utilization: 48, resetsAt: '2026-09-11T13:00:00Z' },
          resetCredits: {
            availableCount: 2,
            source: 'api',
            capturedAt: NOW.toISOString(),
            credits: [],
          },
        });
        mockCodexApi.mockResolvedValue(api);

        const result = await resolveQuota({
          providerId: 'codex',
          now: NOW,
          preferFresh: false,
          ...store,
          resolveCodexAccount: () => codexProfile,
        });

        expect(mockCodexApi).toHaveBeenCalledOnce();
        expect(mockLocalCodex).not.toHaveBeenCalled();
        expect(result).toMatchObject({
          resolution: 'api',
          source: 'api',
          freshness: 'fresh',
          fiveHour: { utilization: 48 },
          resetCredits: { availableCount: 2 },
        });
        expect(store.writes).toEqual([{ providerId: 'codex', accountId: 'codex-1', quota: api }]);
      },
    );

    it.each([
      { failureKind: 'auth', httpStatus: 401, title: 'Codex sign-in expired' },
      { failureKind: 'network', title: 'Quota API unreachable' },
      {
        failureKind: 'rate_limit',
        httpStatus: 429,
        retryAfterMs: 45_000,
        title: 'Quota API rate limited',
      },
    ] as const)(
      'retains the $failureKind failure when returning a session fallback',
      async ({ title, ...failure }) => {
        const store = memoryStore();
        const local = sample({ source: 'session', capturedAt: minutesAgo(60) });
        mockCodexApi.mockResolvedValue({
          ...sample({ source: 'api', capturedAt: NOW.toISOString(), providerId: 'codex' }),
          available: false,
          ...failure,
        });
        mockLocalCodex.mockImplementation((options) => {
          expect(mockCodexApi).toHaveBeenCalledOnce();
          options.writeSnapshot('codex', codexProfile.id, local);
          expect(store.writes).toEqual([]);
          return local;
        });

        const result = await resolveQuota({
          providerId: 'codex',
          now: NOW,
          preferFresh: false,
          ...store,
          accountId: 'explicit-account',
          resolveCodexAccount: () => codexProfile,
        });

        expect(result).toMatchObject({
          available: true,
          resolution: 'session',
          source: 'session',
          freshness: 'stale',
          ageMs: 60 * 60_000,
          failure: { title },
        });
        expect(JSON.stringify(result.failure)).not.toMatch(/Claude|Anthropic/);
        expect(store.writes).toEqual([
          { providerId: 'codex', accountId: 'explicit-account', quota: local },
        ]);
        expect(mockCodexApi).toHaveBeenCalledOnce();
      },
    );

    it.each([
      { localTime: minutesAgo(60), cachedTime: minutesAgo(10), winner: 'cache' },
      { localTime: minutesAgo(10), cachedTime: minutesAgo(60), winner: 'session' },
      { localTime: minutesAgo(10), cachedTime: minutesAgo(10), winner: 'cache' },
      { localTime: undefined, cachedTime: minutesAgo(10), winner: 'cache' },
      { localTime: minutesAgo(10), cachedTime: undefined, winner: 'session' },
      { localTime: undefined, cachedTime: undefined, winner: 'cache' },
    ])(
      'selects $winner after an API failure (session: $localTime, cache: $cachedTime)',
      async ({ localTime, cachedTime, winner }) => {
        const ageMs = cachedTime ? NOW.getTime() - Date.parse(cachedTime) : undefined;
        const cached = {
          ...sample({ source: 'cache', capturedAt: minutesAgo(10) }),
          capturedAt: cachedTime,
          capturedSource: 'api' as const,
          ageMs,
          freshness: classifyQuotaFreshness(ageMs),
        };
        const local = {
          ...sample({ source: 'session', capturedAt: minutesAgo(60) }),
          capturedAt: localTime,
        };
        const writeSnapshot = vi.fn();
        mockCodexApi.mockResolvedValue({
          ...sample({ source: 'api', capturedAt: NOW.toISOString(), providerId: 'codex' }),
          available: false,
          failureKind: 'network',
        });
        mockLocalCodex.mockImplementation((options) => {
          options.writeSnapshot('codex', codexProfile.id, local);
          expect(writeSnapshot).not.toHaveBeenCalled();
          return local;
        });

        const result = await resolveQuota({
          providerId: 'codex',
          now: NOW,
          preferFresh: false,
          readSnapshot: () => cached,
          writeSnapshot,
          resolveCodexAccount: () => codexProfile,
        });

        expect(result.source).toBe(winner);
        expect(result.resolution).toBe(
          winner === 'cache' ? `snapshot-${cached.freshness}` : 'session',
        );
        expect(result.capturedAt).toBe(winner === 'cache' ? cachedTime : localTime);
        expect(result.failure?.title).toBe('Quota API unreachable');
        expect(writeSnapshot).toHaveBeenCalledTimes(winner === 'cache' ? 0 : 1);
      },
    );

    it('returns the API failure when neither fallback is available', async () => {
      mockLocalCodex.mockReturnValue(null);
      mockCodexApi.mockResolvedValue({
        ...sample({ source: 'api', capturedAt: NOW.toISOString(), providerId: 'codex' }),
        available: false,
        failureKind: 'auth',
        httpStatus: 401,
      });
      const store = memoryStore();

      const result = await resolveQuota({
        providerId: 'codex',
        now: NOW,
        preferFresh: false,
        ...store,
        resolveCodexAccount: () => codexProfile,
      });

      expect(result).toMatchObject({
        available: false,
        resolution: 'unavailable',
        httpStatus: 401,
        failure: { title: 'Codex sign-in expired' },
      });
      expect(mockCodexApi).toHaveBeenCalledOnce();
      expect(store.writes).toEqual([]);
    });

    it('does not call the API when disabled, even with preferFresh false', async () => {
      mockLocalCodex.mockReturnValue(sample({ source: 'session', capturedAt: minutesAgo(4) }));
      const result = await resolveQuota({
        providerId: 'codex',
        now: NOW,
        preferFresh: false,
        allowApi: false,
        ...memoryStore(),
        resolveCodexAccount: () => codexProfile,
      });

      expect(result).toMatchObject({ available: true, resolution: 'session' });
      expect(mockCodexApi).not.toHaveBeenCalled();
    });
  });

  it('resolves z.ai against the default account id', async () => {
    const store = memoryStore();
    mockZaiApi.mockResolvedValue(
      sample({ source: 'api', capturedAt: NOW.toISOString(), providerId: 'zai', planType: 'lite' }),
    );

    const result = await resolveQuota({ providerId: 'zai', now: NOW, ...store });

    expect(result).toMatchObject({
      runtimeProvider: 'zai',
      resolution: 'api',
      fiveHourLabel: '5-Hour',
      sevenDayLabel: 'Weekly',
    });
    expect(store.writes).toEqual([
      expect.objectContaining({ providerId: 'zai', accountId: 'default' }),
    ]);
  });

  it('gives every caller the same answer from the same persisted store', async () => {
    // One fixture store, written the way the status line writes it.
    writeQuotaSnapshot('claude-code', 'claude-1', {
      ...sample({ source: 'statusline', capturedAt: minutesAgo(2) }),
      providerId: 'claude-code',
    });
    writeQuotaSnapshot('codex', 'codex-1', {
      ...sample({ source: 'session', capturedAt: minutesAgo(30) }),
      providerId: 'codex',
      fiveHourLabel: 'Primary',
      sevenDayLabel: 'Secondary',
    });
    expect(readQuotaSnapshot('claude-code', 'claude-1', NOW)?.capturedSource).toBe('statusline');
    mockLocalCodex.mockReturnValue(null);
    mockCodexApi.mockResolvedValue({
      ...sample({ source: 'api', capturedAt: NOW.toISOString() }),
      available: false,
      error: 'offline',
      failureKind: 'network',
    });

    const options = {
      now: NOW,
      fetchImpl: vi.fn(async () => {
        throw new Error('offline');
      }),
      resolveClaudeAccount: claudeAccount,
      getClaudeAccessToken: async () => 'token',
      resolveCodexAccount: () => ({
        id: 'codex-1',
        providerId: 'codex' as const,
        addedAt: '2026-01-01T00:00:00Z',
      }),
    };

    // `sidekick quota`, `sidekick quota --all`, and `mcp get_quota_status` all
    // build these same options; three calls must agree field for field.
    const [first, second, third] = await Promise.all([
      resolveQuota({ providerId: 'claude-code', ...options }),
      resolveQuota({ providerId: 'claude-code', ...options }),
      resolveQuota({ providerId: 'claude-code', ...options, workspacePath: '/any' }),
    ]);
    expect(second).toEqual(first);
    expect(third).toEqual(first);
    expect(first).toMatchObject({ resolution: 'snapshot-fresh', capturedSource: 'statusline' });

    const codex = await resolveQuota({ providerId: 'codex', ...options });
    expect(codex).toMatchObject({
      resolution: 'snapshot-aging',
      capturedSource: 'session',
      freshness: 'aging',
    });
    expect(codex.failure?.title).toBe('Quota API unreachable');
  });
});
