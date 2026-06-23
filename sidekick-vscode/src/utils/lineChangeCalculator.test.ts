/**
 * @fileoverview Tests for lineChangeCalculator utility.
 */

import { describe, it, expect } from 'vitest';
import { calculateLineChanges, aggregateLineChanges } from './lineChangeCalculator';

describe('calculateLineChanges', () => {
  describe('Write tool', () => {
    it('counts all lines as additions for new file', () => {
      const result = calculateLineChanges('Write', {
        content: 'line1\nline2\nline3',
      });
      expect(result).toEqual({ additions: 3, deletions: 0 });
    });

    it('handles content ending with newline', () => {
      const result = calculateLineChanges('Write', {
        content: 'line1\nline2\n',
      });
      expect(result).toEqual({ additions: 2, deletions: 0 });
    });

    it('handles single line content', () => {
      const result = calculateLineChanges('Write', {
        content: 'single line',
      });
      expect(result).toEqual({ additions: 1, deletions: 0 });
    });

    it('handles empty content', () => {
      const result = calculateLineChanges('Write', {
        content: '',
      });
      expect(result).toEqual({ additions: 0, deletions: 0 });
    });

    it('handles missing content', () => {
      const result = calculateLineChanges('Write', {});
      expect(result).toEqual({ additions: 0, deletions: 0 });
    });
  });

  describe('Edit tool', () => {
    it('counts old_string as deletions and new_string as additions', () => {
      const result = calculateLineChanges('Edit', {
        old_string: 'old line 1\nold line 2',
        new_string: 'new line 1\nnew line 2\nnew line 3',
      });
      expect(result).toEqual({ additions: 3, deletions: 2 });
    });

    it('handles replacement with same line count', () => {
      const result = calculateLineChanges('Edit', {
        old_string: 'old',
        new_string: 'new',
      });
      expect(result).toEqual({ additions: 1, deletions: 1 });
    });

    it('handles pure deletion (empty new_string)', () => {
      const result = calculateLineChanges('Edit', {
        old_string: 'delete me\nand me',
        new_string: '',
      });
      expect(result).toEqual({ additions: 0, deletions: 2 });
    });

    it('handles pure addition (empty old_string)', () => {
      const result = calculateLineChanges('Edit', {
        old_string: '',
        new_string: 'add me\nand me',
      });
      expect(result).toEqual({ additions: 2, deletions: 0 });
    });

    it('handles missing old_string', () => {
      const result = calculateLineChanges('Edit', {
        new_string: 'new content',
      });
      expect(result).toEqual({ additions: 1, deletions: 0 });
    });

    it('handles missing new_string', () => {
      const result = calculateLineChanges('Edit', {
        old_string: 'old content',
      });
      expect(result).toEqual({ additions: 0, deletions: 1 });
    });
  });

  describe('MultiEdit tool', () => {
    it('aggregates changes from multiple edits', () => {
      const result = calculateLineChanges('MultiEdit', {
        edits: [
          { old_string: 'a', new_string: 'b' },
          { old_string: 'c\nd', new_string: 'e\nf\ng' },
        ],
      });
      expect(result).toEqual({ additions: 4, deletions: 3 });
    });

    it('handles empty edits array', () => {
      const result = calculateLineChanges('MultiEdit', {
        edits: [],
      });
      expect(result).toEqual({ additions: 0, deletions: 0 });
    });

    it('handles missing edits', () => {
      const result = calculateLineChanges('MultiEdit', {});
      expect(result).toEqual({ additions: 0, deletions: 0 });
    });

    it('handles non-array edits', () => {
      const result = calculateLineChanges('MultiEdit', {
        edits: 'not an array',
      });
      expect(result).toEqual({ additions: 0, deletions: 0 });
    });
  });

  describe('Other tools', () => {
    it('returns zeros for Read tool', () => {
      const result = calculateLineChanges('Read', {
        file_path: '/some/file.ts',
      });
      expect(result).toEqual({ additions: 0, deletions: 0 });
    });

    it('returns zeros for Bash tool', () => {
      const result = calculateLineChanges('Bash', {
        command: 'ls -la',
      });
      expect(result).toEqual({ additions: 0, deletions: 0 });
    });

    it('returns zeros for unknown tool', () => {
      const result = calculateLineChanges('UnknownTool', {
        foo: 'bar',
      });
      expect(result).toEqual({ additions: 0, deletions: 0 });
    });
  });
});

describe('aggregateLineChanges', () => {
  it('aggregates changes from multiple tool calls', () => {
    const toolCalls = [
      { name: 'Write', input: { content: 'line1\nline2' } },
      { name: 'Edit', input: { old_string: 'old', new_string: 'new\nnewer' } },
      { name: 'Read', input: { file_path: '/file.ts' } },
    ];
    const result = aggregateLineChanges(toolCalls);
    expect(result).toEqual({ additions: 4, deletions: 1 });
  });

  it('handles empty array', () => {
    const result = aggregateLineChanges([]);
    expect(result).toEqual({ additions: 0, deletions: 0 });
  });

  it('handles array with only non-modifying tools', () => {
    const toolCalls = [
      { name: 'Read', input: { file_path: '/a.ts' } },
      { name: 'Bash', input: { command: 'npm test' } },
    ];
    const result = aggregateLineChanges(toolCalls);
    expect(result).toEqual({ additions: 0, deletions: 0 });
  });
});
