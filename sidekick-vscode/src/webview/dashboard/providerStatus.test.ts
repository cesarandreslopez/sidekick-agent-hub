// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import { renderDashboardHtml } from '../../providers/dashboardTemplate';
import { formatProviderStatusDisplay } from '../../utils/providerStatusDisplay';
import { renderProviderStatus } from './providerStatus';
import type { ObservedProviderServiceStatus } from 'sidekick-shared/browser';

const status: ObservedProviderServiceStatus = {
  availability: 'observed',
  provider: 'codex',
  severity: 'major',
  description: 'Elevated errors',
  sourceUrl: 'https://status.openai.com/api/v2/summary.json',
  checkedAt: '2026-09-09T12:00:00Z',
  providerUpdatedAt: '2026-09-01T00:00:00Z',
  components: [{ id: 'api', name: 'API', status: 'major_outage' }],
  incidents: [
    {
      id: 'one',
      title: '<script>alert(1)</script>',
      status: 'investigating',
      impact: 'major',
      url: 'https://status.example/one',
      updatedAt: '2026-09-01T00:00:00Z',
      componentIds: ['api'],
    },
    {
      id: 'two',
      title: 'Second incident',
      status: 'monitoring',
      impact: 'minor',
      url: 'https://status.example/two',
      updatedAt: null,
      componentIds: ['unknown'],
    },
  ],
};
beforeEach(() => {
  const html = renderDashboardHtml({
    nonce: 'test',
    cspSource: 'test:',
    chartjsUri: '',
    scriptUri: '',
    iconUri: '',
    extVersion: 'test',
    extDate: '',
    initJson: '{}',
  });
  document.body.innerHTML = new DOMParser().parseFromString(html, 'text/html').body.innerHTML;
});
describe('public status rendering', () => {
  it('renders every incident as text with safe links and keeps details expanded across checks', () => {
    const prefix = 'openai-status';
    renderProviderStatus(document, prefix, formatProviderStatusDisplay('OpenAI', status));
    const section = document.getElementById(`${prefix}-section`)!;
    const details = document.getElementById(`${prefix}-details`)!;
    const toggle = document.getElementById(`${prefix}-toggle`)!;
    expect(section.classList.contains('visible')).toBe(true);
    toggle.click();
    expect(details.hidden).toBe(false);
    expect(details.textContent).toContain('<script>alert(1)</script>');
    expect(details.querySelector('script')).toBeNull();
    expect(details.querySelectorAll('a')).toHaveLength(2);
    expect(details.textContent).toContain('Components: API');
    expect(details.textContent).toContain('unknown (unmapped)');
    expect(details.textContent).toContain('Checked: 2026-09-09T12:00:00Z');
    expect(details.textContent).toContain('Provider updated: 2026-09-01T00:00:00Z');
    renderProviderStatus(
      document,
      prefix,
      formatProviderStatusDisplay('OpenAI', { ...status, checkedAt: '2026-09-09T12:01:00Z' }),
    );
    expect(details.hidden).toBe(false);
  });
  it('replaces an outage with explicit unavailable evidence and clears old incident details', () => {
    renderProviderStatus(document, 'openai-status', formatProviderStatusDisplay('OpenAI', status));
    renderProviderStatus(
      document,
      'openai-status',
      formatProviderStatusDisplay('OpenAI', {
        availability: 'unavailable',
        provider: 'codex',
        checkedAt: status.checkedAt,
        sourceUrl: status.sourceUrl,
        reason: 'network_error',
      }),
    );
    const section = document.getElementById('openai-status-section')!;
    expect(section.classList.contains('status-unavailable')).toBe(true);
    expect(section.textContent).toContain('public status unavailable');
    expect(document.getElementById('openai-status-details')!.querySelectorAll('a')).toHaveLength(0);
  });
});
