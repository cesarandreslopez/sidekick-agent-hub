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
  LITELLM_CATALOG_URL,
} from './pricingCatalog';

export type { HydrateOptions, HydrateResult } from './pricingCatalog';
