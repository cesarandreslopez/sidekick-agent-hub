/**
 * Browser / webview entry.
 *
 * Pure, synchronous, filesystem-free helpers. Safe to bundle for browser
 * runtimes (VS Code webviews, web apps, etc.). Does NOT pull in node:fs,
 * node:path, or any Node-only module.
 *
 * For pricing hydration (LiteLLM catalog refresh), use `sidekick-shared/node`.
 */

export { getModelContextWindowSize, DEFAULT_CONTEXT_WINDOW } from './modelContext';

export {
  parseModelId,
  getModelPricing,
  getModelInfo,
  calculateCost,
  calculateCostWithPricing,
  formatCost,
} from './modelInfo';

export type {
  ModelPricing,
  CostTokenUsage,
  ModelProvider,
  ParsedModelId,
  ModelInfo,
} from './modelInfo';
