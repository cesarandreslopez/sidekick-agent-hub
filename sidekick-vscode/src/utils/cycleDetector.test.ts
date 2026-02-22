import { describe, it, expect } from 'vitest';
import { buildSignature, detectCycle } from './cycleDetector';
import type { ToolCall } from '../types/claudeSession';

function makeCall(name: string, input: Record<string, unknown> = {}, timestamp?: Date): ToolCall {
  return {
    name,
    input,
    timestamp: timestamp ?? new Date(),
  };
}

describe('cycleDetector', () => {
  describe('buildSignature', () => {
    it('extracts file_path for Read/Write/Edit', () => {
      expect(buildSignature(makeCall('Read', { file_path: '/src/foo.ts' }))).toEqual({
        toolName: 'Read',
        argHash: '/src/foo.ts',
      });
      expect(buildSignature(makeCall('Write', { file_path: '/src/bar.ts' }))).toEqual({
        toolName: 'Write',
        argHash: '/src/bar.ts',
      });
      expect(buildSignature(makeCall('Edit', { file_path: '/src/baz.ts' }))).toEqual({
        toolName: 'Edit',
        argHash: '/src/baz.ts',
      });
    });

    it('extracts base command for Bash', () => {
      expect(buildSignature(makeCall('Bash', { command: 'npm install foo' }))).toEqual({
        toolName: 'Bash',
        argHash: 'npm',
      });
      expect(buildSignature(makeCall('Bash', { command: '  git status ' }))).toEqual({
        toolName: 'Bash',
        argHash: 'git',
      });
    });

    it('extracts pattern for Glob/Grep', () => {
      expect(buildSignature(makeCall('Glob', { pattern: '**/*.ts' }))).toEqual({
        toolName: 'Glob',
        argHash: '**/*.ts',
      });
      expect(buildSignature(makeCall('Grep', { pattern: 'TODO' }))).toEqual({
        toolName: 'Grep',
        argHash: 'TODO',
      });
    });

    it('uses JSON substring for unknown tools', () => {
      const sig = buildSignature(makeCall('CustomTool', { arg1: 'value1' }));
      expect(sig.toolName).toBe('CustomTool');
      expect(sig.argHash).toContain('arg1');
    });

    it('handles missing inputs gracefully', () => {
      expect(buildSignature(makeCall('Bash', {}))).toEqual({
        toolName: 'Bash',
        argHash: '',
      });
      expect(buildSignature(makeCall('Read', {}))).toEqual({
        toolName: 'Read',
        argHash: '',
      });
    });
  });

  describe('detectCycle', () => {
    it('detects pattern length 1 (same call repeated)', () => {
      const calls = Array.from({ length: 6 }, () =>
        makeCall('Read', { file_path: '/src/foo.ts' })
      );
      const result = detectCycle(calls, 6);
      expect(result).not.toBeNull();
      expect(result!.repetitions).toBe(6);
      expect(result!.pattern).toHaveLength(1);
      expect(result!.affectedFiles).toContain('/src/foo.ts');
    });

    it('detects pattern length 2 (A-B-A-B-A-B)', () => {
      const calls = [
        makeCall('Read', { file_path: '/src/foo.ts' }),
        makeCall('Edit', { file_path: '/src/foo.ts' }),
        makeCall('Read', { file_path: '/src/foo.ts' }),
        makeCall('Edit', { file_path: '/src/foo.ts' }),
        makeCall('Read', { file_path: '/src/foo.ts' }),
        makeCall('Edit', { file_path: '/src/foo.ts' }),
      ];
      const result = detectCycle(calls, 6);
      expect(result).not.toBeNull();
      expect(result!.repetitions).toBe(3);
      expect(result!.pattern).toHaveLength(2);
    });

    it('detects pattern length 3 (A-B-C-A-B-C)', () => {
      const calls = [
        makeCall('Read', { file_path: '/a.ts' }),
        makeCall('Edit', { file_path: '/a.ts' }),
        makeCall('Bash', { command: 'npm test' }),
        makeCall('Read', { file_path: '/a.ts' }),
        makeCall('Edit', { file_path: '/a.ts' }),
        makeCall('Bash', { command: 'npm test' }),
      ];
      const result = detectCycle(calls, 6);
      expect(result).not.toBeNull();
      expect(result!.repetitions).toBe(2);
      expect(result!.pattern).toHaveLength(3);
    });

    it('returns null when no cycle exists', () => {
      const calls = [
        makeCall('Read', { file_path: '/a.ts' }),
        makeCall('Write', { file_path: '/b.ts' }),
        makeCall('Bash', { command: 'npm test' }),
        makeCall('Glob', { pattern: '**/*.ts' }),
        makeCall('Read', { file_path: '/c.ts' }),
        makeCall('Edit', { file_path: '/d.ts' }),
      ];
      expect(detectCycle(calls, 6)).toBeNull();
    });

    it('returns null when insufficient calls for window', () => {
      const calls = [
        makeCall('Read', { file_path: '/a.ts' }),
        makeCall('Read', { file_path: '/a.ts' }),
      ];
      expect(detectCycle(calls, 6)).toBeNull();
    });

    it('skips non-divisible pattern lengths', () => {
      // Window of 10 should not check pattern length 3 (10 % 3 !== 0)
      // Build a pattern that repeats with length 2 (10/2 = 5)
      const calls = Array.from({ length: 10 }, (_, i) =>
        i % 2 === 0
          ? makeCall('Read', { file_path: '/src/foo.ts' })
          : makeCall('Edit', { file_path: '/src/foo.ts' })
      );
      const result = detectCycle(calls, 10);
      expect(result).not.toBeNull();
      expect(result!.repetitions).toBe(5);
    });

    it('uses last N calls from a larger array', () => {
      const prefix = [
        makeCall('Bash', { command: 'git status' }),
        makeCall('Write', { file_path: '/unrelated.ts' }),
      ];
      const cycle = Array.from({ length: 6 }, () =>
        makeCall('Read', { file_path: '/loop.ts' })
      );
      const result = detectCycle([...prefix, ...cycle], 6);
      expect(result).not.toBeNull();
      expect(result!.affectedFiles).toContain('/loop.ts');
    });

    it('includes description in detection result', () => {
      const calls = Array.from({ length: 6 }, () =>
        makeCall('Read', { file_path: '/src/foo.ts' })
      );
      const result = detectCycle(calls, 6);
      expect(result!.description).toContain('Repeating cycle');
      expect(result!.description).toContain('Read');
    });
  });
});
