import type { ProviderId, SessionProviderBase } from 'sidekick-shared';

export function selectSessionProvider(
  original: SessionProviderBase,
  additional: SessionProviderBase[],
  selectedProviderId: ProviderId | undefined,
  createProvider: (id: ProviderId) => SessionProviderBase,
): SessionProviderBase {
  if (!selectedProviderId || selectedProviderId === original.id) return original;
  const active = additional.find((provider) => provider.id === selectedProviderId);
  original.dispose();
  return active ?? createProvider(selectedProviderId);
}

export function createDashboardSignalHandler(
  cleanup: () => void,
  unmount: () => void,
  exitProcess: (code: number) => void = (code) => process.exit(code),
): () => void {
  return () => {
    cleanup();
    unmount();
    exitProcess(0);
  };
}
