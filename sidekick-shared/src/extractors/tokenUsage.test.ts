import { describe, it, expect } from 'vitest';
import { extractTokenUsage } from './tokenUsage';
import type { SessionEvent } from '../types/sessionEvent';

function makeEvent(overrides: Partial<SessionEvent> = {}): SessionEvent {
  return {
    type: 'assistant',
    timestamp: '2026-03-23T10:00:00Z',
    message: { role: 'assistant' },
    ...overrides,
  };
}

describe('extractTokenUsage', () => {
  it('extracts full usage from an assistant event', () => {
    const event = makeEvent({
      message: {
        role: 'assistant',
        model: 'claude-opus-4-20250514',
        usage: {
          input_tokens: 5000,
          output_tokens: 200,
          cache_creation_input_tokens: 100,
          cache_read_input_tokens: 3000,
          reported_cost: 0.05,
          reasoning_tokens: 50,
        },
      },
    });

    const usage = extractTokenUsage(event);
    expect(usage).not.toBeNull();
    expect(usage!.inputTokens).toBe(5000);
    expect(usage!.outputTokens).toBe(200);
    expect(usage!.cacheWriteTokens).toBe(100);
    expect(usage!.cacheReadTokens).toBe(3000);
    expect(usage!.model).toBe('claude-opus-4-20250514');
    expect(usage!.reportedCost).toBe(0.05);
    expect(usage!.reasoningTokens).toBe(50);
    expect(usage!.timestamp).toBeInstanceOf(Date);
  });

  it('returns null for events without usage', () => {
    const event = makeEvent({
      type: 'user',
      message: { role: 'user', content: 'hello' },
    });
    expect(extractTokenUsage(event)).toBeNull();
  });

  it('defaults optional cache fields to 0', () => {
    const event = makeEvent({
      message: {
        role: 'assistant',
        usage: { input_tokens: 100, output_tokens: 50 },
      },
    });

    const usage = extractTokenUsage(event)!;
    expect(usage.cacheWriteTokens).toBe(0);
    expect(usage.cacheReadTokens).toBe(0);
  });

  it('uses "unknown" when model is missing', () => {
    const event = makeEvent({
      message: {
        role: 'assistant',
        usage: { input_tokens: 100, output_tokens: 50 },
      },
    });
    expect(extractTokenUsage(event)!.model).toBe('unknown');
  });
});
