import { describe, expect, it } from 'vitest';
import {
  assistantTurnEventsFromSessionEvents,
  extractTurnSubagents,
  reasoningSummary,
  segmentAssistantTurn,
} from './assistantTurn';
import type { SessionEvent } from '../types/sessionEvent';

describe('segmentAssistantTurn', () => {
  it('keeps only the final text run as the answer and moves earlier text/tools to process', () => {
    const projection = segmentAssistantTurn([
      { eventType: 'text', content: 'I will inspect the provider.' },
      { eventType: 'tool_use', content: '', toolName: 'Read', toolInput: { file_path: 'src/provider.ts' } },
      { eventType: 'text', content: 'The provider wires the parser.' },
      { eventType: 'thinking', content: '**Check parser**\n\nNeed to verify the normalized events.' },
      { eventType: 'text', content: 'The provider uses the canonical parser path.' },
    ]);

    expect(projection.answer).toBe('The provider uses the canonical parser path.');
    expect(projection.reasoning).toBe('**Check parser**\n\nNeed to verify the normalized events.');
    expect(projection.reasoningBlocks).toEqual([
      '**Check parser**\n\nNeed to verify the normalized events.',
    ]);
    expect(projection.process.steps).toEqual([
      { kind: 'narration', text: 'I will inspect the provider.' },
      { kind: 'toolGroup', tools: [{ toolName: 'Read', toolInput: 'provider.ts' }] },
      { kind: 'narration', text: 'The provider wires the parser.' },
    ]);
  });

  it('does not split adjacent tool groups on blank text events', () => {
    const projection = segmentAssistantTurn([
      { eventType: 'tool_use', content: '', toolName: 'Read', toolInput: { file_path: 'src/a.ts' } },
      { eventType: 'text', content: '\n' },
      { eventType: 'tool_use', content: '', toolName: 'Read', toolInput: { file_path: 'src/b.ts' } },
      { eventType: 'text', content: 'Both files use the same helper.' },
    ]);

    expect(projection.answer).toBe('Both files use the same helper.');
    expect(projection.process.steps).toEqual([
      {
        kind: 'toolGroup',
        tools: [
          { toolName: 'Read', toolInput: 'a.ts' },
          { toolName: 'Read', toolInput: 'b.ts' },
        ],
      },
    ]);
  });

  it('caps process and reasoning while leaving the answer uncapped', () => {
    const projection = segmentAssistantTurn(
      [
        { eventType: 'thinking', content: 'first reasoning block' },
        { eventType: 'thinking', content: 'second reasoning block' },
        { eventType: 'text', content: 'first narration' },
        { eventType: 'tool_use', content: '', toolName: 'Bash', toolInput: { command: 'npm test' } },
        { eventType: 'text', content: 'final answer with full detail' },
      ],
      { maxReasoningBlocks: 1, maxProcessSteps: 1 },
    );

    expect(projection.answer).toBe('final answer with full detail');
    expect(projection.reasoningBlocks).toEqual(['first reasoning block', '... 1 more reasoning block omitted']);
    expect(projection.process.steps).toEqual([
      { kind: 'narration', text: '... 1 earlier process step omitted' },
      { kind: 'toolGroup', tools: [{ toolName: 'Bash', toolInput: 'npm test' }] },
    ]);
  });

  it('projects Task tool calls as subagents without leaking the prompt', () => {
    const projection = segmentAssistantTurn([
      {
        eventType: 'tool_use',
        content: '',
        toolName: 'Task',
        toolUseId: 'toolu_1',
        toolInput: {
          subagent_type: 'Explore',
          description: 'Inspect the shared package',
          prompt: 'SECRET long task prompt that should not be exposed',
        },
      },
      { eventType: 'text', content: 'The subagent finished.' },
    ]);

    expect(projection.process.steps).toEqual([
      {
        kind: 'toolGroup',
        tools: [
          {
            toolName: 'Task',
            toolUseId: 'toolu_1',
            toolInput: JSON.stringify({
              subagent_type: 'Explore',
              description: 'Inspect the shared package',
            }),
          },
        ],
      },
    ]);
    expect(projection.process.steps[0].kind === 'toolGroup' && projection.process.steps[0].tools[0].toolInput).not.toContain(
      'SECRET',
    );
    expect(projection.subagents).toEqual([
      {
        id: 'toolu_1',
        label: 'Inspect the shared package',
        agentType: 'Explore',
        status: 'completed',
      },
    ]);
  });
});

describe('assistantTurnEventsFromSessionEvents', () => {
  it('adapts canonical SessionEvent blocks into turn events', () => {
    const events: SessionEvent[] = [
      {
        type: 'assistant',
        timestamp: '2026-06-15T00:00:00.000Z',
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: '**Plan**\n\nInspect before answering.' },
            { type: 'text', text: 'I will read the file.' },
            { type: 'tool_use', id: 'read-1', name: 'Read', input: { file_path: 'src/index.ts' } },
            { type: 'text', text: 'The package exports the helper.' },
          ],
        },
      },
      {
        type: 'tool_use',
        timestamp: '2026-06-15T00:00:01.000Z',
        message: { role: 'assistant' },
        tool: { name: 'Bash', input: { command: 'npm test' } },
      },
    ];

    expect(assistantTurnEventsFromSessionEvents(events)).toEqual([
      { eventType: 'thinking', content: '**Plan**\n\nInspect before answering.' },
      { eventType: 'text', content: 'I will read the file.' },
      { eventType: 'tool_use', content: '', toolName: 'Read', toolUseId: 'read-1', toolInput: { file_path: 'src/index.ts' } },
      { eventType: 'text', content: 'The package exports the helper.' },
      { eventType: 'tool_use', content: '', toolName: 'Bash', toolInput: { command: 'npm test' } },
    ]);
  });
});

describe('reasoningSummary', () => {
  it('extracts a leading bold heading across LF and CRLF content', () => {
    expect(reasoningSummary('**Review imports**\n\nNeed schema exports.')).toEqual({
      title: 'Review imports',
      body: 'Need schema exports.',
    });
    expect(reasoningSummary('**Review imports**\r\n\r\nNeed schema exports.')).toEqual({
      title: 'Review imports',
      body: 'Need schema exports.',
    });
  });
});

describe('extractTurnSubagents', () => {
  it('uses description, then agent type, then fallback labels', () => {
    expect(
      extractTurnSubagents(
        [
          { toolName: 'Task', toolUseId: 'a', toolInput: { description: 'Investigate', subagent_type: 'Explore' } },
          { toolName: 'Task', toolUseId: 'b', toolInput: { subagent_type: 'Plan' } },
          { toolName: 'Task', toolUseId: 'c', toolInput: {} },
          { toolName: 'Read', toolInput: { file_path: 'src/index.ts' } },
        ],
        { status: 'running' },
      ),
    ).toEqual([
      { id: 'a', label: 'Investigate', agentType: 'Explore', status: 'running' },
      { id: 'b', label: 'Plan', agentType: 'Plan', status: 'running' },
      { id: 'c', label: 'Agent 3', status: 'running' },
    ]);
  });
});
