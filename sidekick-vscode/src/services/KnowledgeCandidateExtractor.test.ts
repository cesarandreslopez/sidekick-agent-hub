/**
 * @fileoverview Tests for KnowledgeCandidateExtractor.
 *
 * Tests gotcha, pattern, and guideline extraction from session data.
 *
 * @module KnowledgeCandidateExtractor.test
 */

import { describe, it, expect } from 'vitest';
import {
  extractGotchaCandidates,
  extractPatternCandidates,
  extractGuidelineCandidates,
  extractKnowledgeCandidates,
} from './KnowledgeCandidateExtractor';
import type { RecoveryPattern } from '../types/analysis';
import type { ToolCall } from '../types/claudeSession';

function makeToolCall(overrides: Partial<ToolCall> = {}): ToolCall {
  return {
    name: 'Edit',
    input: { file_path: '/project/src/foo.ts' },
    errorMessage: 'Error: permission denied',
    isError: true,
    timestamp: new Date('2026-02-18T10:00:00Z'),
    duration: 100,
    ...overrides,
  };
}

const PROJECT_PATH = '/project';

describe('KnowledgeCandidateExtractor', () => {
  describe('extractGotchaCandidates', () => {
    it('extracts gotcha when file has 3+ errors', () => {
      const toolCalls: ToolCall[] = [
        makeToolCall({ input: { file_path: '/project/src/tricky.ts' }, errorMessage: 'Error 1' }),
        makeToolCall({ input: { file_path: '/project/src/tricky.ts' }, errorMessage: 'Error 2' }),
        makeToolCall({ input: { file_path: '/project/src/tricky.ts' }, errorMessage: 'Error 3' }),
      ];

      const candidates = extractGotchaCandidates([], toolCalls, PROJECT_PATH);
      expect(candidates).toHaveLength(1);
      expect(candidates[0].noteType).toBe('gotcha');
      expect(candidates[0].filePath).toBe('src/tricky.ts');
      expect(candidates[0].source).toBe('auto_error');
    });

    it('ignores files with fewer than 3 errors', () => {
      const toolCalls: ToolCall[] = [
        makeToolCall({ input: { file_path: '/project/src/ok.ts' }, errorMessage: 'Error 1' }),
        makeToolCall({ input: { file_path: '/project/src/ok.ts' }, errorMessage: 'Error 2' }),
      ];

      const candidates = extractGotchaCandidates([], toolCalls, PROJECT_PATH);
      expect(candidates).toHaveLength(0);
    });

    it('ignores non-error tool calls', () => {
      const toolCalls: ToolCall[] = [
        makeToolCall({ input: { file_path: '/project/src/ok.ts' }, isError: false }),
        makeToolCall({ input: { file_path: '/project/src/ok.ts' }, isError: false }),
        makeToolCall({ input: { file_path: '/project/src/ok.ts' }, isError: false }),
      ];

      const candidates = extractGotchaCandidates([], toolCalls, PROJECT_PATH);
      expect(candidates).toHaveLength(0);
    });
  });

  describe('extractPatternCandidates', () => {
    it('extracts pattern from recovery pattern with file path', () => {
      const patterns: RecoveryPattern[] = [{
        type: 'approach_switch',
        description: 'Fixed /project/src/api.ts by switching approach',
        failedApproach: 'direct import',
        successfulApproach: 'dynamic import',
        occurrences: 1,
      }];

      const candidates = extractPatternCandidates(patterns, [], PROJECT_PATH);
      expect(candidates).toHaveLength(1);
      expect(candidates[0].noteType).toBe('pattern');
      expect(candidates[0].filePath).toBe('src/api.ts');
      expect(candidates[0].source).toBe('auto_recovery');
    });

    it('skips recovery patterns without file paths', () => {
      const patterns: RecoveryPattern[] = [{
        type: 'command_fallback',
        description: 'Used pnpm instead of npm',
        failedApproach: 'npm install',
        successfulApproach: 'pnpm install',
        occurrences: 1,
      }];

      const candidates = extractPatternCandidates(patterns, [], PROJECT_PATH);
      expect(candidates).toHaveLength(0);
    });
  });

  describe('extractGuidelineCandidates', () => {
    it('extracts guideline from suggestion mentioning a file', () => {
      const suggestions = [{
        title: 'Improve API error handling',
        observed: 'Multiple errors in src/services/auth.ts',
        suggestion: 'Add retry logic for transient failures',
        reasoning: 'The auth service fails often on network issues',
      }];

      const candidates = extractGuidelineCandidates(suggestions, PROJECT_PATH);
      expect(candidates).toHaveLength(1);
      expect(candidates[0].noteType).toBe('guideline');
      expect(candidates[0].filePath).toBe('src/services/auth.ts');
    });

    it('skips suggestions without file paths', () => {
      const suggestions = [{
        title: 'General improvement',
        observed: 'Session was slow',
        suggestion: 'Use caching',
        reasoning: 'Reduce API calls',
      }];

      const candidates = extractGuidelineCandidates(suggestions, PROJECT_PATH);
      expect(candidates).toHaveLength(0);
    });
  });

  describe('extractKnowledgeCandidates', () => {
    it('combines and deduplicates across sources', () => {
      const toolCalls: ToolCall[] = [
        makeToolCall({ input: { file_path: '/project/src/tricky.ts' }, errorMessage: 'Error 1' }),
        makeToolCall({ input: { file_path: '/project/src/tricky.ts' }, errorMessage: 'Error 2' }),
        makeToolCall({ input: { file_path: '/project/src/tricky.ts' }, errorMessage: 'Error 3' }),
      ];

      const patterns: RecoveryPattern[] = [{
        type: 'approach_switch',
        description: 'Fixed /project/src/api.ts',
        failedApproach: 'approach A',
        successfulApproach: 'approach B',
        occurrences: 1,
      }];

      const candidates = extractKnowledgeCandidates(
        [], patterns, toolCalls, [], PROJECT_PATH
      );

      expect(candidates.length).toBeGreaterThanOrEqual(2);
      // Should have one gotcha and one pattern
      expect(candidates.some(c => c.noteType === 'gotcha')).toBe(true);
      expect(candidates.some(c => c.noteType === 'pattern')).toBe(true);
    });

    it('deduplicates by filePath + noteType', () => {
      // Create two sources that would produce gotcha for the same file
      const toolCalls: ToolCall[] = [
        makeToolCall({ input: { file_path: '/project/src/dup.ts' }, errorMessage: 'Error A' }),
        makeToolCall({ input: { file_path: '/project/src/dup.ts' }, errorMessage: 'Error B' }),
        makeToolCall({ input: { file_path: '/project/src/dup.ts' }, errorMessage: 'Error C' }),
      ];

      const candidates = extractKnowledgeCandidates(
        [], [], toolCalls, [], PROJECT_PATH
      );

      const dupCandidates = candidates.filter(c => c.filePath === 'src/dup.ts' && c.noteType === 'gotcha');
      expect(dupCandidates).toHaveLength(1);
    });

    it('returns empty array when no candidates found', () => {
      const candidates = extractKnowledgeCandidates([], [], [], [], PROJECT_PATH);
      expect(candidates).toEqual([]);
    });
  });
});
