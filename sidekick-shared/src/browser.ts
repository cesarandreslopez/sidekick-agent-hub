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
export { formatDurationMs, formatTokenCount } from './formatting';
export type { FormatDurationMsOptions, FormatTokenCountOptions } from './formatting';
export {
  buildSessionContextSnapshot,
  calculateSessionContextPressure,
  createSessionContextProjector,
} from './context/sessionContext';
export type {
  BuildSessionContextSnapshotOptions,
  SessionContextCapabilities,
  SessionContextLayerBreakdown,
  SessionContextPressure,
  SessionContextProjector,
  SessionContextSnapshot,
  SessionContextSource,
  SessionContextSourceType,
} from './context/sessionContext';

export {
  parseModelId,
  getModelPricing,
  getModelInfo,
  calculateCost,
  calculateCostWithPricing,
  calculateCostWithProvenance,
  mergeCostSources,
  shortModelName,
  getModelDisplayInfo,
  compareModelIds,
  sortModelIds,
  formatCost,
} from './modelInfo';

export type {
  ModelPricing,
  CostTokenUsage,
  CostSource,
  CostProvenanceInput,
  CostWithProvenance,
  ModelProvider,
  ParsedModelId,
  ModelInfo,
  ModelDisplayInfo,
} from './modelInfo';
