import { describe, expect, it } from 'vitest';
import type { ProviderStatusState } from './ProviderStatusService';
import { scopeDashboardProviderStatuses } from './providerStatusScope';

const claudeStatus: ProviderStatusState = {
  availability: 'observed',
  provider: 'claude-code',
  sourceUrl: 'https://status.claude.com/api/v2/summary.json',
  providerUpdatedAt: null,
  severity: 'minor',
  description: 'Partially degraded service',
  components: [{ id: 'component', name: 'Claude API', status: 'degraded_performance' }],
  incidents: [],
  checkedAt: '2026-03-27T00:00:00.000Z',
};

const openaiStatus: ProviderStatusState = {
  availability: 'observed',
  provider: 'codex',
  sourceUrl: 'https://status.openai.com/api/v2/summary.json',
  providerUpdatedAt: null,
  severity: 'major',
  description: 'Major outage',
  components: [{ id: 'component', name: 'ChatGPT', status: 'major_outage' }],
  incidents: [],
  checkedAt: '2026-03-27T00:00:00.000Z',
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
