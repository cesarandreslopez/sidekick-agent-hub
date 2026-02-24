import { describe, it, expect } from 'vitest';
import { stripBlessedTags, visibleLength, wordWrap, detailWidth, truncate } from './formatters';

describe('stripBlessedTags', () => {
  it('removes simple blessed tags', () => {
    expect(stripBlessedTags('{cyan-fg}hello{/cyan-fg}')).toBe('hello');
  });

  it('removes nested/multiple tags', () => {
    expect(stripBlessedTags('{bold}{green-fg}OK{/green-fg}{/bold}')).toBe('OK');
  });

  it('returns plain text unchanged', () => {
    expect(stripBlessedTags('no tags here')).toBe('no tags here');
  });

  it('handles empty string', () => {
    expect(stripBlessedTags('')).toBe('');
  });
});

describe('visibleLength', () => {
  it('counts only visible characters', () => {
    expect(visibleLength('{cyan-fg}hello{/cyan-fg}')).toBe(5);
  });

  it('works with multiple tags', () => {
    expect(visibleLength('{bold}A{/bold} {red-fg}B{/red-fg}')).toBe(3);
  });

  it('equals .length for plain text', () => {
    expect(visibleLength('hello world')).toBe(11);
  });
});

describe('wordWrap (tag-aware)', () => {
  it('does not wrap short lines', () => {
    expect(wordWrap('hello world', 20)).toBe('hello world');
  });

  it('wraps long plain text', () => {
    const result = wordWrap('one two three four five', 10);
    const lines = result.split('\n');
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(10);
    }
  });

  it('does not count blessed tags toward width', () => {
    // "{cyan-fg}hello{/cyan-fg}" has raw length 27 but visible length 5
    const tagged = '{cyan-fg}hello{/cyan-fg} world';
    // visible: "hello world" = 11 chars, should fit in width 15
    expect(wordWrap(tagged, 15)).toBe(tagged);
  });

  it('wraps tagged text based on visible width', () => {
    const tagged = '{cyan-fg}longword{/cyan-fg} another';
    // visible: "longword another" = 16 chars
    const result = wordWrap(tagged, 10);
    expect(result.split('\n').length).toBe(2);
  });

  it('preserves existing line breaks', () => {
    const result = wordWrap('line1\nline2', 80);
    expect(result).toBe('line1\nline2');
  });

  it('applies continuation indent on wrapped lines', () => {
    const result = wordWrap('one two three four five', 12, '    ');
    const lines = result.split('\n');
    expect(lines[0]).not.toMatch(/^    /);
    for (const line of lines.slice(1)) {
      expect(line).toMatch(/^    /);
    }
  });

  it('continuation indent reduces available width on subsequent lines', () => {
    // width=15, indent="     " (5 chars)
    // first line can fit 15 visible chars, continuation lines can fit 10 visible chars
    const result = wordWrap('aaa bbb ccc ddd eee fff', 15, '     ');
    const lines = result.split('\n');
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines.slice(1)) {
      expect(line.startsWith('     ')).toBe(true);
    }
  });
});

describe('detailWidth', () => {
  it('returns at least 40', () => {
    expect(detailWidth()).toBeGreaterThanOrEqual(40);
  });
});

describe('truncate', () => {
  it('returns short text unchanged', () => {
    expect(truncate('hi', 10)).toBe('hi');
  });

  it('truncates and adds ellipsis', () => {
    expect(truncate('hello world!', 8)).toBe('hello...');
  });
});
