import { describe, expect, it } from 'vitest';
import {
  assistantTurnEventsFromSessionEvents,
  extractTurnSubagents,
  reasoningSummary,
  segmentAssistantTurn,
} from './assistantTurn';
import type { SessionEvent } from '../types/sessionEvent';

describe('segmentAssistantTurn', () => {
  function flattenedTimelineTools(projection: ReturnType<typeof segmentAssistantTurn>) {
    return projection.timeline.flatMap((item) => (item.kind === 'toolGroup' ? item.tools : []));
  }

  function flattenedProcessTools(projection: ReturnType<typeof segmentAssistantTurn>) {
    return projection.process.steps.flatMap((step) =>
      step.kind === 'toolGroup' ? step.tools : [],
    );
  }

  it('keeps only the final text run as the answer and moves earlier text/tools to process', () => {
    const projection = segmentAssistantTurn([
      { eventType: 'text', content: 'I will inspect the provider.' },
      {
        eventType: 'tool_use',
        content: '',
        toolName: 'Read',
        toolInput: { file_path: 'src/provider.ts' },
      },
      { eventType: 'text', content: 'The provider wires the parser.' },
      {
        eventType: 'thinking',
        content: '**Check parser**\n\nNeed to verify the normalized events.',
      },
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
    expect(projection.timeline).toEqual([
      { kind: 'narration', text: 'I will inspect the provider.' },
      { kind: 'toolGroup', tools: [{ toolName: 'Read', toolInput: 'provider.ts' }] },
      { kind: 'narration', text: 'The provider wires the parser.' },
      { kind: 'reasoning', text: '**Check parser**\n\nNeed to verify the normalized events.' },
    ]);
  });

  it('does not split adjacent tool groups on blank text events', () => {
    const projection = segmentAssistantTurn([
      {
        eventType: 'tool_use',
        content: '',
        toolName: 'Read',
        toolInput: { file_path: 'src/a.ts' },
      },
      { eventType: 'text', content: '\n' },
      {
        eventType: 'tool_use',
        content: '',
        toolName: 'Read',
        toolInput: { file_path: 'src/b.ts' },
      },
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

  it('keeps reasoning between two tool runs in timeline order', () => {
    const projection = segmentAssistantTurn([
      {
        eventType: 'tool_use',
        content: '',
        toolName: 'Read',
        toolInput: { file_path: 'src/a.ts' },
      },
      { eventType: 'thinking', content: 'Need the related file before answering.' },
      {
        eventType: 'tool_use',
        content: '',
        toolName: 'Read',
        toolInput: { file_path: 'src/b.ts' },
      },
      { eventType: 'text', content: 'Both files use the helper.' },
    ]);

    expect(projection.answer).toBe('Both files use the helper.');
    expect(projection.timeline).toEqual([
      { kind: 'toolGroup', tools: [{ toolName: 'Read', toolInput: 'a.ts' }] },
      { kind: 'reasoning', text: 'Need the related file before answering.' },
      { kind: 'toolGroup', tools: [{ toolName: 'Read', toolInput: 'b.ts' }] },
    ]);
  });

  it('keeps timeline content equivalent to reasoning blocks and process steps', () => {
    const projection = segmentAssistantTurn([
      { eventType: 'thinking', content: '**Plan**\n\nInspect first.' },
      { eventType: 'text', content: 'I will inspect the provider.' },
      {
        eventType: 'tool_use',
        content: '',
        toolName: 'Read',
        toolUseId: 'read-1',
        toolInput: { file_path: 'src/provider.ts' },
      },
      { eventType: 'thinking', content: '**Check**\n\nRun the test.' },
      {
        eventType: 'tool_use',
        content: '',
        toolName: 'Bash',
        toolUseId: 'bash-1',
        toolInput: { command: 'npm test' },
      },
      { eventType: 'text', content: 'The provider is wired correctly.' },
    ]);

    expect(
      projection.timeline.filter((item) => item.kind === 'reasoning').map((item) => item.text),
    ).toEqual(projection.reasoningBlocks);
    expect(
      projection.timeline.filter((item) => item.kind === 'narration').map((item) => item.text),
    ).toEqual(
      projection.process.steps.filter((step) => step.kind === 'narration').map((step) => step.text),
    );
    expect(flattenedTimelineTools(projection)).toEqual(flattenedProcessTools(projection));
  });

  it('caps process and reasoning while leaving the answer uncapped', () => {
    const projection = segmentAssistantTurn(
      [
        { eventType: 'thinking', content: 'first reasoning block' },
        { eventType: 'thinking', content: 'second reasoning block' },
        { eventType: 'text', content: 'first narration' },
        {
          eventType: 'tool_use',
          content: '',
          toolName: 'Bash',
          toolInput: { command: 'npm test' },
        },
        { eventType: 'text', content: 'final answer with full detail' },
      ],
      { maxReasoningBlocks: 1, maxProcessSteps: 1 },
    );

    expect(projection.answer).toBe('final answer with full detail');
    expect(projection.reasoningBlocks).toEqual([
      'first reasoning block',
      '... 1 more reasoning block omitted',
    ]);
    expect(projection.process.steps).toEqual([
      { kind: 'narration', text: '... 1 earlier process step omitted' },
      { kind: 'toolGroup', tools: [{ toolName: 'Bash', toolInput: 'npm test' }] },
    ]);
    expect(projection.timeline).toEqual([
      { kind: 'reasoning', text: 'first reasoning block' },
      { kind: 'reasoning', text: '... 1 more reasoning block omitted' },
      { kind: 'narration', text: '... 1 earlier process step omitted' },
      { kind: 'toolGroup', tools: [{ toolName: 'Bash', toolInput: 'npm test' }] },
    ]);
  });

  it('excludes final answer text from timeline and leaves answer empty when a turn ends on a tool', () => {
    const withAnswer = segmentAssistantTurn([
      { eventType: 'thinking', content: 'Need to inspect first.' },
      { eventType: 'text', content: 'Final answer.' },
    ]);
    const endingOnTool = segmentAssistantTurn([
      { eventType: 'text', content: 'I will inspect the file.' },
      {
        eventType: 'tool_use',
        content: '',
        toolName: 'Read',
        toolInput: { file_path: 'src/index.ts' },
      },
    ]);

    expect(withAnswer.answer).toBe('Final answer.');
    expect(withAnswer.timeline).toEqual([{ kind: 'reasoning', text: 'Need to inspect first.' }]);
    expect(endingOnTool.answer).toBe('');
    expect(endingOnTool.timeline).toEqual([
      { kind: 'narration', text: 'I will inspect the file.' },
      { kind: 'toolGroup', tools: [{ toolName: 'Read', toolInput: 'index.ts' }] },
    ]);
  });

  it('returns an empty timeline for empty and pure-answer turns', () => {
    expect(segmentAssistantTurn([]).timeline).toEqual([]);
    expect(
      segmentAssistantTurn([{ eventType: 'text', content: 'Only the final answer.' }]).timeline,
    ).toEqual([]);
  });

  it('applies sanitized tool input to process and timeline tool groups', () => {
    const projection = segmentAssistantTurn(
      [
        {
          eventType: 'tool_use',
          content: '',
          toolName: 'Custom',
          toolUseId: 'tool-1',
          toolInput: { hidden: true },
        },
        { eventType: 'text', content: 'Done.' },
      ],
      {
        sanitizeToolInput: ({ toolName, toolInput, toolUseId }) =>
          JSON.stringify({ toolName, toolInput, toolUseId }),
      },
    );

    expect(projection.timeline).toEqual(projection.process.steps);
    expect(flattenedTimelineTools(projection)).toEqual([
      {
        toolName: 'Custom',
        toolUseId: 'tool-1',
        toolInput: JSON.stringify({
          toolName: 'Custom',
          toolInput: { hidden: true },
          toolUseId: 'tool-1',
        }),
      },
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
    expect(
      projection.process.steps[0].kind === 'toolGroup' &&
        projection.process.steps[0].tools[0].toolInput,
    ).not.toContain('SECRET');
    expect(projection.subagents).toEqual([
      {
        id: 'toolu_1',
        label: 'Inspect the shared package',
        agentType: 'Explore',
        status: 'completed',
      },
    ]);
  });

  it('interleaves provider-normalized Claude and Codex thinking fixtures', () => {
    const claudeEvents: SessionEvent[] = [
      {
        type: 'assistant',
        timestamp: '2026-06-15T00:00:00.000Z',
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'Need to inspect the file.' },
            { type: 'tool_use', id: 'read-claude', name: 'Read', input: { file_path: 'src/a.ts' } },
            { type: 'text', text: 'Claude answer.' },
          ],
        },
      },
    ];
    const codexEvents: SessionEvent[] = [
      {
        type: 'assistant',
        timestamp: '2026-06-15T00:00:00.000Z',
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: '**Inspect files**\n\nNeed the current implementation.' },
            { type: 'tool_use', id: 'read-codex', name: 'Read', input: { file_path: 'src/b.ts' } },
            { type: 'thinking', thinking: '**Verify**\n\nCheck the tests.' },
            { type: 'tool_use', id: 'bash-codex', name: 'Bash', input: { command: 'npm test' } },
            { type: 'text', text: 'Codex answer.' },
          ],
        },
      },
    ];

    expect(
      segmentAssistantTurn(assistantTurnEventsFromSessionEvents(claudeEvents)).timeline,
    ).toEqual([
      { kind: 'reasoning', text: 'Need to inspect the file.' },
      {
        kind: 'toolGroup',
        tools: [{ toolName: 'Read', toolUseId: 'read-claude', toolInput: 'a.ts' }],
      },
    ]);
    expect(
      segmentAssistantTurn(assistantTurnEventsFromSessionEvents(codexEvents)).timeline,
    ).toEqual([
      { kind: 'reasoning', text: '**Inspect files**\n\nNeed the current implementation.' },
      {
        kind: 'toolGroup',
        tools: [{ toolName: 'Read', toolUseId: 'read-codex', toolInput: 'b.ts' }],
      },
      { kind: 'reasoning', text: '**Verify**\n\nCheck the tests.' },
      {
        kind: 'toolGroup',
        tools: [{ toolName: 'Bash', toolUseId: 'bash-codex', toolInput: 'npm test' }],
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
      {
        eventType: 'tool_use',
        content: '',
        toolName: 'Read',
        toolUseId: 'read-1',
        toolInput: { file_path: 'src/index.ts' },
      },
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
          {
            toolName: 'Task',
            toolUseId: 'a',
            toolInput: { description: 'Investigate', subagent_type: 'Explore' },
          },
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
