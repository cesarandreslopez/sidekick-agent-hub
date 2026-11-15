import { describe, expect, it } from 'vitest';
import { escapeHtml, highlightMatches } from './text';

describe('highlightMatches', () => {
  it('never lands a mark inside an escaped entity', () => {
    const text = 'grep "x" > out';
    expect(highlightMatches(text, 'q')).toBe('grep &quot;x&quot; &gt; out');
    expect(highlightMatches(text, 'gt')).toBe('grep &quot;x&quot; &gt; out');
    expect(highlightMatches(text, 'x')).toBe('grep &quot;<mark>x</mark>&quot; &gt; out');
    expect(highlightMatches(text, '>')).toBe('grep &quot;x&quot; <mark>&gt;</mark> out');
  });

  it('matches case-insensitively and treats regex characters literally', () => {
    expect(highlightMatches('Read a.ts and A.TS', 'a.ts')).toBe(
      'Read <mark>a.ts</mark> and <mark>A.TS</mark>',
    );
    expect(highlightMatches('(1+1)', '1+1')).toBe('(<mark>1+1</mark>)');
    expect(highlightMatches('<b>', '')).toBe('&lt;b&gt;');
    expect(highlightMatches(undefined, 'x')).toBe('');
    expect(escapeHtml('a & "b"')).toBe('a &amp; &quot;b&quot;');
  });
});
