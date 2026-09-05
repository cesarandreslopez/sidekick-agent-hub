import { describe, expect, it } from 'vitest';
import type { ActiveAccountStatus, ClaudeStatuslinePayload } from 'sidekick-shared/statusline';
import { sidekickStateFileSchema } from 'sidekick-shared/schemas';
import { buildStatuslineState } from './statusline';

const accounts: ActiveAccountStatus = {
  ok: true,
  claude: { present: true, accountId: 'acct-claude', email: 'a@example.com', label: 'Work' },
  codex: { present: true, accountId: 'acct-codex', label: 'Codex' },
};

const live: ClaudeStatuslinePayload = {
  sessionId: 'sess-1',
  cwd: '/fallback',
  model: { id: 'claude-sonnet-4-5', displayName: 'Sonnet' },
  workspace: { currentDir: '/work/project' },
  contextWindow: {
    usedPercentage: 37,
    contextWindowSize: 200_000,
    totalInputTokens: 60_000,
    totalOutputTokens: 14_000,
  },
  cost: { totalCostUsd: 0.42, totalDurationMs: 600_000, totalLinesAdded: 12, totalLinesRemoved: 3 },
  promptCache: { hitRatio: 0.93 },
  raw: {},
};

describe('buildStatuslineState', () => {
  it('projects the account, quotas, and live payload onto the public contract', () => {
    const state = buildStatuslineState(
      accounts,
      {
        fiveHour: { utilization: 42, resetsAt: '2026-09-04T15:00:00Z' },
        sevenDay: { utilization: 61, resetsAt: '' },
        available: true,
        source: 'cache',
        capturedSource: 'statusline',
        capturedAt: '2026-09-04T12:00:00Z',
        ageMs: 1000,
        freshness: 'fresh',
      },
      null,
      live,
    );

    expect(state).toEqual({
      writer: 'statusline',
      account: { providerId: 'claude-code', id: 'acct-claude', label: 'Work' },
      quota: {
        claude: {
          fiveHour: { utilization: 42, resetsAt: '2026-09-04T15:00:00Z' },
          sevenDay: { utilization: 61, resetsAt: '' },
          source: 'cache',
          capturedSource: 'statusline',
          capturedAt: '2026-09-04T12:00:00Z',
          ageMs: 1000,
          freshness: 'fresh',
        },
        codex: null,
      },
      context: {
        usedPercentage: 37,
        contextWindowSize: 200_000,
        totalInputTokens: 60_000,
        totalOutputTokens: 14_000,
      },
      session: {
        sessionId: 'sess-1',
        cwd: '/work/project',
        model: 'claude-sonnet-4-5',
        costUsd: 0.42,
        durationMs: 600_000,
        linesAdded: 12,
        linesRemoved: 3,
        promptCacheHitRatio: 0.93,
      },
      billingBlock: null,
    });
    expect(
      sidekickStateFileSchema.safeParse({
        schemaVersion: 1,
        writtenAt: '2026-09-04T12:00:00.000Z',
        ...state,
      }).success,
    ).toBe(true);
  });

  it('falls back to the Codex account and nulls without a live payload', () => {
    const state = buildStatuslineState(
      { ...accounts, claude: { present: false } },
      null,
      {
        fiveHour: { utilization: 5, resetsAt: '' },
        sevenDay: { utilization: 9, resetsAt: '' },
        available: true,
        source: 'session',
      },
      null,
    );
    expect(state.account).toEqual({ providerId: 'codex', id: 'acct-codex', label: 'Codex' });
    expect(state.quota.claude).toBeNull();
    expect(state.quota.codex?.source).toBe('session');
    expect(state.context).toBeNull();
    expect(state.session).toBeNull();

    expect(
      buildStatuslineState(
        { ok: false, claude: { present: false }, codex: { present: false } },
        null,
        null,
        { raw: {} },
      ).account,
    ).toBeNull();
  });
});
