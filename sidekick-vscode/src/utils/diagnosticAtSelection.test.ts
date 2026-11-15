import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({}));

import { pickDiagnosticsAt, rangesOverlap } from './diagnosticAtSelection';

const r = (sl: number, sc: number, el: number, ec: number) => ({
  start: { line: sl, character: sc },
  end: { line: el, character: ec },
});
const diag = (range: ReturnType<typeof r>, severity: number, message = 'm') => ({
  range,
  severity,
  message,
});

describe('rangesOverlap', () => {
  it('treats touching ranges and zero-length ranges inside as overlapping', () => {
    expect(rangesOverlap(r(1, 0, 1, 5), r(1, 5, 1, 9))).toBe(true);
    expect(rangesOverlap(r(2, 3, 2, 3), r(2, 0, 2, 40))).toBe(true);
  });

  it('rejects ranges on other lines', () => {
    expect(rangesOverlap(r(1, 0, 1, 5), r(2, 0, 2, 5))).toBe(false);
    expect(rangesOverlap(r(3, 0, 3, 5), r(1, 0, 2, 9))).toBe(false);
  });
});

describe('pickDiagnosticsAt', () => {
  it('keeps errors and warnings at the target, errors first', () => {
    const warning = diag(r(4, 2, 4, 6), 1, 'warning');
    const error = diag(r(4, 8, 4, 12), 0, 'error');
    const info = diag(r(4, 0, 4, 3), 2, 'info');
    const elsewhere = diag(r(9, 0, 9, 3), 0, 'elsewhere');
    expect(pickDiagnosticsAt([warning, info, elsewhere, error], r(4, 0, 4, 80))).toEqual([
      error,
      warning,
    ]);
  });

  it('returns nothing when no error or warning overlaps', () => {
    expect(pickDiagnosticsAt([diag(r(4, 0, 4, 3), 3)], r(4, 0, 4, 80))).toEqual([]);
    expect(pickDiagnosticsAt([], r(0, 0, 0, 1))).toEqual([]);
  });
});
