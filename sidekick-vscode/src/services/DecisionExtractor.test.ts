/**
 * @fileoverview Tests for DecisionExtractor pure functions.
 *
 * @module DecisionExtractor.test
 */

import { describe, it, expect } from 'vitest';
import {
  fromRecoveryPatterns,
  fromUserQuestions,
  fromPlanMode,
  fromAssistantTexts,
  extractDecisions,
} from './DecisionExtractor';
import type { RecoveryPattern, SessionAnalysisData } from '../types/analysis';
import type { ToolCall } from '../types/claudeSession';

const SESSION_ID = 'test-session-123';

function makeToolCall(overrides: Partial<ToolCall> & { name: string }): ToolCall {
  return {
    input: {},
    timestamp: new Date('2026-02-18T10:00:00Z'),
    ...overrides,
  };
}

describe('DecisionExtractor', () => {
  describe('fromRecoveryPatterns', () => {
    it('converts recovery patterns to decision entries', () => {
      const patterns: RecoveryPattern[] = [
        {
          type: 'command_fallback',
          description: 'Package manager fallback',
          failedApproach: 'npm install',
          successfulApproach: 'pnpm install',
          occurrences: 2,
        },
      ];

      const entries = fromRecoveryPatterns(patterns, SESSION_ID);

      expect(entries).toHaveLength(1);
      expect(entries[0].description).toBe('Package manager fallback');
      expect(entries[0].chosenOption).toBe('pnpm install');
      expect(entries[0].alternatives).toEqual(['npm install']);
      expect(entries[0].rationale).toBe('npm install failed, switched to pnpm install');
      expect(entries[0].source).toBe('recovery_pattern');
      expect(entries[0].sessionId).toBe(SESSION_ID);
    });

    it('returns empty array for no patterns', () => {
      expect(fromRecoveryPatterns([], SESSION_ID)).toEqual([]);
    });

    it('handles multiple patterns', () => {
      const patterns: RecoveryPattern[] = [
        {
          type: 'command_fallback',
          description: 'First recovery',
          failedApproach: 'A',
          successfulApproach: 'B',
          occurrences: 1,
        },
        {
          type: 'path_alternative',
          description: 'Second recovery',
          failedApproach: 'C',
          successfulApproach: 'D',
          occurrences: 1,
        },
      ];

      const entries = fromRecoveryPatterns(patterns, SESSION_ID);
      expect(entries).toHaveLength(2);
    });
  });

  describe('fromUserQuestions', () => {
    it('extracts decisions from AskUserQuestion tool calls', () => {
      const toolCalls: ToolCall[] = [
        makeToolCall({
          name: 'AskUserQuestion',
          input: {
            questions: [
              {
                question: 'Which database should we use?',
                options: [
                  { label: 'PostgreSQL' },
                  { label: 'SQLite' },
                  { label: 'MongoDB' },
                ],
              },
            ],
          },
        }),
      ];

      const entries = fromUserQuestions(toolCalls, SESSION_ID);

      expect(entries).toHaveLength(1);
      expect(entries[0].description).toBe('Which database should we use?');
      expect(entries[0].alternatives).toEqual(['PostgreSQL', 'SQLite', 'MongoDB']);
      expect(entries[0].chosenOption).toBe('(awaiting result)');
      expect(entries[0].source).toBe('user_question');
    });

    it('ignores non-AskUserQuestion tool calls', () => {
      const toolCalls: ToolCall[] = [
        makeToolCall({ name: 'Read', input: { file_path: '/foo.ts' } }),
        makeToolCall({ name: 'Write', input: { file_path: '/bar.ts', content: '' } }),
      ];

      const entries = fromUserQuestions(toolCalls, SESSION_ID);
      expect(entries).toEqual([]);
    });

    it('handles missing questions array', () => {
      const toolCalls: ToolCall[] = [
        makeToolCall({ name: 'AskUserQuestion', input: {} }),
      ];

      const entries = fromUserQuestions(toolCalls, SESSION_ID);
      expect(entries).toEqual([]);
    });

    it('handles questions with no options', () => {
      const toolCalls: ToolCall[] = [
        makeToolCall({
          name: 'AskUserQuestion',
          input: {
            questions: [{ question: 'How should we proceed?' }],
          },
        }),
      ];

      const entries = fromUserQuestions(toolCalls, SESSION_ID);

      expect(entries).toHaveLength(1);
      expect(entries[0].alternatives).toBeUndefined();
    });

    it('handles multiple questions in a single tool call', () => {
      const toolCalls: ToolCall[] = [
        makeToolCall({
          name: 'AskUserQuestion',
          input: {
            questions: [
              { question: 'Question 1?', options: [{ label: 'A' }] },
              { question: 'Question 2?', options: [{ label: 'B' }] },
            ],
          },
        }),
      ];

      const entries = fromUserQuestions(toolCalls, SESSION_ID);
      expect(entries).toHaveLength(2);
    });
  });

  describe('fromPlanMode', () => {
    it('creates decision for ExitPlanMode calls', () => {
      const toolCalls: ToolCall[] = [
        makeToolCall({
          name: 'EnterPlanMode',
          timestamp: new Date('2026-02-18T10:00:00Z'),
        }),
        makeToolCall({
          name: 'ExitPlanMode',
          timestamp: new Date('2026-02-18T10:05:00Z'),
        }),
      ];

      const entries = fromPlanMode(toolCalls, SESSION_ID);

      expect(entries).toHaveLength(1);
      expect(entries[0].description).toBe('Plan mode session completed');
      expect(entries[0].chosenOption).toBe('Plan approved');
      expect(entries[0].source).toBe('plan_mode');
      expect(entries[0].rationale).toContain('5min');
    });

    it('handles ExitPlanMode without matching EnterPlanMode', () => {
      const toolCalls: ToolCall[] = [
        makeToolCall({
          name: 'ExitPlanMode',
          timestamp: new Date('2026-02-18T10:05:00Z'),
        }),
      ];

      const entries = fromPlanMode(toolCalls, SESSION_ID);

      expect(entries).toHaveLength(1);
      expect(entries[0].rationale).toBe('Explicit planning session');
    });

    it('returns empty for no plan mode calls', () => {
      const toolCalls: ToolCall[] = [
        makeToolCall({ name: 'Read' }),
      ];

      const entries = fromPlanMode(toolCalls, SESSION_ID);
      expect(entries).toEqual([]);
    });

    it('handles multiple plan mode cycles', () => {
      const toolCalls: ToolCall[] = [
        makeToolCall({ name: 'EnterPlanMode', timestamp: new Date('2026-02-18T10:00:00Z') }),
        makeToolCall({ name: 'ExitPlanMode', timestamp: new Date('2026-02-18T10:02:00Z') }),
        makeToolCall({ name: 'EnterPlanMode', timestamp: new Date('2026-02-18T10:10:00Z') }),
        makeToolCall({ name: 'ExitPlanMode', timestamp: new Date('2026-02-18T10:15:00Z') }),
      ];

      const entries = fromPlanMode(toolCalls, SESSION_ID);
      expect(entries).toHaveLength(2);
    });
  });

  describe('fromAssistantTexts', () => {
    it('matches "I\'ll use X because Y" pattern', () => {
      const texts = [
        {
          text: "I'll use pnpm because npm has known lockfile conflicts with this project",
          timestamp: '2026-02-18T10:00:00Z',
        },
      ];

      const entries = fromAssistantTexts(texts, SESSION_ID);

      expect(entries).toHaveLength(1);
      expect(entries[0].chosenOption).toBe('pnpm');
      expect(entries[0].rationale).toContain('npm has known lockfile conflicts');
      expect(entries[0].source).toBe('text_pattern');
    });

    it('matches Unicode apostrophe decision text ("I’ll use")', () => {
      const texts = [
        {
          text: 'I’ll use Vitest because it has native ESM support and faster execution.',
          timestamp: '2026-02-18T10:00:00Z',
        },
      ];

      const entries = fromAssistantTexts(texts, SESSION_ID);
      expect(entries).toHaveLength(1);
      expect(entries[0].chosenOption).toBe('Vitest');
    });

    it('matches "decided on X over Y" pattern', () => {
      const texts = [
        {
          text: 'I decided on vitest over jest for better ESM support',
          timestamp: '2026-02-18T10:00:00Z',
        },
      ];

      const entries = fromAssistantTexts(texts, SESSION_ID);

      expect(entries).toHaveLength(1);
      expect(entries[0].chosenOption).toBe('vitest');
      expect(entries[0].alternatives).toEqual(['jest for better ESM support']);
    });

    it('skips matches with short chosen option', () => {
      const texts = [
        {
          text: "I'll use it because the documentation says so and it works well",
          timestamp: '2026-02-18T10:00:00Z',
        },
      ];

      const entries = fromAssistantTexts(texts, SESSION_ID);
      // "it" is only 2 chars, below the 3-char minimum
      expect(entries).toEqual([]);
    });

    it('returns empty for no matching text', () => {
      const texts = [
        {
          text: 'The build completed successfully with no errors.',
          timestamp: '2026-02-18T10:00:00Z',
        },
      ];

      const entries = fromAssistantTexts(texts, SESSION_ID);
      expect(entries).toEqual([]);
    });

    it('only takes first match per text block', () => {
      const texts = [
        {
          text: "I'll use pnpm because it's faster. I'll also go with vitest because it supports ESM natively.",
          timestamp: '2026-02-18T10:00:00Z',
        },
      ];

      const entries = fromAssistantTexts(texts, SESSION_ID);
      expect(entries).toHaveLength(1);
    });
  });

  describe('extractDecisions (top-level)', () => {
    it('combines all four sources', () => {
      const analysisData = {
        recoveryPatterns: [
          {
            type: 'command_fallback' as const,
            description: 'Recovery decision',
            failedApproach: 'A',
            successfulApproach: 'B',
            occurrences: 1,
          },
        ],
        errors: [],
        toolPatterns: [],
        inefficiencies: [],
        recentActivity: [],
        sessionDuration: 0,
        totalTokens: 0,
        projectPath: '/test',
        hasEnoughData: true,
      } satisfies SessionAnalysisData;

      const toolCalls: ToolCall[] = [
        makeToolCall({
          name: 'AskUserQuestion',
          input: {
            questions: [{ question: 'Which framework?', options: [{ label: 'React' }] }],
          },
        }),
        makeToolCall({ name: 'EnterPlanMode', timestamp: new Date('2026-02-18T10:00:00Z') }),
        makeToolCall({ name: 'ExitPlanMode', timestamp: new Date('2026-02-18T10:05:00Z') }),
      ];

      const assistantTexts = [
        {
          text: "I'll use TypeScript because it provides better type safety for this project",
          timestamp: '2026-02-18T10:00:00Z',
        },
      ];

      const entries = extractDecisions(analysisData, toolCalls, assistantTexts, SESSION_ID);

      const sources = entries.map(e => e.source);
      expect(sources).toContain('recovery_pattern');
      expect(sources).toContain('user_question');
      expect(sources).toContain('plan_mode');
      expect(sources).toContain('text_pattern');
    });

    it('deduplicates by description+source', () => {
      const analysisData = {
        recoveryPatterns: [
          {
            type: 'command_fallback' as const,
            description: 'Same description',
            failedApproach: 'A',
            successfulApproach: 'B',
            occurrences: 1,
          },
          {
            type: 'command_fallback' as const,
            description: 'Same description',
            failedApproach: 'A',
            successfulApproach: 'B',
            occurrences: 2,
          },
        ],
        errors: [],
        toolPatterns: [],
        inefficiencies: [],
        recentActivity: [],
        sessionDuration: 0,
        totalTokens: 0,
        projectPath: '/test',
        hasEnoughData: true,
      } satisfies SessionAnalysisData;

      const entries = extractDecisions(analysisData, [], [], SESSION_ID);

      expect(entries).toHaveLength(1);
    });

    it('handles null analysisData', () => {
      const entries = extractDecisions(null, [], [], SESSION_ID);
      expect(entries).toEqual([]);
    });
  });
});
