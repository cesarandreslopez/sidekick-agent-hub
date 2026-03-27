import { describe, expect, it } from 'vitest';
import type { ProviderStatusState } from './ProviderStatusService';
import { scopeDashboardProviderStatuses } from './providerStatusScope';

const claudeStatus: ProviderStatusState = {
  indicator: 'minor',
  description: 'Partially degraded service',
  affectedComponents: [{ name: 'Claude API', status: 'degraded_performance' }],
  activeIncident: null,
  updatedAt: '2026-03-27T00:00:00.000Z',
};

const openaiStatus: ProviderStatusState = {
  indicator: 'major',
  description: 'Major outage',
  affectedComponents: [{ name: 'ChatGPT', status: 'major_outage' }],
  activeIncident: null,
  updatedAt: '2026-03-27T00:00:00.000Z',
};

describe('scopeDashboardProviderStatuses', () => {
  it('keeps only Claude status for claude-code', () => {
    expect(scopeDashboardProviderStatuses('claude-code', claudeStatus, openaiStatus)).toEqual({
      providerStatus: claudeStatus,
      openaiStatus: null,
    });
  });

  it('keeps only OpenAI status for codex', () => {
    expect(scopeDashboardProviderStatuses('codex', claudeStatus, openaiStatus)).toEqual({
      providerStatus: null,
      openaiStatus,
    });
  });

  it('hides both statuses for opencode', () => {
    expect(scopeDashboardProviderStatuses('opencode', claudeStatus, openaiStatus)).toEqual({
      providerStatus: null,
      openaiStatus: null,
    });
  });
});
