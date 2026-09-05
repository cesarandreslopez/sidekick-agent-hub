import { describe, expect, it } from 'vitest';
import { escapeHtml, renderHealthHtml } from './health';
import type { DashboardHealthPayload } from '../../types/dashboard';

function payload(overrides: Partial<DashboardHealthPayload> = {}): DashboardHealthPayload {
  return {
    report: {
      schemaVersion: 1,
      generatedAt: '2026-09-04T12:00:00.000Z',
      status: 'attention',
      checks: [
        { id: 'project_slug', status: 'ok', title: 'Project slug', message: 'resolved' },
        {
          id: 'opencode_sqlite',
          status: 'warning',
          title: 'OpenCode sqlite',
          message: '<sqlite3> missing',
          repair: 'brew install sqlite',
        },
      ],
    } as unknown as DashboardHealthPayload['report'],
    providerDiagnostics: [],
    failingTools: [
      {
        tool: 'Bash',
        last7: 6,
        last30: 12,
        categories: { timeout: 10, permission: 2 },
        trend: 'up',
      },
      { tool: 'Read', last7: 0, last30: 8, categories: { not_found: 8 }, trend: 'down' },
    ],
    ...overrides,
  };
}

describe('renderHealthHtml', () => {
  it('renders the banner, checks with repairs, diagnostics, and the trend table, escaped', () => {
    const html = renderHealthHtml(
      payload({
        providerDiagnostics: [
          {
            providerId: 'opencode',
            kind: 'sqlite_unavailable',
            severity: 'warning',
            phase: 'enumerate',
            message: 'sqlite3 not found & unusable',
          } as never,
        ],
      }),
    );
    expect(html.banner).toContain('health-status attention');
    expect(html.banner).toContain('1 item needs attention');
    expect(html.checks).toContain('Repair: brew install sqlite');
    expect(html.checks).toContain('&lt;sqlite3&gt; missing');
    expect(html.checks).not.toContain('<sqlite3>');
    expect(html.diagnostics).toContain('sqlite3 not found &amp; unusable');
    expect(html.tools).toContain('<th>7d</th><th>30d</th>');
    expect(html.tools).toContain('<td>Bash</td><td>6</td><td>12</td>');
    expect(html.tools).toContain('health-trend up');
    expect(html.tools).toContain('<td>Read</td><td>0</td><td>8</td>');
    expect(html.tools).toContain('health-trend down');
  });

  it('shows empty states', () => {
    const html = renderHealthHtml(payload({ failingTools: [] }));
    expect(html.diagnostics).toContain('without diagnostics');
    expect(html.tools).toContain('No tool failures');
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe(
      '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;',
    );
  });
});
