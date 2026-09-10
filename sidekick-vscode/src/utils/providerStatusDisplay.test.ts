import { describe, expect, it } from 'vitest';
import type { ObservedProviderServiceStatus } from 'sidekick-shared';
import { formatProviderStatusDisplay } from './providerStatusDisplay';
function status(
  overrides: Partial<ObservedProviderServiceStatus> = {},
): ObservedProviderServiceStatus {
  return {
    availability: 'observed',
    provider: 'claude-code',
    sourceUrl: 'https://status.claude.com/api/v2/summary.json',
    checkedAt: '2026-09-09T12:00:00Z',
    providerUpdatedAt: '2026-09-01T00:00:00Z',
    severity: 'none',
    description: 'All Systems Operational',
    components: [],
    incidents: [],
    ...overrides,
  };
}
const incident = {
  id: 'incident-a',
  title: 'Errors',
  impact: 'major',
  status: 'investigating',
  url: 'https://status.example/incidents/123',
  updatedAt: '2026-09-01T00:00:00Z',
  componentIds: ['api'],
};
describe('formatProviderStatusDisplay', () => {
  it('hides fully observed operational status', () => {
    expect(formatProviderStatusDisplay('Claude', status()).visible).toBe(false);
  });
  it('shows unavailable status independently of severity', () => {
    expect(
      formatProviderStatusDisplay('Claude', {
        availability: 'unavailable',
        provider: 'claude-code',
        checkedAt: '2026-09-09T00:00:00Z',
        sourceUrl: 'https://status.claude.com/api/v2/summary.json',
        reason: 'network_error',
      }),
    ).toMatchObject({
      visible: true,
      severity: 'unavailable',
      title: 'Claude public status unavailable',
    });
  });
  it('shows partially observed status instead of claiming there are no incidents', () => {
    expect(formatProviderStatusDisplay('OpenAI', status({ incidents: null }))).toMatchObject({
      visible: true,
      summary: 'Incident information unavailable.',
    });
  });
  it('preserves multiple incidents, associations and check/update timestamps', () => {
    const display = formatProviderStatusDisplay(
      'Claude',
      status({
        severity: 'major',
        components: [{ id: 'api', name: 'API', status: 'major_outage' }],
        incidents: [
          incident,
          { ...incident, id: 'incident-b', title: 'Other issue', componentIds: ['unknown-id'] },
        ],
      }),
    );
    expect(display).toMatchObject({
      visible: true,
      severity: 'major',
      affectedSummary: '1 affected',
      checkedAt: '2026-09-09T12:00:00Z',
      providerUpdatedAt: '2026-09-01T00:00:00Z',
    });
    expect(display.incidents).toHaveLength(2);
    expect(display.incidents[0].detail).toContain('Components: API');
    expect(display.incidents[1].detail).toContain('unknown-id (unmapped)');
  });
  it('keeps untrusted text plain and rejects unsafe links', () => {
    const display = formatProviderStatusDisplay(
      'Claude',
      status({
        severity: 'critical',
        description: '<img src=x>',
        incidents: [{ ...incident, title: '<b>Incident</b>', url: 'javascript:alert(1)' }],
      }),
    );
    expect(display.title).toContain('<img src=x>');
    expect(display.summary).toBe('<b>Incident</b>');
    expect(display.incidentUrl).toBeUndefined();
    expect(display.incidents[0].url).toBeUndefined();
  });
});
