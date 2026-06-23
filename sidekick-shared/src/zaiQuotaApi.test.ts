import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  quotaStateFromZaiQuotaLimitPayload,
  readZaiCredentials,
  resolveZaiQuota,
} from './zaiQuotaApi';

const FIVE_RESET = Date.parse('2026-06-25T15:47:00Z');
const WEEKLY_RESET = Date.parse('2026-06-25T15:47:00Z') + 3 * 86_400_000;

function payloadWithLimits(limits: unknown[]) {
  return {
    code: 200,
    msg: 'Operation successful',
    success: true,
    data: {
      level: 'lite',
      limits,
    },
  };
}

describe('zaiQuotaApi', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('maps z.ai TOKENS_LIMIT windows directly to quota utilization', () => {
    const quota = quotaStateFromZaiQuotaLimitPayload(
      payloadWithLimits([
        { type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 1, nextResetTime: FIVE_RESET },
        { type: 'TOKENS_LIMIT', unit: 6, number: 1, percentage: 20, nextResetTime: WEEKLY_RESET },
        { type: 'TIME_LIMIT', unit: 5, number: 1, percentage: 0, nextResetTime: WEEKLY_RESET },
      ]),
      '2026-06-22T10:50:00Z',
    );

    expect(quota).toMatchObject({
      available: true,
      providerId: 'zai',
      source: 'api',
      capturedAt: '2026-06-22T10:50:00Z',
      fiveHour: { utilization: 1, resetsAt: '2026-06-25T15:47:00.000Z' },
      sevenDay: { utilization: 20, resetsAt: new Date(WEEKLY_RESET).toISOString() },
      fiveHourLabel: '5-Hour',
      sevenDayLabel: 'Weekly',
      planType: 'lite',
      limitName: 'z.ai Lite',
    });
  });

  it('identifies five-hour and weekly token windows even when API order changes', () => {
    const quota = quotaStateFromZaiQuotaLimitPayload(
      payloadWithLimits([
        { type: 'TOKENS_LIMIT', unit: 6, number: 1, percentage: 24, nextResetTime: WEEKLY_RESET },
        { type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 36, nextResetTime: FIVE_RESET },
      ]),
      '2026-06-22T10:50:00Z',
    );

    expect(quota.fiveHour.utilization).toBe(36);
    expect(quota.sevenDay.utilization).toBe(24);
  });

  it('adds elapsed-window projections from z.ai reset timestamps', () => {
    const quota = quotaStateFromZaiQuotaLimitPayload(
      payloadWithLimits([
        { type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 40, nextResetTime: FIVE_RESET },
        { type: 'TOKENS_LIMIT', unit: 6, number: 1, percentage: 20, nextResetTime: WEEKLY_RESET },
      ]),
      new Date(FIVE_RESET - 3 * 60 * 60_000).toISOString(),
    );

    expect(quota.projectedFiveHour).toBe(100);
    expect(quota.projectedSevenDay).toBe(36);
  });

  it('prefers OpenCode zai-coding-plan auth over environment credentials', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-zai-auth-'));
    fs.writeFileSync(
      path.join(tmpDir, 'auth.json'),
      JSON.stringify({
        zai: { type: 'api', key: 'zai-token' },
        'zai-coding-plan': { type: 'api', key: 'coding-plan-token' },
      }),
    );

    try {
      const credentials = readZaiCredentials({
        openCodeDataDir: tmpDir,
        env: {
          ANTHROPIC_BASE_URL: 'https://open.bigmodel.cn/api/anthropic',
          ANTHROPIC_AUTH_TOKEN: 'env-token',
        },
      });

      expect(credentials).toEqual({
        authToken: 'coding-plan-token',
        baseUrl: 'https://api.z.ai/api/anthropic',
        platform: 'ZAI',
        source: 'opencode',
      });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('falls back to official plugin environment credentials', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-zai-empty-auth-'));
    try {
      const credentials = readZaiCredentials({
        openCodeDataDir: tmpDir,
        env: {
          ANTHROPIC_BASE_URL: 'https://open.bigmodel.cn/api/anthropic',
          ANTHROPIC_AUTH_TOKEN: 'env-token',
        },
      });

      expect(credentials).toEqual({
        authToken: 'env-token',
        baseUrl: 'https://open.bigmodel.cn/api/anthropic',
        platform: 'ZHIPU',
        source: 'env',
      });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('returns an auth failure without leaking the token when credentials are rejected', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ code: 401, msg: 'bad token secret-token' }), { status: 401 }),
    );

    const quota = await resolveZaiQuota({
      credentials: {
        authToken: 'secret-token',
        baseUrl: 'https://api.z.ai/api/anthropic',
        platform: 'ZAI',
        source: 'env',
      },
      fetchImpl,
      readSnapshot: () => null,
      writeSnapshot: vi.fn(),
    });

    expect(quota.available).toBe(false);
    expect(quota.failureKind).toBe('auth');
    expect(quota.error).not.toContain('secret-token');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
