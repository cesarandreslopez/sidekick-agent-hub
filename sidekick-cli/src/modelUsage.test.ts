import { describe, expect, it } from 'vitest';
import { mergeModelUsage } from './modelUsage';

describe('mergeModelUsage', () => {
  it('merges dated, prefixed, and Bedrock spellings of one model', () => {
    expect(
      mergeModelUsage([
        { model: 'claude-opus-5-5-20261001', calls: 2, tokens: 100, cost: 0.2 },
        { model: 'gpt-6.1-sol', calls: 1, tokens: 50, cost: 0.05 },
        { model: 'us.anthropic.claude-opus-5-5-20261001-v1:0', calls: 3, tokens: 300, cost: 0.3 },
        { model: 'claude-opus-5-5', calls: 1, tokens: 10, cost: 0.01 },
      ]),
    ).toEqual([
      { model: 'claude-opus-5-5', calls: 6, tokens: 410, cost: expect.closeTo(0.51, 10) },
      { model: 'gpt-6.1-sol', calls: 1, tokens: 50, cost: 0.05 },
    ]);
  });

  it('keeps "unpriced" only when no spelling was priced, and flags a partial merge', () => {
    expect(
      mergeModelUsage([
        { model: 'mystery-1', calls: 1, tokens: 10, cost: 0, priced: false },
        { model: 'mystery-1-20260101', calls: 1, tokens: 10, cost: 0, priced: false },
      ]),
    ).toEqual([{ model: 'mystery-1', calls: 2, tokens: 20, cost: 0, priced: false }]);
    expect(
      mergeModelUsage([
        { model: 'claude-opus-5-5', calls: 1, tokens: 10, cost: 0.1, priced: true },
        {
          model: 'eu.anthropic.claude-opus-5-5-v1:0',
          calls: 1,
          tokens: 10,
          cost: 0,
          priced: false,
        },
      ]),
    ).toEqual([
      { model: 'claude-opus-5-5', calls: 2, tokens: 20, cost: 0.1, partiallyPriced: true },
    ]);
  });
});
