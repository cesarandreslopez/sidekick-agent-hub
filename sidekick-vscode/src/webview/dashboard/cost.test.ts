import { describe, expect, it } from 'vitest';
import {
  blockCostText,
  formatCost,
  modelLabel,
  rowCostText,
  totalCostText,
  unpricedNote,
} from './cost';

describe('dashboard cost text', () => {
  it('formats numbers as before and missing values as a dash', () => {
    expect(formatCost(0.001234)).toBe('$0.0012');
    expect(formatCost(1.234)).toBe('$1.23');
    expect(formatCost(0)).toBe('$0.0000');
    expect(formatCost(null)).toBe('—');
    expect(formatCost(undefined)).toBe('—');
  });

  it('never shows a wholly unpriced total as $0', () => {
    expect(totalCostText(0, 1)).toBe('—');
    expect(totalCostText(1.5, 1)).toBe('$1.50');
    expect(totalCostText(0, 0)).toBe('$0.0000');
    expect(unpricedNote(0)).toBe('');
    expect(unpricedNote(1)).toBe('1 model unpriced');
    expect(unpricedNote(2)).toBe('2 models unpriced');
  });

  it('marks unpriced and partially priced rows', () => {
    expect(rowCostText({ cost: 0.5 })).toBe('$0.50');
    expect(rowCostText({ cost: 0, priced: false })).toBe('—');
    expect(rowCostText({ cost: 0.5, priced: false })).toBe('$0.50 (partial)');
  });

  it('shows a billing block as a dash only when wholly unpriced', () => {
    expect(blockCostText(0, { costProvenance: 'unpriced', unpricedCalls: 3 })).toBe('—');
    expect(blockCostText(1.2, { costProvenance: 'mixed', unpricedCalls: 0 })).toBe('$1.20');
    expect(blockCostText(1.2, { costProvenance: 'estimated', unpricedCalls: 2 })).toBe(
      '$1.20 (partial)',
    );
  });
});

describe('modelLabel', () => {
  it('keeps the Claude family-and-version labels', () => {
    expect(modelLabel('claude-opus-4-5-20251101')).toBe('Opus 4.5');
    expect(modelLabel('claude-sonnet-4-20250514')).toBe('Sonnet 4');
    expect(modelLabel('claude-fable-5')).toBe('Fable 5');
    expect(modelLabel('claude-opus-4-6[1m]')).toBe('Opus 4.6');
  });

  it('names GPT tiers', () => {
    expect(modelLabel('gpt-6.1-sol')).toBe('GPT-6.1 Sol');
    expect(modelLabel('gpt-6-astra')).toBe('GPT-6 Astra');
    expect(modelLabel('gpt-6')).toBe('GPT-6');
    expect(modelLabel('gpt-5.1-codex-max')).toBe('GPT-5.1-codex-max');
    expect(modelLabel('gpt-4o')).toBe('GPT-4o');
    expect(modelLabel('o3-mini')).toBe('o3-mini');
  });

  it('shows unknown ids as is', () => {
    expect(modelLabel('deepseek-coder')).toBe('deepseek-coder');
  });
});
