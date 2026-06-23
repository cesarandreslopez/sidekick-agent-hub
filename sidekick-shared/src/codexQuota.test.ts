import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  fetchCodexQuotaFromApi,
  quotaFromCodexRateLimits,
  readLatestCodexQuotaFromRollouts,
  resolveCodexQuota,
  resolveCodexQuotaFromLocalSources,
} from './codexQuota';
import type { CodexProvider } from './providers/codex';

let tmpDir: string;

function writeRollout(lines: unknown[]): string {
  const filePath = path.join(tmpDir, 'sessions', '2026', '05', '19', 'rollout-test.jsonl');
  writeRolloutAt(filePath, lines);
  return filePath;
}

function writeRolloutAt(filePath: string, lines: unknown[]): string {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, lines.map((line) => JSON.stringify(line)).join('\n') + '\n');
  return filePath;
}

function writeAuth(accessToken = 'codex-access-token'): string {
  const codexHome = path.join(tmpDir, '.codex');
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(
    path.join(codexHome, 'auth.json'),
    JSON.stringify({
      auth_mode: 'chatgpt',
      tokens: { access_token: accessToken },
    }),
  );
  return codexHome;
}

describe('codexQuota', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-codex-quota-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('converts upstream rate-limit snapshots with nullable reset fields', () => {
    const quota = quotaFromCodexRateLimits(
      {
        limit_id: 'codex',
        primary: { used_percent: 12, window_minutes: 300, resets_at: null },
        secondary: { used_percent: 34, window_minutes: null, resets_at: 1_900_000_000 },
        plan_type: 'pro',
        rate_limit_reached_type: 'workspace_member_usage_limit_reached',
      },
      'session',
      '2026-05-19T12:00:00Z',
    );

    expect(quota).toMatchObject({
      available: true,
      source: 'session',
      capturedAt: '2026-05-19T12:00:00Z',
      fiveHour: { utilization: 12, resetsAt: '' },
      sevenDay: { utilization: 34, resetsAt: '2030-03-17T17:46:40.000Z' },
      fiveHourLabel: 'Primary',
      sevenDayLabel: 'Secondary',
      planType: 'pro',
      rateLimitReachedType: 'workspace_member_usage_limit_reached',
    });
  });

  it('adds elapsed-window projections to Codex quota snapshots', () => {
    const quota = quotaFromCodexRateLimits(
      {
        limit_id: 'codex',
        primary: {
          used_percent: 40,
          window_minutes: 300,
          resets_at: Date.parse('2026-03-12T14:00:00Z') / 1000,
        },
        secondary: {
          used_percent: 70,
          window_minutes: 10_080,
          resets_at: Date.parse('2026-03-13T12:00:00Z') / 1000,
        },
      },
      'api',
      '2026-03-12T12:00:00Z',
    );

    expect(quota).toMatchObject({
      projectedFiveHour: 67,
      projectedSevenDay: 82,
    });
  });

  it('uses 5-hour and 7-day projection defaults when Codex window lengths are missing', () => {
    const quota = quotaFromCodexRateLimits(
      {
        limit_id: 'codex',
        primary: {
          used_percent: 40,
          window_minutes: null,
          resets_at: Date.parse('2026-03-12T14:00:00Z') / 1000,
        },
        secondary: {
          used_percent: 70,
          resets_at: Date.parse('2026-03-13T12:00:00Z') / 1000,
        },
      },
      'api',
      '2026-03-12T12:00:00Z',
    );

    expect(quota).toMatchObject({
      projectedFiveHour: 67,
      projectedSevenDay: 82,
    });
  });

  it('tails rollout files for the latest token_count rate_limits even when usage info is null', () => {
    const rollout = writeRollout([
      {
        timestamp: '2026-05-19T10:00:00Z',
        type: 'event_msg',
        payload: { type: 'token_count', info: null, rate_limits: null },
      },
      {
        timestamp: '2026-05-19T10:05:00Z',
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: null,
          rate_limits: {
            limit_id: 'codex',
            primary: { used_percent: 6, window_minutes: 300, resets_at: 1_779_235_112 },
            secondary: { used_percent: 1, window_minutes: 10_080, resets_at: 1_779_821_912 },
            credits: { hasCredits: true, unlimited: false, balance: '10.00' },
          },
        },
      },
    ]);

    const quota = readLatestCodexQuotaFromRollouts([rollout]);

    expect(quota).toMatchObject({
      available: true,
      source: 'session',
      capturedAt: '2026-05-19T10:05:00Z',
      fiveHour: { utilization: 6 },
      sevenDay: { utilization: 1 },
      fiveHourLabel: 'Primary',
      sevenDayLabel: 'Secondary',
      credits: { hasCredits: true, unlimited: false, balance: '10.00' },
    });
  });

  it('selects the newest quota snapshot from multiple rollout files', () => {
    const older = writeRolloutAt(
      path.join(tmpDir, 'sessions', '2026', '05', '19', 'rollout-old.jsonl'),
      [
        {
          timestamp: '2026-05-19T10:00:00Z',
          type: 'event_msg',
          payload: {
            type: 'token_count',
            info: null,
            rate_limits: {
              primary: { used_percent: 8, window_minutes: 300, resets_at: 1_779_235_112 },
            },
          },
        },
      ],
    );
    const newer = writeRolloutAt(
      path.join(tmpDir, 'sessions', '2026', '05', '19', 'rollout-new.jsonl'),
      [
        {
          timestamp: '2026-05-19T10:15:00Z',
          type: 'event_msg',
          payload: {
            type: 'token_count',
            info: null,
            rate_limits: {
              primary: { used_percent: 49, window_minutes: 300, resets_at: 1_779_236_012 },
              secondary: { used_percent: 44, window_minutes: 10_080, resets_at: 1_779_822_812 },
            },
          },
        },
      ],
    );

    const quota = readLatestCodexQuotaFromRollouts([older, newer]);

    expect(quota).toMatchObject({
      capturedAt: '2026-05-19T10:15:00Z',
      fiveHour: { utilization: 49 },
      sevenDay: { utilization: 44 },
    });
  });

  it('keeps the highest same-window utilization when Codex snapshots disagree', () => {
    const lowerNewer = writeRolloutAt(
      path.join(tmpDir, 'sessions', '2026', '05', '19', 'rollout-lower-newer.jsonl'),
      [
        {
          timestamp: '2026-05-19T10:15:00Z',
          type: 'event_msg',
          payload: {
            type: 'token_count',
            info: null,
            rate_limits: {
              primary: { used_percent: 50, window_minutes: 300, resets_at: 1_779_236_012 },
              secondary: { used_percent: 44, window_minutes: 10_080, resets_at: 1_779_822_812 },
            },
          },
        },
      ],
    );
    const higherOlder = writeRolloutAt(
      path.join(tmpDir, 'sessions', '2026', '05', '19', 'rollout-higher-older.jsonl'),
      [
        {
          timestamp: '2026-05-19T10:10:00Z',
          type: 'event_msg',
          payload: {
            type: 'token_count',
            info: null,
            rate_limits: {
              primary: { used_percent: 52, window_minutes: 300, resets_at: 1_779_236_012 },
              secondary: { used_percent: 45, window_minutes: 10_080, resets_at: 1_779_822_812 },
            },
          },
        },
      ],
    );

    const quota = readLatestCodexQuotaFromRollouts([lowerNewer, higherOlder]);

    expect(quota).toMatchObject({
      capturedAt: '2026-05-19T10:10:00Z',
      fiveHour: { utilization: 52 },
      sevenDay: { utilization: 45 },
    });
  });

  it('prefers the newest quota across workspace and account Codex sessions', () => {
    const workspaceRollout = writeRolloutAt(
      path.join(tmpDir, 'workspace-rollouts', 'rollout-workspace.jsonl'),
      [
        {
          timestamp: '2026-05-19T10:00:00Z',
          type: 'event_msg',
          payload: {
            type: 'token_count',
            info: null,
            rate_limits: {
              primary: { used_percent: 8, window_minutes: 300, resets_at: 1_779_235_112 },
              secondary: { used_percent: 2, window_minutes: 10_080, resets_at: 1_779_821_912 },
            },
          },
        },
      ],
    );
    const codexHome = path.join(tmpDir, '.codex');
    writeRolloutAt(path.join(codexHome, 'sessions', '2026', '05', '19', 'rollout-account.jsonl'), [
      {
        timestamp: '2026-05-19T10:15:00Z',
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: null,
          rate_limits: {
            primary: { used_percent: 49, window_minutes: 300, resets_at: 1_779_236_012 },
            secondary: { used_percent: 44, window_minutes: 10_080, resets_at: 1_779_822_812 },
          },
        },
      },
    ]);
    const provider = {
      findAllSessions: vi.fn(() => [workspaceRollout]),
      dispose: vi.fn(),
    } as unknown as CodexProvider;

    const quota = resolveCodexQuotaFromLocalSources({
      provider,
      workspacePath: '/workspace',
      codexHome,
      activeAccount: null,
    });

    expect(quota).toMatchObject({
      runtimeProvider: 'codex',
      available: true,
      source: 'session',
      capturedAt: '2026-05-19T10:15:00Z',
      fiveHour: { utilization: 49 },
      sevenDay: { utilization: 44 },
    });
  });

  it('fetches Codex quota from the ChatGPT usage API with explicit auth', async () => {
    const codexHome = writeAuth('fresh-token');
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        plan_type: 'pro',
        rate_limit: {
          primary_window: {
            used_percent: 21,
            limit_window_seconds: 18_000,
            reset_at: 1_900_000_000,
          },
          secondary_window: {
            used_percent: 4,
            limit_window_seconds: 604_800,
            reset_at: 1_900_100_000,
          },
        },
      }),
    });

    const quota = await fetchCodexQuotaFromApi({
      codexHome,
      fetchImpl,
      capturedAt: '2026-05-19T12:00:00Z',
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://chatgpt.com/backend-api/wham/usage',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({ Authorization: 'Bearer fresh-token' }),
      }),
    );
    expect(quota).toMatchObject({
      available: true,
      providerId: 'codex',
      source: 'api',
      capturedAt: '2026-05-19T12:00:00Z',
      planType: 'pro',
      fiveHour: { utilization: 21, resetsAt: '2030-03-17T17:46:40.000Z' },
      sevenDay: { utilization: 4, resetsAt: '2030-03-18T21:33:20.000Z' },
    });
  });

  it('does not refresh from the API without ChatGPT auth', async () => {
    const codexHome = path.join(tmpDir, '.codex');
    fs.mkdirSync(codexHome, { recursive: true });
    fs.writeFileSync(
      path.join(codexHome, 'auth.json'),
      JSON.stringify({
        auth_mode: 'api_key',
        OPENAI_API_KEY: 'sk-test',
      }),
    );

    const quota = await fetchCodexQuotaFromApi({ codexHome, fetchImpl: vi.fn() });

    expect(quota).toMatchObject({
      available: false,
      failureKind: 'auth',
      source: 'api',
      error: 'Codex API refresh requires a ChatGPT login.',
    });
  });

  it('falls back to local rollout data when explicit API refresh fails', async () => {
    const rollout = writeRollout([
      {
        timestamp: '2026-05-19T10:05:00Z',
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: null,
          rate_limits: {
            primary: { used_percent: 44, window_minutes: 300, resets_at: 1_900_000_000 },
          },
        },
      },
    ]);
    const provider = {
      findAllSessions: vi.fn(() => [rollout]),
      dispose: vi.fn(),
    } as unknown as CodexProvider;
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      headers: { get: () => null },
    });

    const quota = await resolveCodexQuota({
      source: 'api',
      provider,
      fetchImpl,
      accessToken: 'token',
      activeAccount: null,
      workspacePath: tmpDir,
      codexHome: path.join(tmpDir, '.codex-empty'),
    });

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(quota).toMatchObject({
      runtimeProvider: 'codex',
      available: true,
      source: 'session',
      fiveHour: { utilization: 44 },
    });
  });
});
