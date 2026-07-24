/**
 * Node-only entry.
 *
 * Pricing catalog hydration from the LiteLLM source. Requires `node:fs`
 * and `node:path`; safe for extension-host and CLI consumers. Not safe
 * for browser bundles — use `sidekick-shared/browser` there.
 */

export {
  hydratePricingCatalog,
  normalizeLiteLlmCatalog,
  normalizeLiteLlmContextWindows,
  LITELLM_CATALOG_URL,
} from './pricingCatalog';

export type { HydrateOptions, HydrateResult } from './pricingCatalog';
export {
  loadObservedContextWindows,
  recordObservedContextWindow,
  getObservedContextWindowPath,
} from './observedContextWindows';
export type {
  ObservedContextWindowOptions,
  ObservedContextWindowStore,
} from './observedContextWindows';
export { listRecentSessions, readSessionTranscript } from './sessionTranscripts';
export type { ProviderSessionIndex, ListRecentSessionsOptions } from './sessionTranscripts';
export {
  ObservedSessionCollector,
  observedSessionSourceFromProvider,
  fileFingerprint,
} from './observedSessionCollector';
export type {
  ObservedSessionReference,
  ObservedSessionCollectionSource,
  ProviderObservedSessionCollectionSource,
  ObservedSessionDiagnosticKind,
  ObservedSessionDiagnostic,
  ObservedSessionCollection,
  ObservedSessionCollectorOptions,
} from './observedSessionCollector';
