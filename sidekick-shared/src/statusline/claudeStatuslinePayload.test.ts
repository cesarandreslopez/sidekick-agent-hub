import { describe, expect, it } from 'vitest';
import {
  parseClaudeStatuslinePayload,
  quotaFromStatuslinePayload,
} from './claudeStatuslinePayload';

const SAMPLE = {
  session_id: 'abc-123',
  transcript_path: '/tmp/transcript.jsonl',
  cwd: '/work/repo',
  model: { id: 'claude-opus-5', display_name: 'Opus' },
  workspace: { current_dir: '/work/repo/pkg', project_dir: '/work/repo', git_worktree: 'feature' },
  cost: { total_cost_usd: 0.4211, total_duration_ms: 45_000, total_lines_added: 12 },
  context_window: {
    total_input_tokens: 40_000,
    total_output_tokens: 2_000,
    context_window_size: 200_000,
    used_percentage: 20,
    remaining_percentage: 80,
    current_usage: null,
  },
  rate_limits: {
    five_hour: { used_percentage: 23.5, resets_at: 1_738_425_600 },
    seven_day: { used_percentage: 41.2, resets_at: 1_738_857_600 },
  },
  prompt_cache: { warm: true, caching_observed: true, hit_ratio: 0.93, requests: 12, misses: 1 },
};

describe('parseClaudeStatuslinePayload', () => {
  it('maps the documented fields and keeps the raw document', () => {
    const parsed = parseClaudeStatuslinePayload(JSON.stringify(SAMPLE));
    expect(parsed).not.toBeNull();
    expect(parsed?.sessionId).toBe('abc-123');
    expect(parsed?.model).toEqual({ id: 'claude-opus-5', displayName: 'Opus' });
    expect(parsed?.workspace?.gitWorktree).toBe('feature');
    expect(parsed?.contextWindow?.usedPercentage).toBe(20);
    expect(parsed?.cost?.totalCostUsd).toBeCloseTo(0.4211);
    expect(parsed?.rateLimits?.fiveHour).toEqual({ usedPercentage: 23.5, resetsAt: 1_738_425_600 });
    expect(parsed?.rateLimits?.spendLimit).toBeUndefined();
    expect(parsed?.promptCache?.hitRatio).toBeCloseTo(0.93);
    expect(parsed?.raw).toMatchObject({ session_id: 'abc-123' });
  });

  it('returns null for empty, malformed, or non-object input', () => {
    expect(parseClaudeStatuslinePayload('')).toBeNull();
    expect(parseClaudeStatuslinePayload('   ')).toBeNull();
    expect(parseClaudeStatuslinePayload('{not json')).toBeNull();
    expect(parseClaudeStatuslinePayload('[1,2]')).toBeNull();
    expect(parseClaudeStatuslinePayload('"str"')).toBeNull();
  });

  it('tolerates missing and null sections', () => {
    const parsed = parseClaudeStatuslinePayload(
      JSON.stringify({
        model: { display_name: 'Opus' },
        context_window: { used_percentage: null },
      }),
    );
    expect(parsed?.contextWindow?.usedPercentage).toBeNull();
    expect(parsed?.rateLimits).toBeUndefined();
    expect(parsed?.cost).toBeUndefined();
  });

  it('drops a rate-limit window that is missing either field', () => {
    const parsed = parseClaudeStatuslinePayload(
      JSON.stringify({ rate_limits: { five_hour: { used_percentage: 10 } } }),
    );
    expect(parsed?.rateLimits).toBeUndefined();
  });
});

describe('quotaFromStatuslinePayload', () => {
  const now = new Date('2026-02-01T12:00:00.000Z');

  it('builds an official quota state from both windows', () => {
    const parsed = parseClaudeStatuslinePayload(JSON.stringify(SAMPLE))!;
    const quota = quotaFromStatuslinePayload(parsed, { now });
    expect(quota).toEqual({
      fiveHour: { utilization: 23.5, resetsAt: new Date(1_738_425_600 * 1000).toISOString() },
      sevenDay: { utilization: 41.2, resetsAt: new Date(1_738_857_600 * 1000).toISOString() },
      available: true,
      providerId: 'claude-code',
      source: 'statusline',
      capturedAt: now.toISOString(),
      stale: false,
    });
  });

  it('returns null without any rate-limit block', () => {
    const parsed = parseClaudeStatuslinePayload(JSON.stringify({ cost: { total_cost_usd: 1 } }))!;
    expect(quotaFromStatuslinePayload(parsed, { now })).toBeNull();
  });

  it('carries a missing window over from the fallback snapshot', () => {
    const parsed = parseClaudeStatuslinePayload(
      JSON.stringify({
        rate_limits: { five_hour: { used_percentage: 5, resets_at: 1_738_425_600 } },
      }),
    )!;
    const quota = quotaFromStatuslinePayload(parsed, {
      now,
      fallback: {
        fiveHour: { utilization: 99, resetsAt: '2026-01-01T00:00:00.000Z' },
        sevenDay: { utilization: 60, resetsAt: '2026-02-05T00:00:00.000Z' },
        available: true,
      },
    });
    expect(quota?.fiveHour.utilization).toBe(5);
    expect(quota?.sevenDay).toEqual({ utilization: 60, resetsAt: '2026-02-05T00:00:00.000Z' });
  });
});
