import { ClaudeCodeProvider } from './claudeCode';
import { CodexProvider } from './codex';
import { OpenCodeProvider } from './openCode';
import { SESSION_PROVIDER_IDS } from './types';
import type { ProviderId, SessionProviderBase, SessionProviderDiagnostic } from './types';

export interface CreateSessionProvidersOptions {
  providerIds?: readonly ProviderId[];
  onDiagnostic?: (diagnostic: SessionProviderDiagnostic) => void;
}

export interface CreateSessionProvidersResult {
  providers: SessionProviderBase[];
  /**
   * Live, not a snapshot: the providers keep the emit closure and update
   * entries in place (one per provider/kind/phase) as they run, so this array
   * reflects the latest diagnostics whenever it is read. Copy it to freeze a
   * point in time; use `onDiagnostic` to observe each emission.
   */
  diagnostics: SessionProviderDiagnostic[];
}

/**
 * Constructs built-in providers without probing the filesystem or binaries.
 * A broken provider is isolated and reported instead of aborting host startup.
 */
export function createSessionProviders(
  options: CreateSessionProvidersOptions = {},
): CreateSessionProvidersResult {
  const diagnostics: SessionProviderDiagnostic[] = [];
  const diagnosticIndexes = new Map<string, number>();
  const providers: SessionProviderBase[] = [];
  const selected = new Set(options.providerIds ?? SESSION_PROVIDER_IDS);
  const emit = (diagnostic: SessionProviderDiagnostic): void => {
    const key = `${diagnostic.providerId}\0${diagnostic.kind}\0${diagnostic.phase}`;
    const existingIndex = diagnosticIndexes.get(key);
    if (existingIndex === undefined) {
      diagnosticIndexes.set(key, diagnostics.length);
      diagnostics.push(diagnostic);
    } else {
      diagnostics[existingIndex] = diagnostic;
    }
    try {
      options.onDiagnostic?.(diagnostic);
    } catch {
      // A host diagnostic callback cannot break provider setup.
    }
  };

  for (const providerId of SESSION_PROVIDER_IDS) {
    if (!selected.has(providerId)) continue;
    try {
      const providerOptions = { onDiagnostic: emit };
      providers.push(
        providerId === 'claude-code'
          ? new ClaudeCodeProvider(providerOptions)
          : providerId === 'opencode'
            ? new OpenCodeProvider(providerOptions)
            : new CodexProvider(providerOptions),
      );
    } catch {
      const diagnostic: SessionProviderDiagnostic = {
        providerId,
        kind: 'construction_failed',
        severity: 'error',
        phase: 'construct',
        message: `${providerId} could not be constructed and was omitted.`,
      };
      emit(diagnostic);
    }
  }

  return { providers, diagnostics };
}
