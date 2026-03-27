import { describe, expect, it } from 'vitest';
import type { ProviderStatusState } from 'sidekick-shared';
import { scopeProviderStatuses } from './providerStatusScope';

const claudeDegraded: ProviderStatusState = {
  indicator: 'minor',
  description: 'Partially degraded service',
  affectedComponents: [{ name: 'Claude API', status: 'degraded_performance' }],
  activeIncident: null,
  updatedAt: '2026-03-27T00:00:00.000Z',
};

const openAIDegraded: ProviderStatusState = {
  indicator: 'major',
  description: 'Major outage',
  affectedComponents: [{ name: 'ChatGPT', status: 'major_outage' }],
  activeIncident: null,
  updatedAt: '2026-03-27T00:00:00.000Z',
};

describe('providerStatusScope', () => {
  it('shows only Claude status for claude-code sessions', () => {
    const scoped = scopeProviderStatuses('claude-code', claudeDegraded, openAIDegraded);

    expect(scoped.claude).toBe(claudeDegraded);
    expect(scoped.openai.indicator).toBe('none');
  });

  it('shows only OpenAI status for codex sessions', () => {
    const scoped = scopeProviderStatuses('codex', claudeDegraded, openAIDegraded);

    expect(scoped.claude.indicator).toBe('none');
    expect(scoped.openai).toBe(openAIDegraded);
  });

  it('hides provider status entirely for opencode sessions', () => {
    const scoped = scopeProviderStatuses('opencode', claudeDegraded, openAIDegraded);

    expect(scoped.claude.indicator).toBe('none');
    expect(scoped.openai.indicator).toBe('none');
  });
});
