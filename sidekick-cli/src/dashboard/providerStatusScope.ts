import type { ProviderStatusState } from './ProviderStatusService';

export type DashboardProviderId = 'claude-code' | 'opencode' | 'codex';

export interface ProviderStatusScopeResult {
  providerStatus: ProviderStatusState | null;
  openaiStatus: ProviderStatusState | null;
}

export function scopeDashboardProviderStatuses(
  providerId: DashboardProviderId,
  providerStatus: ProviderStatusState | null,
  openaiStatus: ProviderStatusState | null,
): ProviderStatusScopeResult {
  if (providerId === 'claude-code') {
    return { providerStatus, openaiStatus: null };
  }

  if (providerId === 'codex') {
    return { providerStatus: null, openaiStatus };
  }

  return { providerStatus: null, openaiStatus: null };
}
