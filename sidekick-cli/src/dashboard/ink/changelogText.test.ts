import { describe, expect, it } from 'vitest';
import { changelogItemRows } from './changelogText';
import { displayWidth } from '../blessedText';

const rowText = (row: { segments: Array<{ text: string }> }) =>
  row.segments.map((segment) => segment.text).join('');

describe('changelogItemRows', () => {
  it('wraps an item into several rows instead of cutting it', () => {
    const item =
      'The help overlay fits 80x24 and smaller terminals, and scrolls with j and k when it does not.';
    const rows = changelogItemRows(item, 40);
    expect(rows.length).toBeGreaterThan(1);
    expect(rows.map(rowText).join(' ')).toBe(item);
    for (const row of rows) expect(displayWidth(rowText(row))).toBeLessThanOrEqual(34);
    expect(rows[0].first).toBe(true);
    expect(rows[1].first).toBe(false);
  });

  it('renders **bold** as bold and drops the markers and backticks', () => {
    const rows = changelogItemRows('**Fits small terminals.** Uses `sidekick dashboard`.', 80);
    const text = rows.map(rowText).join(' ');
    expect(text).not.toContain('**');
    expect(text).not.toContain('`');
    const bold = rows.flatMap((row) => row.segments.filter((s) => s.bold).map((s) => s.text));
    expect(bold.join(' ')).toBe('Fits small terminals.');
  });

  it('puts nested " - " bullets on rows of their own', () => {
    const rows = changelogItemRows('Main point - first detail - second detail', 80);
    expect(rows.map((row) => [row.level, rowText(row)])).toEqual([
      [0, 'Main point'],
      [1, 'first detail'],
      [1, 'second detail'],
    ]);
  });

  it('keeps literal braces as text', () => {
    const rows = changelogItemRows('Keeps {bold} and ${HOME} literal', 80);
    expect(rowText(rows[0])).toBe('Keeps {bold} and ${HOME} literal');
  });
});
