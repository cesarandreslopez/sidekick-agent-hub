import { describe, it, expect, beforeEach } from 'vitest';
import { highlight, clearHighlightCache } from './eventHighlighter';

describe('EventHighlighter', () => {
  beforeEach(() => {
    clearHighlightCache();
  });

  describe('blessed format', () => {
    it('colors error keywords red', () => {
      const result = highlight('error occurred', 'blessed');
      expect(result).toContain('{red-fg}error{/red-fg}');
    });

    it('colors success keywords green', () => {
      const result = highlight('task completed', 'blessed');
      expect(result).toContain('{green-fg}completed{/green-fg}');
    });

    it('colors warning keywords yellow', () => {
      const result = highlight('deprecated warning', 'blessed');
      expect(result).toContain('{yellow-fg}deprecated{/yellow-fg}');
      expect(result).toContain('{yellow-fg}warning{/yellow-fg}');
    });

    it('colors action keywords cyan', () => {
      const result = highlight('Read file', 'blessed');
      expect(result).toContain('{cyan-fg}Read{/cyan-fg}');
    });

    it('colors file paths magenta', () => {
      const result = highlight('Read src/foo.ts', 'blessed');
      expect(result).toContain('{magenta-fg}src/foo.ts{/magenta-fg}');
    });

    it('colors numbers blue', () => {
      const result = highlight('processed 42 items', 'blessed');
      expect(result).toContain('{blue-fg}42{/blue-fg}');
    });

    it('preserves whitespace', () => {
      const result = highlight('hello  world', 'blessed');
      expect(result).toContain('  ');
    });

    it('returns empty string for empty input', () => {
      expect(highlight('', 'blessed')).toBe('');
    });
  });

  describe('HTTP coloring', () => {
    it('colors GET green', () => {
      const result = highlight('GET /api/users', 'blessed');
      expect(result).toContain('{green-fg}GET{/green-fg}');
    });

    it('colors POST yellow', () => {
      const result = highlight('POST /api/users', 'blessed');
      expect(result).toContain('{yellow-fg}POST{/yellow-fg}');
    });

    it('colors DELETE red', () => {
      const result = highlight('DELETE /api/users/1', 'blessed');
      expect(result).toContain('{red-fg}DELETE{/red-fg}');
    });

    it('colors 200 status green', () => {
      const result = highlight('status 200 response', 'blessed');
      expect(result).toContain('{green-fg}200{/green-fg}');
    });

    it('colors 404 status red', () => {
      const result = highlight('status 404 not found', 'blessed');
      expect(result).toContain('{red-fg}404{/red-fg}');
    });

    it('colors 301 status yellow', () => {
      const result = highlight('redirect 301 moved', 'blessed');
      expect(result).toContain('{yellow-fg}301{/yellow-fg}');
    });
  });

  describe('HTML format', () => {
    it('wraps error keywords with HTML spans', () => {
      const result = highlight('critical error', 'html');
      expect(result).toContain('<span class="sk-hl-error">error</span>');
      expect(result).toContain('<span class="sk-hl-error">critical</span>');
    });

    it('wraps paths with HTML spans', () => {
      const result = highlight('Read ./src/foo.ts', 'html');
      expect(result).toContain('sk-hl-path');
    });
  });

  describe('ANSI format', () => {
    it('wraps keywords with ANSI escape codes', () => {
      const result = highlight('error', 'ansi');
      expect(result).toContain('\x1b[31m');
      expect(result).toContain('\x1b[0m');
    });
  });

  describe('caching', () => {
    it('returns cached results for same input', () => {
      const first = highlight('error test', 'blessed');
      const second = highlight('error test', 'blessed');
      expect(first).toBe(second);
    });

    it('uses different cache keys per format', () => {
      const blessed = highlight('error', 'blessed');
      const html = highlight('error', 'html');
      expect(blessed).not.toBe(html);
    });
  });

  describe('edge cases', () => {
    it('handles numbers with units', () => {
      const result = highlight('took 150ms', 'blessed');
      expect(result).toContain('{blue-fg}150ms{/blue-fg}');
    });

    it('handles URLs', () => {
      const result = highlight('fetch https://example.com/api', 'blessed');
      expect(result).toContain('{magenta-fg}https://example.com/api{/magenta-fg}');
    });

    it('handles words with trailing punctuation', () => {
      const result = highlight('task completed.', 'blessed');
      expect(result).toContain('{green-fg}completed.{/green-fg}');
    });
  });
});
