/**
 * @fileoverview Plain-text description of the pricing basis behind cost
 * estimates (`getPricingCatalogInfo()` plus custom pricing), shared by the
 * doctor command's log and the dashboard Health tab (which receives the lines
 * ready-made, so the webview bundle does not carry this module).
 *
 * @module utils/pricingCatalogLabel
 */

import type { PricingCatalogInfo } from 'sidekick-shared';

/** Custom pricing applied from settings. */
export interface CustomPricingSummary {
  applied: string[];
  invalid: string[];
  onlyIfMissing: boolean;
}

export interface PricingHealthLine {
  label: string;
  value: string;
  /** True when the line needs attention (stale catalog, ignored entries). */
  warning?: boolean;
}

const SOURCE_LABELS: Record<PricingCatalogInfo['source'], string> = {
  litellm: 'LiteLLM catalog',
  'stale-cache': 'LiteLLM catalog (stale cache)',
  imported: 'Imported catalog',
  static: 'Built-in prices only',
};

/** `just now`, `12m ago`, `3h ago`, `2d ago`. */
export function formatAge(ms: number): string {
  if (!Number.isFinite(ms) || ms < 60_000) return 'just now';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** The pricing basis as label/value lines. */
export function describePricingCatalog(
  info: PricingCatalogInfo,
  custom?: CustomPricingSummary,
  now: number = Date.now(),
): PricingHealthLine[] {
  const fetched = info.fetchedAt ? Date.parse(info.fetchedAt) : NaN;
  const parts = [SOURCE_LABELS[info.source] ?? info.source];
  if (Number.isFinite(fetched)) parts.push(`fetched ${formatAge(now - fetched)}`);
  if (info.catalogEntries > 0) parts.push(`${info.catalogEntries.toLocaleString()} entries`);
  const lines: PricingHealthLine[] = [
    { label: 'Source', value: parts.join(' · '), warning: info.source === 'stale-cache' },
  ];
  const registered = info.registeredEntries;
  const mode = custom ? (custom.onlyIfMissing ? 'fill gaps only' : 'override') : '';
  lines.push({
    label: 'Custom prices',
    value:
      registered > 0
        ? `${registered} registered${mode ? ` (${mode})` : ''}`
        : 'none (sidekick.customModelPricing)',
  });
  if (custom && custom.invalid.length > 0) {
    lines.push({
      label: 'Ignored',
      value: `${custom.invalid.join(', ')} — each needs inputCostPerMillion and outputCostPerMillion (numbers ≥ 0)`,
      warning: true,
    });
  }
  lines.push({ label: 'Digest', value: info.digest });
  return lines;
}
