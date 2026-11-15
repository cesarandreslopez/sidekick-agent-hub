import { describe, expect, it } from 'vitest';
import {
  displayWidth,
  stripTagged,
  tokenizeTagged,
  truncateTagged,
  visibleWidth,
  wrapTaggedLines,
} from './blessedText';

describe('tokenizeTagged', () => {
  it('only treats the tags the dashboard emits as tags', () => {
    expect(stripTagged('{cyan-fg}a{/cyan-fg} {bold}b{/bold}')).toBe('a b');
    expect(stripTagged('echo ${HOME}')).toBe('echo ${HOME}');
    expect(stripTagged('{"tokens": 3}')).toBe('{"tokens": 3}');
    expect(stripTagged('{grey-fg}{{/grey-fg}')).toBe('{');
    expect(stripTagged('{/missing}')).toBe('{/missing}');
  });

  it('resolves the brace escapes', () => {
    expect(stripTagged('{open}x{close}')).toBe('{x}');
    expect(tokenizeTagged('{open}{close}')).toEqual([{ kind: 'text', text: '{}' }]);
  });
});

describe('display width', () => {
  it('counts wide characters as two columns', () => {
    expect(displayWidth('abc')).toBe(3);
    expect(displayWidth('日本')).toBe(4);
    expect(visibleWidth('{red-fg}日本{/red-fg}x')).toBe(5);
  });
});

describe('truncateTagged', () => {
  it('cuts by display columns and keeps tags balanced', () => {
    const out = truncateTagged('{red-fg}abcdefghij{/red-fg}', 5);
    expect(visibleWidth(out)).toBe(5);
    expect(out).toBe('{red-fg}abcd…{/red-fg}');
  });

  it('never splits a wide character across the limit', () => {
    const out = truncateTagged('日本語のテキスト', 5);
    expect(visibleWidth(out)).toBeLessThanOrEqual(5);
  });

  it('returns short input unchanged', () => {
    expect(truncateTagged('{bold}hi{/bold}', 10)).toBe('{bold}hi{/bold}');
  });
});

describe('wrapTaggedLines', () => {
  it('keeps every row within the width', () => {
    const rows = wrapTaggedLines('alpha beta gamma delta epsilon zeta eta theta', 12);
    for (const row of rows) expect(visibleWidth(row)).toBeLessThanOrEqual(12);
    expect(rows.map(stripTagged).join(' ')).toBe('alpha beta gamma delta epsilon zeta eta theta');
  });

  it('hard-breaks words longer than the row', () => {
    const path = '/Users/someone/projects/very/deep/directory/structure/file.ts';
    const rows = wrapTaggedLines(path, 20);
    expect(rows.length).toBeGreaterThan(1);
    for (const row of rows) expect(visibleWidth(row)).toBeLessThanOrEqual(20);
    expect(rows.map(stripTagged).join('')).toBe(path);
  });

  it('keeps blank lines as rows', () => {
    expect(wrapTaggedLines('a\n\nb', 10)).toEqual(['a', '', 'b']);
  });

  it('reopens a style on each row it spans', () => {
    const rows = wrapTaggedLines('{red-fg}one two three four{/red-fg}', 9);
    expect(rows.length).toBeGreaterThan(1);
    for (const row of rows) {
      expect(row.startsWith('{red-fg}')).toBe(true);
      expect(row.endsWith('{/red-fg}')).toBe(true);
    }
  });

  it('carries a style that spans several lines', () => {
    const rows = wrapTaggedLines('{bold}first\nsecond{/bold}\nthird', 40);
    expect(rows[1]).toBe('{bold}second{/bold}');
    expect(rows[2]).toBe('third');
  });

  it('indents continuation rows like the wrapped line', () => {
    const rows = wrapTaggedLines('    "key": "a long value that wraps around"', 20);
    expect(rows.length).toBeGreaterThan(1);
    for (const row of rows.slice(1)) expect(stripTagged(row).startsWith('    ')).toBe(true);
  });

  it('escapes literal braces it re-emits', () => {
    const rows = wrapTaggedLines('{grey-fg}{"a": 1, "b": 2, "c": 3}{/grey-fg}', 12);
    expect(rows.map(stripTagged).join('').replace(/ /g, '')).toBe('{"a":1,"b":2,"c":3}');
    for (const row of rows) expect(visibleWidth(row)).toBeLessThanOrEqual(12);
  });

  it('wraps wide characters by display width', () => {
    const rows = wrapTaggedLines('日本語のテキストがここにあります', 10);
    for (const row of rows) expect(visibleWidth(row)).toBeLessThanOrEqual(10);
  });
});
