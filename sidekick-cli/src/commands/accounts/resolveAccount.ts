/**
 * Resolve the `<name>` argument of `sidekick accounts …` to one saved account:
 * exact id, then email, then label (case-insensitive), then a unique prefix
 * of any of those.
 */

import type { AccountProviderId, AccountView } from 'sidekick-shared';
import { PROVIDER_NAMES } from './format';

export type ResolveAccountResult =
  | { account: AccountView }
  | { error: string; candidates: AccountView[] };

function keysOf(view: AccountView): string[] {
  return [view.id, view.email ?? '', view.label ?? ''].filter(Boolean).map((k) => k.toLowerCase());
}

export function resolveAccount(
  views: AccountView[],
  identifier: string,
  provider?: AccountProviderId,
): ResolveAccountResult {
  const pool = provider ? views.filter((view) => view.providerId === provider) : views;
  const needle = identifier.trim().toLowerCase();
  if (!needle) return { error: 'Account name is required.', candidates: pool };

  const exact = pool.filter((view) => keysOf(view).includes(needle));
  if (exact.length === 1) return { account: exact[0] };
  if (exact.length > 1) {
    return {
      error: `"${identifier}" matches ${exact.length} accounts; add --provider ${exact.map((v) => v.providerId).join(' or ')}.`,
      candidates: exact,
    };
  }

  const prefix = pool.filter((view) => keysOf(view).some((key) => key.startsWith(needle)));
  if (prefix.length === 1) return { account: prefix[0] };
  if (prefix.length > 1) {
    return {
      error: `"${identifier}" is ambiguous: ${prefix.map(describe).join(', ')}.`,
      candidates: prefix,
    };
  }
  return {
    error: `No saved ${provider ? `${PROVIDER_NAMES[provider]} ` : ''}account matches "${identifier}".`,
    candidates: pool,
  };
}

export function describe(view: AccountView): string {
  const name = view.label ?? view.email ?? view.id;
  return view.email && view.email !== name ? `${name} (${view.email})` : name;
}

/** Map a `--provider` value to an account provider filter; undefined = all. */
export function parseProviderFilter(value: string | undefined): {
  provider?: AccountProviderId;
  error?: string;
} {
  const normalized = value?.trim().toLowerCase();
  if (!normalized || normalized === 'auto' || normalized === 'all') return {};
  if (normalized === 'claude' || normalized === 'claude-code') return { provider: 'claude-code' };
  if (normalized === 'codex') return { provider: 'codex' };
  if (normalized === 'opencode') return { error: 'OpenCode account management is not supported.' };
  return { error: `Unknown provider "${value}". Use claude-code, codex, or all.` };
}
