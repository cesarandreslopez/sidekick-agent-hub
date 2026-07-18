export interface ModelCostInput {
  model: string;
  cost: number;
  priced?: boolean;
}

export interface CodeImpact {
  changedLines: number;
  additions: number;
  deletions: number;
  totalCost: number;
  costPerChangedLine: number | null;
  byModel: Array<{
    model: string;
    cost: number;
    priced: boolean;
    changedLines: number;
    costPerChangedLine: number | null;
  }>;
}

export function calculateCodeImpact(
  totalCost: number,
  additions: number,
  deletions: number,
  models: ModelCostInput[] = [],
): CodeImpact {
  const safeAdditions = Math.max(0, additions);
  const safeDeletions = Math.max(0, deletions);
  const changedLines = safeAdditions + safeDeletions;
  return {
    changedLines,
    additions: safeAdditions,
    deletions: safeDeletions,
    totalCost,
    costPerChangedLine: changedLines > 0 ? totalCost / changedLines : null,
    byModel: models.map((model) => ({
      ...model,
      priced: model.priced !== false,
      changedLines,
      costPerChangedLine:
        changedLines > 0 && model.priced !== false ? model.cost / changedLines : null,
    })),
  };
}
