import { claudeCodeProviderFactory } from './claudeCode';
import { codexProviderFactory } from './codex';
import { openCodeProviderFactory } from './openCode';
import {
  createSessionProvidersFrom,
  type CreateSessionProvidersOptions,
  type CreateSessionProvidersResult,
  type SessionProviderFactory,
} from './sessionProviderRegistry';
import { SESSION_PROVIDER_IDS } from './types';
import type { ProviderId } from './types';

export type {
  CreateSessionProvidersOptions,
  CreateSessionProvidersResult,
} from './sessionProviderRegistry';

const BUILT_IN_FACTORIES: Record<ProviderId, SessionProviderFactory> = {
  'claude-code': claudeCodeProviderFactory,
  opencode: openCodeProviderFactory,
  codex: codexProviderFactory,
};

/**
 * Constructs built-in providers without probing the filesystem or binaries.
 * A broken provider is isolated and reported instead of aborting host startup.
 *
 * Loads every built-in provider; a host that needs only some passes their
 * factories to `createSessionProvidersFrom()` so the rest stay out of its
 * bundle.
 */
export function createSessionProviders(
  options: CreateSessionProvidersOptions = {},
): CreateSessionProvidersResult {
  return createSessionProvidersFrom(
    SESSION_PROVIDER_IDS.map((providerId) => BUILT_IN_FACTORIES[providerId]),
    options,
  );
}
