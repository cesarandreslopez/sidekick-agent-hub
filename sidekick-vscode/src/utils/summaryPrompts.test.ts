import { describe, expect, it } from 'vitest';
import { buildNarrativePrompt } from './summaryPrompts';
import type { SessionSummaryData } from '../types/sessionSummary';

function summary(overrides: Partial<SessionSummaryData> = {}): SessionSummaryData {
  return {
    duration: 60_000,
    totalTokens: 1000,
    totalCost: 0.5,
    contextPeak: 10,
    apiCalls: 3,
    tasks: [],
    taskCompletionRate: 0,
    filesChanged: [],
    totalFilesChanged: 0,
    totalAdditions: 0,
    totalDeletions: 0,
    costByModel: [{ model: 'claude-sonnet-4-6', cost: 0.5, percentage: 100, priced: true }],
    costByTool: [],
    codeImpact: { costPerChangedLine: null, byModel: [] } as never,
    errors: [],
    recoveryRate: 0,
    ...overrides,
  };
}

describe('buildNarrativePrompt cost line', () => {
  it('states a fully priced cost as is', () => {
    const prompt = buildNarrativePrompt(summary());
    expect(prompt).toContain('- Cost: $0.50\n');
    expect(prompt).toContain('  - claude-sonnet-4-6: $0.50 (100%)');
  });

  it('says the cost is unknown rather than $0 when nothing was priced', () => {
    const prompt = buildNarrativePrompt(
      summary({
        totalCost: 0,
        costByModel: [{ model: 'local-model', cost: 0, percentage: 0, priced: false }],
        unpricedModelIds: ['local-model'],
      }),
    );
    expect(prompt).toContain('- Cost: unknown (no pricing for local-model');
    expect(prompt).not.toContain('$0.0000');
    expect(prompt).toContain('  - local-model: unpriced\n');
  });

  it('marks a partial cost', () => {
    const prompt = buildNarrativePrompt(
      summary({
        costByModel: [
          { model: 'claude-sonnet-4-6', cost: 0.5, percentage: 100, priced: true },
          { model: 'local-model', cost: 0, percentage: 0, priced: false },
        ],
        unpricedModelIds: ['local-model'],
      }),
    );
    expect(prompt).toContain('- Cost: $0.50 (partial: no pricing for local-model');
  });
});
