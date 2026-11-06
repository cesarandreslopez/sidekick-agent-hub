/**
 * Session-provider construction from a caller-chosen set of factories.
 *
 * `createSessionProviders()` builds every built-in provider, so a bundle
 * that calls it carries all three. A host that only reads Claude Code and
 * Codex passes their factories to `createSessionProvidersFrom()` instead,
 * and the OpenCode provider (with its SQLite reader) never enters the
 * bundle. This module imports no provider.
 *
 * @module providers/sessionProviderRegistry
 */

import { resolveAgentHomes, type SessionHomesOptions } from '../agentHomes';
import type { ProviderId, SessionProviderBase, SessionProviderDiagnostic } from './types';

export interface CreateSessionProvidersOptions {
  providerIds?: readonly ProviderId[];
  onDiagnostic?: (diagnostic: SessionProviderDiagnostic) => void;
  /**
   * Codex: also discover and read compressed rollouts (`….jsonl.zst`); see
   * `CodexProviderOptions.includeCompressedRollouts`. Default false.
   */
  includeCompressedRollouts?: boolean;
  /**
   * Claude Code and Codex homes to read instead of following the process
   * environment at each call (see `SessionHomesOptions`). An explicit `[]`
   * leaves that provider out. Validated before anything is constructed:
   * a relative or blank explicit entry throws `RangeError`.
   */
  homes?: SessionHomesOptions;
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

/** What a factory receives: the shared diagnostic sink and the call's options. */
export interface SessionProviderFactoryContext {
  /** Deduplicating, never-throwing diagnostic sink shared by every provider of the call. */
  onDiagnostic: (diagnostic: SessionProviderDiagnostic) => void;
  homes?: SessionHomesOptions;
  includeCompressedRollouts: boolean;
}

/** Builds one provider; see `claudeCodeProviderFactory` and its siblings. */
export interface SessionProviderFactory {
  readonly providerId: ProviderId;
  create(context: SessionProviderFactoryContext): SessionProviderBase;
}

/**
 * Construct providers from `factories`, in their order, without probing the
 * filesystem or binaries. The first factory for an id wins; `providerIds`
 * filters; a factory that throws is left out and reported as
 * `construction_failed` instead of aborting host startup; an explicit empty
 * home list leaves that provider out.
 */
export function createSessionProvidersFrom(
  factories: readonly SessionProviderFactory[],
  options: CreateSessionProvidersOptions = {},
): CreateSessionProvidersResult {
  const diagnostics: SessionProviderDiagnostic[] = [];
  const diagnosticIndexes = new Map<string, number>();
  const providers: SessionProviderBase[] = [];
  const selected = options.providerIds ? new Set(options.providerIds) : undefined;
  const homes = options.homes;
  const disabled = new Set<ProviderId>();
  if (homes) {
    // Invalid explicit homes are a caller bug: fail before constructing anything.
    resolveAgentHomes(homes);
    if (homes.claudeHomes?.length === 0) disabled.add('claude-code');
    if (homes.codexHomes?.length === 0) disabled.add('codex');
  }
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
  const context: SessionProviderFactoryContext = {
    onDiagnostic: emit,
    ...(homes ? { homes } : {}),
    includeCompressedRollouts: options.includeCompressedRollouts === true,
  };

  const seen = new Set<ProviderId>();
  for (const factory of factories) {
    const providerId = factory.providerId;
    if (seen.has(providerId)) continue;
    seen.add(providerId);
    if (selected && !selected.has(providerId)) continue;
    if (disabled.has(providerId)) continue;
    try {
      providers.push(factory.create(context));
    } catch {
      emit({
        providerId,
        kind: 'construction_failed',
        severity: 'error',
        phase: 'construct',
        message: `${providerId} could not be constructed and was omitted.`,
      });
    }
  }

  return { providers, diagnostics };
}
