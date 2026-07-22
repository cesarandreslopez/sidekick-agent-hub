import { describe, it, expect } from 'vitest';
import { extractToolCall, extractToolCalls, ToolCallTracker } from './toolCall';
import { categorizeError, extractErrorMessage } from './errorTaxonomy';
import type { SessionEvent } from '../types/sessionEvent';

function makeAssistantEvent(content: unknown[]): SessionEvent {
  return {
    type: 'assistant',
    timestamp: '2026-03-23T10:00:00Z',
    message: { role: 'assistant', content },
  };
}

describe('extractToolCalls', () => {
  it('extracts tool_use blocks from assistant content', () => {
    const event = makeAssistantEvent([
      { type: 'text', text: 'Let me read that file.' },
      { type: 'tool_use', id: 'tu_1', name: 'Read', input: { file_path: '/foo.ts' } },
      { type: 'tool_use', id: 'tu_2', name: 'Bash', input: { command: 'ls' } },
    ]);

    const calls = extractToolCalls(event);
    expect(calls).toHaveLength(2);
    expect(calls[0].name).toBe('Read');
    expect(calls[0].input).toEqual({ file_path: '/foo.ts' });
    expect(calls[0].toolUseId).toBe('tu_1');
    expect(calls[0].timestamp).toBeInstanceOf(Date);
    expect(calls[1].name).toBe('Bash');
    expect(calls[1].toolUseId).toBe('tu_2');
  });

  it('returns empty array for user events', () => {
    const event: SessionEvent = {
      type: 'user',
      timestamp: '2026-03-23T10:00:00Z',
      message: { role: 'user', content: 'hello' },
    };
    expect(extractToolCalls(event)).toEqual([]);
  });

  it('returns empty array when content is not an array', () => {
    const event: SessionEvent = {
      type: 'assistant',
      timestamp: '2026-03-23T10:00:00Z',
      message: { role: 'assistant', content: 'just text' },
    };
    expect(extractToolCalls(event)).toEqual([]);
  });

  it('skips blocks without a name', () => {
    const event = makeAssistantEvent([{ type: 'tool_use', id: 'tu_1', input: { x: 1 } }]);
    expect(extractToolCalls(event)).toEqual([]);
  });

  it('defaults input to empty object when missing', () => {
    const event = makeAssistantEvent([{ type: 'tool_use', id: 'tu_1', name: 'Glob' }]);
    const calls = extractToolCalls(event);
    expect(calls).toHaveLength(1);
    expect(calls[0].input).toEqual({});
  });

  it('handles mixed content blocks', () => {
    const event = makeAssistantEvent([
      { type: 'thinking', thinking: 'hmm' },
      { type: 'tool_use', id: 'tu_1', name: 'Read', input: { file_path: '/a.ts' } },
      { type: 'text', text: 'done' },
    ]);
    expect(extractToolCalls(event)).toHaveLength(1);
  });
});

describe('ToolCallTracker message-less events', () => {
  it('ignores a message-less summary without throwing', () => {
    const tracker = new ToolCallTracker();
    const summary = { type: 'summary', timestamp: '2026-03-23T10:00:00Z' } as SessionEvent;

    expect(tracker.process(summary)).toEqual([]);
  });
});

describe('extractToolCall', () => {
  it('extracts a top-level tool_use event', () => {
    const event: SessionEvent = {
      type: 'tool_use',
      timestamp: '2026-03-23T10:00:00Z',
      message: { role: 'assistant' },
      tool: { name: 'Read', input: { file_path: '/foo.ts' } },
    };

    const call = extractToolCall(event);
    expect(call?.name).toBe('Read');
    expect(call?.input).toEqual({ file_path: '/foo.ts' });
    expect(call?.timestamp).toBeInstanceOf(Date);
  });

  it('returns null for assistant content-block events', () => {
    expect(
      extractToolCall(
        makeAssistantEvent([{ type: 'tool_use', id: 'tu_1', name: 'Read', input: {} }]),
      ),
    ).toBeNull();
  });
});

describe('shared error taxonomy', () => {
  it.each([
    ['permission denied', undefined, 'permission'],
    ['missing', 'AuthError', 'permission'],
    ['No such file or directory', undefined, 'not_found'],
    ['deadline exceeded', undefined, 'timeout'],
    ['Syntax error near token', undefined, 'syntax'],
    ['process exited with exit code 2', undefined, 'exit_code'],
    ['response too long', 'OutputLengthError', 'tool_error'],
    ['provider failed', 'APIError', 'tool_error'],
  ])('classifies %s (%s)', (message, providerType, expected) => {
    expect(categorizeError(message, providerType)).toBe(expected);
  });

  it('keeps the extension error label contract', () => {
    expect(extractErrorMessage('<tool_use_error>bad input</tool_use_error>', 'Edit')).toBe(
      'Edit: bad input',
    );
  });

  it.each(['claude-code', 'opencode', 'codex'])(
    'populates completed error calls for %s normalized fixtures',
    (provider) => {
      const tracker = new ToolCallTracker();
      const started = makeAssistantEvent([
        {
          type: 'tool_use',
          id: `${provider}-1`,
          name: 'Bash',
          input: { command: 'false', _sidekickProvider: provider },
        },
      ]);
      const result: SessionEvent = {
        type: 'user',
        timestamp: '2026-03-23T10:00:01Z',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: `${provider}-1`,
              content: 'process exited with exit code 1',
              is_error: true,
            },
          ],
        },
      };

      expect(tracker.process(started)).toEqual([]);
      expect(tracker.process(result)).toEqual([
        expect.objectContaining({
          name: 'Bash',
          isError: true,
          errorCategory: 'exit_code',
        }),
      ]);
    },
  );
});
