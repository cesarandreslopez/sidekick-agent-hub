import { describe, expect, it } from 'vitest';
import type { ProviderStatusState } from 'sidekick-shared';
import { formatProviderStatusDisplay } from './providerStatusDisplay';

function status(overrides: Partial<ProviderStatusState>): ProviderStatusState {
  return {
    indicator: 'none',
    description: 'All Systems Operational',
    affectedComponents: [],
    activeIncident: null,
    updatedAt: '2026-06-23T12:00:00.000Z',
    ...overrides,
  };
}

describe('formatProviderStatusDisplay', () => {
  it('hides operational provider status', () => {
    const display = formatProviderStatusDisplay('Claude', status({ indicator: 'none' }));

    expect(display.visible).toBe(false);
  });

  it('summarizes a major outage without flooding the compact banner', () => {
    const display = formatProviderStatusDisplay('Claude', status({
      indicator: 'major',
      description: 'Partial System Outage',
      affectedComponents: [
        { name: 'claude.ai', status: 'major_outage' },
        { name: 'Claude API', status: 'major_outage' },
        { name: 'Claude Code', status: 'degraded_performance' },
        { name: 'Claude Console', status: 'partial_outage' },
      ],
      activeIncident: {
        name: 'Elevated error rate across multiple models',
        impact: 'major',
        shortlink: 'https://status.example/incidents/123',
        updatedAt: '2026-06-23T11:45:00.000Z',
      },
    }));

    expect(display).toMatchObject({
      visible: true,
      providerLabel: 'Claude',
      severity: 'major',
      title: 'Claude: Partial System Outage',
      summary: 'Elevated error rate across multiple models',
      affectedSummary: '4 affected',
      incidentUrl: 'https://status.example/incidents/123',
    });
    expect(display.components).toEqual([
      { name: 'claude.ai', status: 'major outage' },
      { name: 'Claude API', status: 'major outage' },
      { name: 'Claude Code', status: 'degraded performance' },
      { name: 'Claude Console', status: 'partial outage' },
    ]);
  });

  it('falls back to affected component count when there is no incident', () => {
    const display = formatProviderStatusDisplay('OpenAI', status({
      indicator: 'minor',
      description: 'Degraded Performance',
      affectedComponents: [
        { name: 'ChatGPT', status: 'degraded_performance' },
      ],
    }));

    expect(display.visible).toBe(true);
    expect(display.title).toBe('OpenAI: Degraded Performance');
    expect(display.summary).toBe('1 component affected');
    expect(display.affectedSummary).toBe('1 affected');
    expect(display.incidentUrl).toBeUndefined();
  });

  it('preserves untrusted status text as plain display data', () => {
    const display = formatProviderStatusDisplay('Claude', status({
      indicator: 'critical',
      description: '<img src=x onerror=alert(1)>',
      affectedComponents: [
        { name: '<script>alert(1)</script>', status: 'major_outage' },
      ],
      activeIncident: {
        name: '<b>Incident</b>',
        impact: 'critical',
        shortlink: 'javascript:alert(1)',
        updatedAt: '2026-06-23T11:45:00.000Z',
      },
    }));

    expect(display.title).toBe('Claude: <img src=x onerror=alert(1)>');
    expect(display.summary).toBe('<b>Incident</b>');
    expect(display.components[0]).toEqual({
      name: '<script>alert(1)</script>',
      status: 'major outage',
    });
    expect(display.incidentUrl).toBeUndefined();
  });
});
