/**
 * Small formatting helpers shared by the activity renderers and the
 * describe functions.
 *
 * Pure.
 *
 * @module activity/render/format
 */

import type { SessionProviderId } from '../../providerIds';
import type { ActivityStrings } from '../strings';
import type { ActivityEntry } from '../types';

// eslint-disable-next-line no-control-regex
const XML_ILLEGAL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f￾￿]/g;

/**
 * Text or attribute value safe inside SVG/HTML: escapes markup characters
 * and drops characters XML 1.0 forbids (a stray one would break the parse).
 */
export function escapeActivityXml(text: string): string {
  return text
    .replace(XML_ILLEGAL, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * A model id as a short label: `claude-opus-5-5` → `opus 5.5`,
 * `gpt-6.1-sol` → `gpt-6.1 sol`, others cut to 18 characters.
 */
export function shortActivityModel(model: string): string {
  const id = model
    .replace(/^[a-z0-9.-]+\//i, '')
    .replace(/\[1m\]$/i, '')
    .trim();
  const claude = /^claude-([a-z]+)-(\d+)(?:[-.](\d{1,2}))?(?![\d])/i.exec(id);
  if (claude) return `${claude[1].toLowerCase()} ${claude[2]}${claude[3] ? `.${claude[3]}` : ''}`;
  const gpt = /^(gpt-[\d.]+)-([a-z]+)/i.exec(id);
  if (gpt) return `${gpt[1].toLowerCase()} ${gpt[2].toLowerCase()}`;
  return id.length > 18 ? `${id.slice(0, 17)}…` : id;
}

/** `850ms`, `4.2s`, `3m05s`, `1h12m`. */
export function formatActivityDuration(ms: number): string {
  const v = Math.max(0, Math.round(ms));
  if (v < 1000) return `${v}ms`;
  if (v < 60_000) return `${(v / 1000).toFixed(1)}s`;
  if (v < 3_600_000) {
    const m = Math.floor(v / 60_000);
    const s = Math.floor((v % 60_000) / 1000);
    return `${m}m${String(s).padStart(2, '0')}s`;
  }
  const h = Math.floor(v / 3_600_000);
  const m = Math.floor((v % 3_600_000) / 60_000);
  return `${h}h${String(m).padStart(2, '0')}m`;
}

/** `12.3k` style token counts. */
export function formatActivityCount(n: number): string {
  const v = Math.max(0, n);
  if (v < 1000) return String(Math.round(v));
  if (v < 1_000_000) return `${(v / 1000).toFixed(v < 10_000 ? 1 : 0)}k`;
  return `${(v / 1_000_000).toFixed(1)}M`;
}

/** An entry's label, translated when it is a vocabulary word. */
export function activityEntryLabel(entry: ActivityEntry, strings: ActivityStrings): string {
  return entry.labelKey ? (strings.labels[entry.labelKey] ?? entry.label) : entry.label;
}

/** What the core says when the host names nothing. */
export function defaultActivityCoreName(providerId: SessionProviderId | undefined): string {
  switch (providerId) {
    case 'claude-code':
      return 'CLAUDE';
    case 'codex':
      return 'CODEX';
    case 'opencode':
      return 'OPENCODE';
    default:
      return 'AGENT';
  }
}

/** Core name as drawn: trimmed, at most 10 characters, default by provider. */
export function resolveActivityCoreName(
  coreName: string | undefined,
  providerId: SessionProviderId | undefined,
): string {
  const trimmed = (coreName ?? '').replace(XML_ILLEGAL, '').trim().slice(0, 10);
  return trimmed === '' ? defaultActivityCoreName(providerId) : trimmed;
}
