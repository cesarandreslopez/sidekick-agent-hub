/**
 * Health tab (typed): renders the shared doctor report, the session-provider
 * diagnostics, and the failing-tool trend table. `renderHealthHtml` is the
 * pure, unit-tested core; `createHealthView` binds it to the document.
 *
 * @module webview/dashboard/health
 */

import type { DashboardHealthPayload, DashboardWebviewMessage } from '../../types/dashboard';

// Kept local rather than imported from sidekick-shared/browser: the shared
// package is CommonJS, so one helper would pull the whole browser entry
// into this bundle. The rows arrive pre-merged from the extension.
const TREND_ARROWS: Record<string, string> = { up: '↑', down: '↓', flat: '→' };

export const HEALTH_IDS = {
  loading: 'health-loading',
  banner: 'health-banner',
  checks: 'health-checks',
  diagnostics: 'health-diagnostics',
  tools: 'health-tools',
  refresh: 'health-refresh',
} as const;

export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const CHECK_ICONS: Record<string, string> = { ok: '✓', warning: '!', error: '✕', info: '·' };

export interface HealthHtml {
  banner: string;
  checks: string;
  diagnostics: string;
  tools: string;
}

/** The four sections of the Health tab as HTML fragments. */
export function renderHealthHtml(data: DashboardHealthPayload): HealthHtml {
  const { report } = data;
  const attention = report.checks.filter(
    (check) => check.status === 'warning' || check.status === 'error',
  ).length;
  const generated = new Date(report.generatedAt);
  const generatedLabel = Number.isNaN(generated.getTime())
    ? ''
    : generated.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const banner =
    `<div class="health-status ${escapeHtml(report.status)}">` +
    `<span class="health-status-label">${escapeHtml(report.status)}</span>` +
    `<span class="health-status-detail">${attention === 0 ? 'Nothing needs attention' : attention === 1 ? '1 item needs attention' : `${attention} items need attention`}` +
    (generatedLabel ? ` · checked ${escapeHtml(generatedLabel)}` : '') +
    `</span></div>`;

  const checks = report.checks
    .map(
      (check) =>
        `<div class="health-check ${escapeHtml(check.status)}">` +
        `<span class="health-check-icon" aria-hidden="true">${CHECK_ICONS[check.status] ?? '·'}</span>` +
        `<div class="health-check-body"><div class="health-check-title">${escapeHtml(check.title)}</div>` +
        `<div class="health-check-message">${escapeHtml(check.message)}</div>` +
        (check.repair
          ? `<div class="health-check-repair">Repair: ${escapeHtml(check.repair)}</div>`
          : '') +
        `</div></div>`,
    )
    .join('');

  const diagnostics =
    data.providerDiagnostics.length === 0
      ? '<div class="health-empty">Every session provider answered without diagnostics.</div>'
      : data.providerDiagnostics
          .map(
            (d) =>
              `<div class="health-diagnostic ${escapeHtml(d.severity)}">` +
              `<span class="health-diagnostic-provider">${escapeHtml(d.providerId)}</span>` +
              `<span class="health-diagnostic-kind">${escapeHtml(d.kind)} · ${escapeHtml(d.phase)}</span>` +
              `<span class="health-diagnostic-message">${escapeHtml(d.message)}</span></div>`,
          )
          .join('');

  const rows = data.failingTools;
  const tools =
    rows.length === 0
      ? '<div class="health-empty">No tool failures recorded in the last 30 days.</div>'
      : '<table class="health-table"><thead><tr><th>Tool</th><th>7d</th><th>30d</th><th>Trend</th></tr></thead><tbody>' +
        rows
          .slice(0, 12)
          .map((row) => {
            const categories = Object.entries(row.categories)
              .sort((left, right) => right[1] - left[1])
              .map(([category, count]) => `${category}: ${count}`)
              .join(', ');
            return (
              `<tr title="${escapeHtml(categories)}"><td>${escapeHtml(row.tool)}</td>` +
              `<td>${row.last7}</td><td>${row.last30}</td>` +
              `<td class="health-trend ${row.trend}" aria-label="${row.trend}">${TREND_ARROWS[row.trend] ?? '→'}</td></tr>`
            );
          })
          .join('') +
        '</tbody></table>';

  return { banner, checks, diagnostics, tools };
}

export interface HealthMountOptions {
  post(message: DashboardWebviewMessage): void;
}

export interface HealthView {
  mount(options: HealthMountOptions): void;
  render(data: DashboardHealthPayload): void;
  setLoading(loading: boolean): void;
}

export function createHealthView(doc: Document): HealthView {
  const set = (id: string, html: string): void => {
    const el = doc.getElementById(id);
    if (el) el.innerHTML = html;
  };
  return {
    mount(options) {
      doc
        .getElementById(HEALTH_IDS.refresh)
        ?.addEventListener('click', () => options.post({ type: 'requestHealth' }));
    },
    render(data) {
      const html = renderHealthHtml(data);
      set(HEALTH_IDS.banner, html.banner);
      set(HEALTH_IDS.checks, html.checks);
      set(HEALTH_IDS.diagnostics, html.diagnostics);
      set(HEALTH_IDS.tools, html.tools);
    },
    setLoading(loading) {
      const el = doc.getElementById(HEALTH_IDS.loading);
      if (el) el.style.display = loading ? 'block' : 'none';
    },
  };
}
