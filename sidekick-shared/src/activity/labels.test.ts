import { describe, expect, it } from 'vitest';
import {
  activityHostLabel,
  activityPathLabel,
  cleanActivityLabel,
  identifierLabel,
  readableName,
} from './labels';

describe('activityHostLabel', () => {
  it.each([
    ['https://docs.example.com/guide?q=secret', 'docs.example.com'],
    ['https://user:pass@docs.example.com/x', 'docs.example.com'],
    ['https://user:pa/ss@host.example.org/x', 'host.example.org'],
    ['https://user:pa?ss@host.example.org/x', 'host.example.org'],
    ['https://user:pa#ss@host.example.org/x', 'host.example.org'],
    ['http://localhost:8080/api', 'localhost:8080'],
    ['https://[::1]:3000/x', '[::1]:3000'],
    ['example.com/path', 'example.com'],
    ['ftp://files.example.net/a/b', 'files.example.net'],
  ])('%s → %s', (url, host) => {
    expect(activityHostLabel(url)).toBe(host);
  });

  it('gives the scheme alone when the address reads two ways', () => {
    expect(activityHostLabel('https://name:8080/x@evil.example.com')).toBe('https');
  });

  it('never returns a path, query, login or password', () => {
    for (const url of [
      'https://alice:hunter2@api.example.com/v1/secret?token=abc#frag',
      'https://alice:hun/ter@api.example.com',
      'https://api.example.com/users/alice?token=abc',
    ]) {
      const host = activityHostLabel(url);
      expect(host).not.toMatch(/alice|hunter|hun|token|abc|secret|users|frag/);
    }
  });

  it('returns nothing for garbage', () => {
    expect(activityHostLabel('')).toBe('');
    expect(activityHostLabel('not a url with spaces')).toBe('');
  });
});

describe('activityPathLabel', () => {
  it.each([
    ['/work/demo/src/math.ts', 'src/math.ts'],
    ['C:\\Users\\dev\\repo\\src\\index.ts', 'src/index.ts'],
    ['file:///home/dev/notes.md', 'dev/notes.md'],
    ['README.md', 'README.md'],
    ['./a/./b.ts', 'a/b.ts'],
    ['', ''],
  ])('%s → %s', (input, label) => {
    expect(activityPathLabel(input)).toBe(label);
  });
});

describe('cleanActivityLabel', () => {
  it('strips control, bidi and zero-width characters', () => {
    const label = cleanActivityLabel('a\u0007b\u001b[31mc\u202Ed\u2066e\u200bf\ufeffg');
    // eslint-disable-next-line no-control-regex
    expect(label).not.toMatch(
      /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/,
    );
    expect(label.replace(/\s/g, '')).toBe('ab[31mcdefg');
  });

  it('cuts long labels with an ellipsis, by code point', () => {
    expect(cleanActivityLabel('x'.repeat(100), 10)).toBe(`${'x'.repeat(9)}…`);
    expect(Array.from(cleanActivityLabel('😀'.repeat(20), 5))).toHaveLength(5);
  });
});

describe('identifierLabel / readableName', () => {
  it('accepts short identifiers only', () => {
    expect(identifierLabel('Explore')).toBe('Explore');
    expect(identifierLabel('general-purpose')).toBe('general-purpose');
    expect(identifierLabel('find all the things')).toBeUndefined();
    expect(identifierLabel('x'.repeat(65))).toBeUndefined();
    expect(identifierLabel(42)).toBeUndefined();
  });

  it('makes tool names readable', () => {
    expect(readableName('search_nodes')).toBe('search nodes');
  });
});
