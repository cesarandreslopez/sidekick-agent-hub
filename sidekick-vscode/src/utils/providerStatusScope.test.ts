import { describe, expect, it } from 'vitest';
import type { ProviderServiceStatus } from 'sidekick-shared';
import { scopeProviderStatuses } from './providerStatusScope';

const claudeDegraded: ProviderServiceStatus = {
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

const openAIDegraded: ProviderServiceStatus = {
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

describe('providerStatusScope', () => {
  it('shows only Claude status for claude-code sessions', () => {
    const scoped = scopeProviderStatuses('claude-code', claudeDegraded, openAIDegraded);

    expect(scoped.claude).toBe(claudeDegraded);
    expect(scoped.openai).toBeNull();
  });

  it('shows only OpenAI status for codex sessions', () => {
    const scoped = scopeProviderStatuses('codex', claudeDegraded, openAIDegraded);

    expect(scoped.claude).toBeNull();
    expect(scoped.openai).toBe(openAIDegraded);
  });

  it('hides provider status entirely for opencode sessions', () => {
    const scoped = scopeProviderStatuses('opencode', claudeDegraded, openAIDegraded);

    expect(scoped.claude).toBeNull();
    expect(scoped.openai).toBeNull();
  });
});
