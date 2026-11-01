/**
 * Quota windows (typed): which headline quota cards a plan actually has, the
 * extra meters beyond them (e.g. a Fable weekly cap), and the plan and
 * extra-usage notes under the gauges.
 *
 * Claude Ultra has no five-hour session limit (the usage endpoint reports
 * `five_hour: null`, normalized to `fiveHour.absent`), and a Codex plan can
 * report a single weekly window. Drawing a 0% gauge for a window that does not
 * exist reads as "unused", so the card is hidden instead.
 *
 * Window presence, extra rows, and the extra-usage text come from
 * sidekick-shared/browser; the webview bundle resolves its ES-module build and
 * keeps only these helpers.
 *
 * @module webview/dashboard/quotaWindows
 */

import {
  extraQuotaRows,
  formatExtraUsage,
  quotaWindowApplies,
  quotaWindowHasData,
  type QuotaExtraUsage,
  type QuotaLimitRow,
  type QuotaWindow,
} from 'sidekick-shared/browser';

/** The quota fields these helpers read, as the extension posts them. */
export interface QuotaView {
  providerId?: string;
  fiveHour: QuotaWindow;
  sevenDay: QuotaWindow;
  planLabel?: string;
  limits?: QuotaLimitRow[];
  extraUsage?: QuotaExtraUsage;
}

function isCodex(quota: QuotaView, providerId: string | undefined): boolean {
  return providerId === 'codex' || quota.providerId === 'codex';
}

/**
 * Which of the two headline cards to draw. Claude shows a window whenever the
 * plan has it (an idle window still reads 0%); Codex shows only windows that
 * carry a reading. When neither qualifies both are drawn, as before.
 */
export function quotaCardVisibility(
  quota: QuotaView,
  providerId: string | undefined,
): { fiveHour: boolean; sevenDay: boolean } {
  const show = isCodex(quota, providerId) ? quotaWindowHasData : quotaWindowApplies;
  const fiveHour = show(quota.fiveHour);
  const sevenDay = show(quota.sevenDay);
  if (!fiveHour && !sevenDay) return { fiveHour: true, sevenDay: true };
  return { fiveHour, sevenDay };
}

/** Tooltip for the quota section, naming the plan when known (e.g. "Claude Ultra"). */
export function quotaSectionTooltip(
  quota: QuotaView | null,
  providerId: string | undefined,
): string {
  if (providerId === 'codex') return 'Codex CLI rate limits';
  if (quota?.providerId === 'zai') return 'z.ai Coding Plan quota';
  return quota?.planLabel
    ? `Claude ${quota.planLabel} subscription usage limits`
    : 'Claude subscription usage limits';
}

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function severityClass(row: QuotaLimitRow): string {
  if (row.severity === 'critical' || row.utilization >= 90) return ' danger';
  if (row.severity === 'warning' || row.utilization >= 75) return ' warning';
  return '';
}

/**
 * Extra meter rows and plan notes under the gauges. Returns '' when there is
 * nothing to add, so the container can be hidden.
 */
export function renderQuotaExtrasHtml(
  quota: QuotaView,
  providerId: string | undefined,
  formatReset: (iso: string) => string,
): string {
  const parts: string[] = [];
  for (const row of extraQuotaRows(quota)) {
    const percent = Math.max(0, Math.min(100, Math.round(row.utilization)));
    const scope = row.scopeModel ?? row.scopeSurface;
    const allowance =
      scope && row.allowancePercentOfWeekly !== undefined
        ? ` title="${escapeHtml(`${scope} may use up to ${row.allowancePercentOfWeekly}% of the weekly limit`)}"`
        : '';
    parts.push(
      `<div class="quota-extra-row"${allowance}>` +
        `<span class="quota-extra-label">${escapeHtml(row.label)}</span>` +
        `<span class="quota-extra-bar"><span class="quota-extra-fill${severityClass(row)}" style="width: ${percent}%"></span></span>` +
        `<span class="quota-extra-value">${escapeHtml(Math.round(row.utilization))}%</span>` +
        `<span class="quota-extra-reset">${escapeHtml(formatReset(row.resetsAt))}</span>` +
        `</div>`,
    );
  }
  if (!isCodex(quota, providerId) && quota.providerId !== 'zai' && quota.fiveHour.absent) {
    const plan = quota.planLabel ? ` on ${quota.planLabel}` : '';
    parts.push(`<div class="quota-extra-note">No 5-hour limit${escapeHtml(plan)}</div>`);
  }
  if (quota.extraUsage) {
    parts.push(
      `<div class="quota-extra-note">Extra usage: ${escapeHtml(formatExtraUsage(quota.extraUsage))}</div>`,
    );
  }
  return parts.join('');
}
