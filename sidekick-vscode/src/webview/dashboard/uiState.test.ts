import { describe, expect, it } from 'vitest';
import { mergeUiState, readUiState } from './uiState';

describe('dashboard UI state', () => {
  it('keeps known values and drops anything malformed', () => {
    expect(
      readUiState({
        tab: 'history',
        metric: 'tokens',
        historyRange: 'month',
        historySeries: 'model',
        historyMetric: 'cost',
      }),
    ).toEqual({
      tab: 'history',
      metric: 'tokens',
      historyRange: 'month',
      historySeries: 'model',
      historyMetric: 'cost',
    });
    expect(readUiState({ tab: 'bogus', historyRange: null, metric: 3 })).toEqual({});
    expect(readUiState(undefined)).toEqual({});
    expect(readUiState('not an object')).toEqual({});
  });

  it('merges a change into the saved state', () => {
    expect(mergeUiState({ tab: 'health', historyRange: 'week' }, { historyRange: 'all' })).toEqual({
      tab: 'health',
      historyRange: 'all',
    });
    // A bad patch never replaces a good saved value with garbage.
    expect(mergeUiState({ tab: 'health' }, { tab: 'nope' as never })).toEqual({});
  });
});
