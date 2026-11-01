import { describe, expect, it } from 'vitest';
import { splitToolInput, visibleToolInput } from './toolInputOrigin';

describe('splitToolInput', () => {
  it('lifts the origin keys and drops every _sidekick key', () => {
    const input = {
      command: 'ls',
      _sidekickRawToolName: 'mcp__github__search',
      _sidekickMcpServerName: 'github',
      _sidekickFuture: true,
    };
    expect(splitToolInput(input)).toEqual({
      input: { command: 'ls' },
      rawToolName: 'mcp__github__search',
      mcpServerName: 'github',
    });
    // The event's own input is left alone.
    expect(input._sidekickRawToolName).toBe('mcp__github__search');
  });

  it('returns the same object when there is nothing to strip', () => {
    const input = { file_path: '/a' };
    expect(splitToolInput(input).input).toBe(input);
  });

  it('treats non-object input as empty', () => {
    expect(visibleToolInput(undefined)).toEqual({});
    expect(visibleToolInput(['x'])).toEqual({});
  });
});
