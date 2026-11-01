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
 * Kept local rather than imported from sidekick-shared/browser (the shared
 * package is CommonJS, so one helper would pull the whole browser entry into
 * this bundle). quotaWindows.test.ts pins these to the shared
 * `quotaWindowApplies` / `quotaWindowHasData` / `extraQuotaRows` /
 * `formatExtraUsage` so the two cannot drift.
 *
 * @module webview/dashboard/quotaWindows
 */

export interface QuotaWindowView {
  utilization: number;
  resetsAt: string;
  absent?: boolean;
}

export interface QuotaLimitRowView {
  kind: string;
  label: string;
  utilization: number;
  resetsAt: string;
  projected?: number;
  scopeModel?: string;
  scopeSurface?: string;
  severity?: string;
  allowancePercentOfWeekly?: number;
}

export interface QuotaExtraUsageView {
  enabled: boolean;
  monthlyLimit: number | null;
  usedCredits: number | null;
  utilization: number | null;
  currency?: string;
  decimalPlaces?: number;
  disabledReason?: string;
}

export interface QuotaView {
  providerId?: string;
  fiveHour: QuotaWindowView;
  sevenDay: QuotaWindowView;
  planLabel?: string;
  limits?: QuotaLimitRowView[];
  extraUsage?: QuotaExtraUsageView;
}

/** Mirrors `quotaWindowApplies` in sidekick-shared. */
export function windowApplies(window: QuotaWindowView | null | undefined): boolean {
  return Boolean(window) && window?.absent !== true;
}

/** Mirrors `quotaWindowHasData` in sidekick-shared. */
export function windowHasData(window: QuotaWindowView | null | undefined): boolean {
  if (!window || window.absent === true) return false;
  return Boolean(window.resetsAt) || window.utilization > 0;
}

/** Mirrors `extraQuotaRows` in sidekick-shared. */
export function extraRows(quota: Pick<QuotaView, 'limits'>): QuotaLimitRowView[] {
  return (quota.limits ?? []).filter((row) => row.kind !== 'session' && row.kind !== 'weekly_all');
}

function formatMinorUnits(amount: number, currency: string | undefined, decimals: number): string {
  const value = amount / 10 ** decimals;
  if (currency) {
    try {
      return new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency,
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals,
      }).format(value);
    } catch {
      return `${value.toFixed(decimals)} ${currency}`;
    }
  }
  return value.toFixed(decimals);
}

/** Mirrors `formatExtraUsage` in sidekick-shared. */
export function formatExtraUsage(extra: QuotaExtraUsageView): string {
  const decimals =
    typeof extra.decimalPlaces === 'number' &&
    Number.isInteger(extra.decimalPlaces) &&
    extra.decimalPlaces >= 0 &&
    extra.decimalPlaces <= 6
      ? extra.decimalPlaces
      : 2;
  const used = formatMinorUnits(extra.usedCredits ?? 0, extra.currency, decimals);
  const amount =
    extra.monthlyLimit !== null
      ? `${used} of ${formatMinorUnits(extra.monthlyLimit, extra.currency, decimals)} used`
      : `${used} used`;
  if (extra.enabled) return amount;
  const reason = extra.disabledReason ? ` (${extra.disabledReason.replace(/_/g, ' ')})` : '';
  return `${amount} · off${reason}`;
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
  const show = isCodex(quota, providerId) ? windowHasData : windowApplies;
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

function severityClass(row: QuotaLimitRowView): string {
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
  for (const row of extraRows(quota)) {
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
