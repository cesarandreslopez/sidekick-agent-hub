import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { QuotaState } from './quota';

const mockFetchQuota = vi.hoisted(() => vi.fn());

vi.mock('./quota', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./quota')>();
  return { ...actual, fetchQuota: (...args: unknown[]) => mockFetchQuota(...args) };
});

import { QuotaPoller } from './quotaPoller';

const unavailable = (failureKind: QuotaState['failureKind']): QuotaState => ({
  fiveHour: { utilization: 0, resetsAt: '' },
  sevenDay: { utilization: 0, resetsAt: '' },
  available: false,
  error: 'unavailable',
  failureKind,
});

async function flushPoll(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('QuotaPoller', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockFetchQuota.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('never backs off faster than the selected base interval', async () => {
    mockFetchQuota.mockResolvedValue(unavailable('network'));
    const timerSpy = vi.spyOn(globalThis, 'setTimeout');
    const poller = new QuotaPoller({
      getAccessToken: async () => 'token',
      activeIntervalMs: 1_000,
      idleIntervalMs: 5_000,
      maxBackoffMs: 500,
    });

    poller.start();
    await flushPoll();

    expect(timerSpy).toHaveBeenLastCalledWith(expect.any(Function), 1_000);
    poller.stop();
  });

  it('keeps polling at idle cadence after an auth response', async () => {
    mockFetchQuota.mockResolvedValue(unavailable('auth'));
    const poller = new QuotaPoller({
      getAccessToken: async () => 'token',
      activeIntervalMs: 1_000,
      idleIntervalMs: 5_000,
    });

    poller.start();
    await flushPoll();
    await vi.advanceTimersByTimeAsync(5_000);
    await flushPoll();

    expect(mockFetchQuota).toHaveBeenCalledTimes(2);
    poller.stop();
  });

  it('notifies listeners when access-token retrieval fails', async () => {
    const poller = new QuotaPoller({
      getAccessToken: async () => {
        throw new Error('credential store unavailable');
      },
      activeIntervalMs: 1_000,
    });
    const listener = vi.fn();
    poller.onUpdate(listener);

    poller.start();
    await flushPoll();

    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({
        available: false,
        failureKind: 'auth',
        error: 'credential store unavailable',
      }),
    );
    poller.stop();
  });

  it('stays dormant without an account and wakes on account changes', async () => {
    let token: string | null = null;
    let accountListener: (() => void) | undefined;
    mockFetchQuota.mockResolvedValue({
      fiveHour: { utilization: 1, resetsAt: '' },
      sevenDay: { utilization: 2, resetsAt: '' },
      available: true,
    });
    const poller = new QuotaPoller({
      getAccessToken: async () => token,
      subscribeAccountsChanged: (listener) => {
        accountListener = () => listener({} as never);
        return { dispose: vi.fn() };
      },
    });

    poller.start();
    await flushPoll();
    expect(mockFetchQuota).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);

    token = 'token';
    accountListener?.();
    await flushPoll();
    expect(mockFetchQuota).toHaveBeenCalledOnce();
    poller.stop();
  });

  it('retries instead of parking when the account exists but its token is unreadable', async () => {
    let token: string | null = null;
    mockFetchQuota.mockResolvedValue({
      fiveHour: { utilization: 1, resetsAt: '' },
      sevenDay: { utilization: 2, resetsAt: '' },
      available: true,
    });
    const poller = new QuotaPoller({
      hasAccount: () => true,
      getAccessToken: async () => token,
      activeIntervalMs: 1_000,
      idleIntervalMs: 5_000,
      subscribeAccountsChanged: () => ({ dispose: vi.fn() }),
    });

    poller.start();
    await flushPoll();
    // A transient credential failure never changes the account fingerprint,
    // so no wake would arrive — the poller must keep a retry timer alive.
    expect(mockFetchQuota).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);

    token = 'token';
    await vi.advanceTimersByTimeAsync(5_000);
    await flushPoll();
    expect(mockFetchQuota).toHaveBeenCalledOnce();
    poller.stop();
  });

  it('does not lose an account change while an account check is in flight', async () => {
    let accountListener: (() => void) | undefined;
    let resolveFirstCheck: ((present: boolean) => void) | undefined;
    let accountChecks = 0;
    mockFetchQuota.mockResolvedValue({
      fiveHour: { utilization: 1, resetsAt: '' },
      sevenDay: { utilization: 2, resetsAt: '' },
      available: true,
    });
    const poller = new QuotaPoller({
      hasAccount: () => {
        accountChecks++;
        if (accountChecks > 1) return true;
        return new Promise<boolean>((resolve) => {
          resolveFirstCheck = resolve;
        });
      },
      getAccessToken: async () => 'token',
      subscribeAccountsChanged: (listener) => {
        accountListener = () => listener({} as never);
        return { dispose: vi.fn() };
      },
    });

    poller.start();
    await flushPoll();
    accountListener?.();
    resolveFirstCheck?.(false);
    await flushPoll();
    await flushPoll();

    expect(accountChecks).toBe(2);
    expect(mockFetchQuota).toHaveBeenCalledOnce();
    poller.stop();
  });
});
