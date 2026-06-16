import { describe, expect, it } from 'vitest';
import {
  assistantTurnProjectionSchema,
  assistantTurnSubagentSchema,
} from './assistantTurn';

describe('assistantTurnProjectionSchema', () => {
  it('round-trips a process-and-answer projection', () => {
    const projection = {
      schemaVersion: 1,
      answer: 'Use the shared projection helper.',
      reasoning: '**Check**\n\nThe helper is browser-safe.',
      reasoningBlocks: ['**Check**\n\nThe helper is browser-safe.'],
      process: {
        steps: [
          { kind: 'narration', text: 'I will inspect the exports.' },
          {
            kind: 'toolGroup',
            tools: [{ toolName: 'Read', toolInput: 'index.ts', toolUseId: 'read-1' }],
          },
        ],
      },
      subagents: [
        {
          id: 'toolu_1',
          label: 'Inspect the package',
          agentType: 'Explore',
          status: 'completed',
        },
      ],
    };

    const result = assistantTurnProjectionSchema.safeParse(projection);

    expect(result.success).toBe(true);
    expect(result.data).toEqual(projection);
  });

  it('rejects an unknown process step kind', () => {
    const result = assistantTurnProjectionSchema.safeParse({
      schemaVersion: 1,
      answer: '',
      reasoning: '',
      reasoningBlocks: [],
      process: { steps: [{ kind: 'unknown', text: 'bad' }] },
      subagents: [],
    });

    expect(result.success).toBe(false);
  });
});

describe('assistantTurnSubagentSchema', () => {
  it('rejects an unknown subagent status', () => {
    const result = assistantTurnSubagentSchema.safeParse({
      id: 'toolu_1',
      label: 'Inspect',
      status: 'paused',
    });

    expect(result.success).toBe(false);
  });
});
