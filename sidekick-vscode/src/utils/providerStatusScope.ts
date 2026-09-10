import type { ProviderServiceStatus } from 'sidekick-shared';
export type DashboardSessionProviderId = 'claude-code' | 'opencode' | 'codex';
export interface ScopedProviderStatuses {
  claude: ProviderServiceStatus | null;
  openai: ProviderServiceStatus | null;
}
export function scopeProviderStatuses(
  providerId: DashboardSessionProviderId,
  claudeStatus?: ProviderServiceStatus | null,
  openaiStatus?: ProviderServiceStatus | null,
): ScopedProviderStatuses {
  return {
    claude: providerId === 'claude-code' ? (claudeStatus ?? null) : null,
    openai: providerId === 'codex' ? (openaiStatus ?? null) : null,
  };
}
