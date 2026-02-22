import { describe, it, expect } from 'vitest';
import React from 'react';
import { parseBlessedTags, parseBlessedLines } from './parseBlessedTags';

// Helper to serialize React elements for comparison
function serialize(node: React.ReactNode): string {
  if (node === null || node === undefined) return '';
  if (typeof node === 'string') return node;
  if (typeof node === 'number') return String(node);

  if (React.isValidElement(node)) {
    const el = node as React.ReactElement<Record<string, unknown>>;
    const { children, ...props } = el.props;
    const tag = typeof el.type === 'string' ? el.type : (el.type as { name?: string })?.name || 'Fragment';

    const propStr = Object.entries(props)
      .filter(([k]) => k !== 'key')
      .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
      .join(' ');

    const childStr = React.Children.map(children as React.ReactNode | React.ReactNode[], serialize)?.join('') ?? '';
    return propStr ? `<${tag} ${propStr}>${childStr}</${tag}>` : `<${tag}>${childStr}</${tag}>`;
  }

  // Fragment or array
  if (Array.isArray(node)) {
    return node.map(serialize).join('');
  }

  return String(node);
}

describe('parseBlessedTags', () => {
  it('returns plain text unchanged', () => {
    const result = parseBlessedTags('Hello World');
    expect(result).toBe('Hello World');
  });

  it('returns null for empty string', () => {
    expect(parseBlessedTags('')).toBeNull();
  });

  it('handles bold tag', () => {
    const result = parseBlessedTags('{bold}Hello{/bold}');
    const s = serialize(result);
    expect(s).toContain('bold=true');
    expect(s).toContain('Hello');
  });

  it('handles color tag', () => {
    const result = parseBlessedTags('{red-fg}Error{/red-fg}');
    const s = serialize(result);
    expect(s).toContain('color="red"');
    expect(s).toContain('Error');
  });

  it('maps grey to gray', () => {
    const result = parseBlessedTags('{grey-fg}dim{/grey-fg}');
    const s = serialize(result);
    expect(s).toContain('color="gray"');
  });

  it('handles nested tags', () => {
    const result = parseBlessedTags('{bold}{magenta-fg}styled{/magenta-fg}{/bold}');
    const s = serialize(result);
    expect(s).toContain('bold=true');
    expect(s).toContain('color="magenta"');
    expect(s).toContain('styled');
  });

  it('handles mixed plain and tagged text', () => {
    const result = parseBlessedTags('before {bold}middle{/bold} after');
    const s = serialize(result);
    expect(s).toContain('before ');
    expect(s).toContain('middle');
    expect(s).toContain(' after');
  });

  it('ignores {center} tag', () => {
    const result = parseBlessedTags('{center}Hello{/center}');
    const s = serialize(result);
    expect(s).toContain('Hello');
    // Should not crash
  });

  it('handles unclosed tags gracefully', () => {
    const result = parseBlessedTags('{bold}Hello');
    const s = serialize(result);
    expect(s).toContain('bold=true');
    expect(s).toContain('Hello');
  });

  it('handles underline tag', () => {
    const result = parseBlessedTags('{underline}link{/underline}');
    const s = serialize(result);
    expect(s).toContain('underline=true');
  });
});

describe('parseBlessedLines', () => {
  it('returns empty array for empty string', () => {
    expect(parseBlessedLines('')).toEqual([]);
  });

  it('splits on newlines and wraps each in Text', () => {
    const result = parseBlessedLines('line1\nline2\nline3');
    expect(result).toHaveLength(3);
    result.forEach(node => {
      expect(React.isValidElement(node)).toBe(true);
    });
  });

  it('preserves tags within each line', () => {
    const result = parseBlessedLines('{bold}a{/bold}\n{red-fg}b{/red-fg}');
    expect(result).toHaveLength(2);
    const s0 = serialize(result[0]);
    const s1 = serialize(result[1]);
    expect(s0).toContain('bold=true');
    expect(s1).toContain('color="red"');
  });
});
