import { describe, it, expect, beforeEach } from 'vitest';
import { FilterEngine } from './advancedFilter';
import type { FollowEvent } from '../watchers/types';

function makeEvent(summary: string, timestamp = '2024-01-01T12:00:00Z'): FollowEvent {
  return {
    providerId: 'claude-code',
    type: 'assistant',
    timestamp,
    summary,
  };
}

describe('FilterEngine', () => {
  let filter: FilterEngine;

  beforeEach(() => {
    filter = new FilterEngine();
  });

  describe('substring mode', () => {
    it('matches case-sensitive substrings', () => {
      filter.setMode('substring');
      filter.setQuery('Read');

      expect(filter.matches(makeEvent('Read src/foo.ts'))).toBe(true);
      expect(filter.matches(makeEvent('read src/foo.ts'))).toBe(false);
    });

    it('highlights matched substring', () => {
      filter.setMode('substring');
      filter.setQuery('foo');

      const result = filter.highlightMatches('Read foo.ts bar', 'blessed');
      expect(result).toContain('{blue-bg}');
      expect(result).toContain('foo');
    });
  });

  describe('fuzzy mode', () => {
    it('matches all words case-insensitively', () => {
      filter.setMode('fuzzy');
      filter.setQuery('read foo');

      expect(filter.matches(makeEvent('Read src/foo.ts'))).toBe(true);
      expect(filter.matches(makeEvent('Read src/bar.ts'))).toBe(false);
    });

    it('highlights each matched word', () => {
      filter.setMode('fuzzy');
      filter.setQuery('read foo');

      const result = filter.highlightMatches('Read src/foo.ts', 'html');
      expect(result).toContain('<mark');
      expect(result).toContain('Read');
      expect(result).toContain('foo');
    });
  });

  describe('regex mode', () => {
    it('matches valid regex patterns', () => {
      filter.setMode('regex');
      filter.setQuery('src/.*\\.ts$');

      expect(filter.matches(makeEvent('Read src/foo.ts'))).toBe(true);
      expect(filter.matches(makeEvent('Read output/foo.js'))).toBe(false);
    });

    it('reports invalid regex', () => {
      filter.setMode('regex');
      filter.setQuery('[invalid');

      expect(filter.isValid).toBe(false);
      expect(filter.error).toBeTruthy();
      expect(filter.matches(makeEvent('anything'))).toBe(false);
    });

    it('highlights regex matches', () => {
      filter.setMode('regex');
      filter.setQuery('\\d+');

      const result = filter.highlightMatches('File 42 lines', 'ansi');
      expect(result).toContain('\x1b[0;44m42\x1b[0m');
    });
  });

  describe('date mode', () => {
    it('filters by since/until range', () => {
      filter.setMode('date');
      filter.setDateRange('2024-01-01T10:00:00Z', '2024-01-01T14:00:00Z');

      expect(filter.matches(makeEvent('any', '2024-01-01T12:00:00Z'))).toBe(true);
      expect(filter.matches(makeEvent('any', '2024-01-01T08:00:00Z'))).toBe(false);
      expect(filter.matches(makeEvent('any', '2024-01-01T16:00:00Z'))).toBe(false);
    });

    it('works with only since', () => {
      filter.setMode('date');
      filter.setDateRange('2024-01-01T10:00:00Z');

      expect(filter.matches(makeEvent('any', '2024-01-01T12:00:00Z'))).toBe(true);
      expect(filter.matches(makeEvent('any', '2024-01-01T08:00:00Z'))).toBe(false);
    });
  });

  describe('state management', () => {
    it('reports isActive correctly', () => {
      expect(filter.isActive).toBe(false);

      filter.setQuery('test');
      expect(filter.isActive).toBe(true);

      filter.setQuery('');
      expect(filter.isActive).toBe(false);
    });

    it('matches everything when inactive', () => {
      expect(filter.matches(makeEvent('anything'))).toBe(true);
    });

    it('returns filter state', () => {
      filter.setMode('regex');
      filter.setQuery('foo.*bar');
      const state = filter.getState();

      expect(state.mode).toBe('regex');
      expect(state.query).toBe('foo.*bar');
    });
  });

  describe('matchesText', () => {
    it('works with plain text strings', () => {
      filter.setMode('substring');
      filter.setQuery('hello');

      expect(filter.matchesText('hello world')).toBe(true);
      expect(filter.matchesText('goodbye')).toBe(false);
    });
  });
});
