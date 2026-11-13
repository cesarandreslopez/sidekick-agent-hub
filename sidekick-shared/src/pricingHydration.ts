/**
 * `sidekick-shared/pricingHydration` — LiteLLM pricing-catalog hydration and
 * provider-reported context windows, without the rest of
 * `sidekick-shared/node`.
 *
 * For Node hosts that price usage through `sidekick-shared/pricing` and want
 * the catalog's current prices: `hydratePricingCatalog()` here loads the
 * cached (or freshly fetched) LiteLLM catalog into the same pricing tables
 * `sidekick-shared/pricing` reads, so lookups there see it afterwards. The
 * entry is Zod-free and loads about a dozen modules (the pricing tables plus
 * the config-dir and atomic-write helpers); it needs `node:fs`, so it is not
 * for browser bundles.
 *
 * The tables are module state. Hydration is visible to every entry point
 * that resolves to the same module files in one process: `/pricing`,
 * `/browser`, `/node` and the package root share them whether loaded through
 * `require` or `import`. Two separately bundled artifacts each carry their
 * own copy, so hydrating in one does not change prices in the other.
 *
 * Everything here is also exported from the package root and
 * `sidekick-shared/node`.
 *
 * @module pricingHydration
 */

export {
  hydratePricingCatalog,
  normalizeLiteLlmCatalog,
  normalizeLiteLlmContextWindows,
  LITELLM_CATALOG_URL,
} from './pricingCatalog';
export type { HydrateOptions, HydrateResult } from './pricingCatalog';
export { getPricingCatalogInfo } from './modelInfo';
export type { PricingCatalogInfo, PricingCatalogSource } from './modelInfo';
export {
  loadObservedContextWindows,
  recordObservedContextWindow,
  getObservedContextWindowPath,
} from './observedContextWindows';
export type {
  ObservedContextWindowOptions,
  ObservedContextWindowStore,
} from './observedContextWindows';
