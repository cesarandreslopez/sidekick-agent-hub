import { describe, it, expect } from 'vitest';
import {
  messageUsageSchema,
  sessionMessageSchema,
  sessionEventSchema,
  permissionModeSchema,
} from './sessionEvent';

describe('messageUsageSchema', () => {
  it('validates a complete usage object', () => {
    const result = messageUsageSchema.safeParse({
      input_tokens: 1000,
      output_tokens: 500,
      cache_creation_input_tokens: 200,
      cache_read_input_tokens: 300,
      reported_cost: 0.01,
      reasoning_tokens: 50,
    });
    expect(result.success).toBe(true);
  });

  it('validates minimal usage (required fields only)', () => {
    const result = messageUsageSchema.safeParse({
      input_tokens: 100,
      output_tokens: 50,
    });
    expect(result.success).toBe(true);
  });

  it('rejects missing required fields', () => {
    const result = messageUsageSchema.safeParse({ input_tokens: 100 });
    expect(result.success).toBe(false);
  });

  it('rejects non-numeric tokens', () => {
    const result = messageUsageSchema.safeParse({
      input_tokens: 'foo',
      output_tokens: 50,
    });
    expect(result.success).toBe(false);
  });
});

describe('sessionMessageSchema', () => {
  it('validates assistant message with usage', () => {
    const result = sessionMessageSchema.safeParse({
      role: 'assistant',
      id: 'msg_123',
      model: 'claude-opus-4-20250514',
      usage: { input_tokens: 1000, output_tokens: 500 },
      content: [{ type: 'text', text: 'Hello' }],
    });
    expect(result.success).toBe(true);
  });

  it('validates minimal user message', () => {
    const result = sessionMessageSchema.safeParse({ role: 'user' });
    expect(result.success).toBe(true);
  });

  it('rejects missing role', () => {
    const result = sessionMessageSchema.safeParse({});
    expect(result.success).toBe(false);
  });
});

describe('permissionModeSchema', () => {
  it.each(['default', 'acceptEdits', 'bypassPermissions', 'plan'] as const)(
    'accepts "%s"',
    (mode) => {
      expect(permissionModeSchema.safeParse(mode).success).toBe(true);
    }
  );

  it('rejects unknown mode', () => {
    expect(permissionModeSchema.safeParse('admin').success).toBe(false);
  });
});

describe('sessionEventSchema', () => {
  it('validates a full assistant event', () => {
    const result = sessionEventSchema.safeParse({
      type: 'assistant',
      message: {
        role: 'assistant',
        model: 'claude-sonnet-4-20250514',
        usage: { input_tokens: 5000, output_tokens: 200 },
        content: [
          { type: 'text', text: 'Let me help you.' },
          { type: 'tool_use', id: 'tu_1', name: 'Read', input: { file_path: '/foo.ts' } },
        ],
      },
      timestamp: '2026-03-23T10:00:00Z',
      permissionMode: 'default',
    });
    expect(result.success).toBe(true);
  });

  it('validates a tool_result event', () => {
    const result = sessionEventSchema.safeParse({
      type: 'tool_result',
      message: { role: 'user' },
      timestamp: '2026-03-23T10:00:01Z',
      result: {
        tool_use_id: 'tu_1',
        output: 'file contents here',
        is_error: false,
      },
    });
    expect(result.success).toBe(true);
  });

  it('validates a user event with isSidechain', () => {
    const result = sessionEventSchema.safeParse({
      type: 'user',
      message: { role: 'user', content: 'Fix this bug' },
      timestamp: '2026-03-23T10:00:00Z',
      isSidechain: true,
    });
    expect(result.success).toBe(true);
  });

  it('rejects invalid event type', () => {
    const result = sessionEventSchema.safeParse({
      type: 'unknown',
      message: { role: 'user' },
      timestamp: '2026-03-23T10:00:00Z',
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing timestamp', () => {
    const result = sessionEventSchema.safeParse({
      type: 'user',
      message: { role: 'user' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing message', () => {
    const result = sessionEventSchema.safeParse({
      type: 'user',
      timestamp: '2026-03-23T10:00:00Z',
    });
    expect(result.success).toBe(false);
  });
});
