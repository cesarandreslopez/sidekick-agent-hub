import { describe, expect, it } from 'vitest';
import { wrapPlainText, wrapPlainTextLimited } from './plainWrap';
import { displayWidth } from './blessedText';

describe('wrapPlainText', () => {
  it('wraps at spaces within the width', () => {
    expect(wrapPlainText('one two three four', 9)).toEqual(['one two', 'three', 'four']);
  });

  it('hard-breaks a path longer than a row so it is shown whole', () => {
    const path = '/private/tmp/claude-501/sidekick-report-1794926533884.html';
    const rows = wrapPlainText(`Report: ${path}`, 30);
    expect(rows.join('')).toContain('sidekick-report-1794926533884.html');
    for (const row of rows) expect(displayWidth(row)).toBeLessThanOrEqual(30);
  });

  it('keeps literal braces, which tag-aware wrapping would treat as markup', () => {
    expect(wrapPlainText('Use {bold} and ${HOME} literally', 80)).toEqual([
      'Use {bold} and ${HOME} literally',
    ]);
  });

  it('measures wide characters as two columns', () => {
    for (const row of wrapPlainText('漢字テキスト漢字テキスト', 8)) {
      expect(displayWidth(row)).toBeLessThanOrEqual(8);
    }
  });

  it('keeps existing line breaks', () => {
    expect(wrapPlainText('a\nb', 10)).toEqual(['a', 'b']);
  });
});

describe('wrapPlainTextLimited', () => {
  it('ends the last kept row with an ellipsis when the text is longer', () => {
    const rows = wrapPlainTextLimited('alpha beta gamma delta epsilon zeta', 11, 2);
    expect(rows).toHaveLength(2);
    expect(rows[1].endsWith('…')).toBe(true);
    for (const row of rows) expect(displayWidth(row)).toBeLessThanOrEqual(11);
  });
});
