import { describe, it, expect } from 'vitest';
import { extractToolCalls } from './toolCall';
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
    const event = makeAssistantEvent([
      { type: 'tool_use', id: 'tu_1', input: { x: 1 } },
    ]);
    expect(extractToolCalls(event)).toEqual([]);
  });

  it('defaults input to empty object when missing', () => {
    const event = makeAssistantEvent([
      { type: 'tool_use', id: 'tu_1', name: 'Glob' },
    ]);
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
