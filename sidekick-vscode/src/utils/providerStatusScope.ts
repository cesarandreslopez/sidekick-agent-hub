import type { ProviderStatusState } from 'sidekick-shared';

export type DashboardSessionProviderId = 'claude-code' | 'opencode' | 'codex';

export interface ScopedProviderStatuses {
  claude: ProviderStatusState;
  openai: ProviderStatusState;
}

export function createHiddenProviderStatusState(): ProviderStatusState {
  return {
    indicator: 'none',
    description: 'All systems operational',
    affectedComponents: [],
    activeIncident: null,
    updatedAt: new Date().toISOString(),
  };
}

export function scopeProviderStatuses(
  providerId: DashboardSessionProviderId,
  claudeStatus?: ProviderStatusState | null,
  openaiStatus?: ProviderStatusState | null,
): ScopedProviderStatuses {
  const hiddenClaude = createHiddenProviderStatusState();
  const hiddenOpenAI = createHiddenProviderStatusState();

  if (providerId === 'claude-code') {
    return {
      claude: claudeStatus ?? hiddenClaude,
      openai: hiddenOpenAI,
    };
  }

  if (providerId === 'codex') {
    return {
      claude: hiddenClaude,
      openai: openaiStatus ?? hiddenOpenAI,
    };
  }

  return {
    claude: hiddenClaude,
    openai: hiddenOpenAI,
  };
}
