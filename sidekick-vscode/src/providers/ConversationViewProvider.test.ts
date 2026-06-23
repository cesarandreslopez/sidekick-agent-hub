import { describe, expect, it, vi } from 'vitest';
import type { ClaudeSessionEvent } from '../types/claudeSession';

vi.mock('vscode', () => ({
  default: {},
}));

vi.mock('../services/Logger', () => ({
  log: vi.fn(),
  logError: vi.fn(),
}));

import { conversationChunksFromSessionEvents } from './ConversationViewProvider';

describe('conversationChunksFromSessionEvents', () => {
  it('renders Claude assistant thinking, tools, and answer from the shared timeline projection', () => {
    const events: ClaudeSessionEvent[] = [
      {
        type: 'assistant',
        timestamp: '2026-06-17T10:00:00.000Z',
        message: {
          role: 'assistant',
          model: 'claude-sonnet-4-6',
          content: [
            { type: 'thinking', thinking: 'Need to inspect the file.' },
            {
              type: 'tool_use',
              id: 'read-1',
              name: 'Read',
              input: { file_path: '/workspace/src/a.ts' },
            },
            { type: 'text', text: 'The answer is ready.' },
          ],
        },
      },
    ];

    const chunks = conversationChunksFromSessionEvents(events);

    expect(chunks.map((chunk) => chunk.role)).toEqual(['reasoning', 'tool', 'assistant']);
    expect(chunks[0].content).toBe('Need to inspect the file.');
    expect(chunks[1]).toMatchObject({ role: 'tool', toolName: 'Read', toolUseId: 'read-1' });
    // Tool-call rows carry their gist in the header summary only (no separate,
    // redundant input body) and have no output, so they render concise.
    expect(chunks[1].toolSummary).toContain('a.ts');
    expect(chunks[1].toolOutput).toBeUndefined();
    expect(chunks[2]).toMatchObject({
      role: 'assistant',
      content: 'The answer is ready.',
      model: 'claude-sonnet-4-6',
    });
    expect(chunks.map((chunk) => chunk.content).join('\n')).not.toContain('[Thinking]');
  });

  it('preserves Codex split reasoning and tool-call order before the final answer', () => {
    const events: ClaudeSessionEvent[] = [
      {
        type: 'assistant',
        timestamp: '2026-06-17T10:00:00.000Z',
        message: {
          role: 'assistant',
          model: 'gpt-5-codex',
          content: [
            { type: 'thinking', thinking: '**Inspect files**\n\nNeed the implementation.' },
          ],
        },
      },
      {
        type: 'assistant',
        timestamp: '2026-06-17T10:00:01.000Z',
        message: {
          role: 'assistant',
          model: 'gpt-5-codex',
          content: [
            { type: 'tool_use', id: 'read-1', name: 'Read', input: { file_path: 'src/a.ts' } },
          ],
        },
      },
      {
        type: 'assistant',
        timestamp: '2026-06-17T10:00:02.000Z',
        message: {
          role: 'assistant',
          model: 'gpt-5-codex',
          content: [{ type: 'thinking', thinking: '**Verify**\n\nRun the tests.' }],
        },
      },
      {
        type: 'assistant',
        timestamp: '2026-06-17T10:00:03.000Z',
        message: {
          role: 'assistant',
          model: 'gpt-5-codex',
          content: [
            { type: 'tool_use', id: 'bash-1', name: 'Bash', input: { command: 'npm test' } },
          ],
        },
      },
      {
        type: 'assistant',
        timestamp: '2026-06-17T10:00:04.000Z',
        message: {
          role: 'assistant',
          model: 'gpt-5-codex',
          content: [{ type: 'text', text: 'Tests are passing.' }],
        },
      },
    ];

    const chunks = conversationChunksFromSessionEvents(events);

    expect(chunks.map((chunk) => chunk.role)).toEqual([
      'reasoning',
      'tool',
      'reasoning',
      'tool',
      'assistant',
    ]);
    expect(chunks.map((chunk) => chunk.toolName).filter(Boolean)).toEqual(['Read', 'Bash']);
    expect(chunks[chunks.length - 1].content).toBe('Tests are passing.');
  });

  it('renders OpenCode-style tool results between projected assistant chunks', () => {
    const events: ClaudeSessionEvent[] = [
      {
        type: 'assistant',
        timestamp: '2026-06-17T10:00:00.000Z',
        message: {
          role: 'assistant',
          model: 'opencode',
          content: [
            { type: 'thinking', thinking: 'Need a command result.' },
            { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'npm test' } },
          ],
        },
      },
      {
        type: 'user',
        timestamp: '2026-06-17T10:00:01.000Z',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'ok', is_error: false }],
        },
      },
      {
        type: 'assistant',
        timestamp: '2026-06-17T10:00:02.000Z',
        message: {
          role: 'assistant',
          model: 'opencode',
          content: [{ type: 'text', text: 'The command succeeded.' }],
        },
      },
    ];

    const chunks = conversationChunksFromSessionEvents(events);

    expect(chunks.map((chunk) => chunk.role)).toEqual(['reasoning', 'tool', 'tool', 'assistant']);
    expect(chunks[2]).toMatchObject({
      role: 'tool',
      toolName: 'Bash result',
      toolOutput: 'ok',
      isError: false,
    });
    expect(chunks[3].content).toBe('The command succeeded.');
  });
});
