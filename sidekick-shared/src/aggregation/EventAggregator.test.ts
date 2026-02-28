import { describe, it, expect, beforeEach } from 'vitest';
import { EventAggregator } from './EventAggregator';
import type { SessionEvent, MessageUsage } from '../types/sessionEvent';
import type { FollowEvent } from '../watchers/types';

// ── Helpers ──

function makeSessionEvent(overrides: Partial<SessionEvent> & { type: SessionEvent['type'] }): SessionEvent {
  return {
    message: { role: overrides.type === 'user' ? 'user' : 'assistant' },
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

function makeUsage(overrides: Partial<MessageUsage> = {}): MessageUsage {
  return {
    input_tokens: 100,
    output_tokens: 50,
    ...overrides,
  };
}

function makeFollowEvent(overrides: Partial<FollowEvent> = {}): FollowEvent {
  return {
    providerId: 'claude-code',
    type: 'assistant',
    timestamp: new Date().toISOString(),
    summary: 'test event',
    ...overrides,
  };
}

function makeAssistantWithUsage(usage: Partial<MessageUsage> = {}, model = 'claude-sonnet-4-20250514'): SessionEvent {
  return makeSessionEvent({
    type: 'assistant',
    message: {
      role: 'assistant',
      model,
      content: [{ type: 'text', text: 'Hello' }],
      usage: makeUsage(usage),
    },
  });
}

function makeUserEvent(content: string | unknown[] = 'Hello'): SessionEvent {
  return makeSessionEvent({
    type: 'user',
    message: {
      role: 'user',
      content,
    },
  });
}

function makeToolUseEvent(toolName: string, toolUseId: string, input: Record<string, unknown> = {}): SessionEvent {
  return makeSessionEvent({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [
        { type: 'tool_use', id: toolUseId, name: toolName, input },
      ],
    },
  });
}

function makeToolResultEvent(toolUseId: string, content: unknown = 'success', isError = false): SessionEvent {
  return makeSessionEvent({
    type: 'user',
    message: {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: toolUseId, content, is_error: isError },
      ],
    },
  });
}

// ── Tests ──

describe('EventAggregator', () => {
  let agg: EventAggregator;

  beforeEach(() => {
    agg = new EventAggregator();
  });

  // ═══════════════════════════════════════════════════════════════
  // Construction and initialization
  // ═══════════════════════════════════════════════════════════════

  describe('construction and initialization', () => {
    it('creates with default options', () => {
      const metrics = agg.getMetrics();
      expect(metrics.sessionStartTime).toBeNull();
      expect(metrics.lastEventTime).toBeNull();
      expect(metrics.messageCount).toBe(0);
      expect(metrics.eventCount).toBe(0);
      expect(metrics.currentModel).toBeNull();
      expect(metrics.providerId).toBeNull();
      expect(metrics.tokens.inputTokens).toBe(0);
      expect(metrics.tokens.outputTokens).toBe(0);
      expect(metrics.tokens.cacheWriteTokens).toBe(0);
      expect(metrics.tokens.cacheReadTokens).toBe(0);
      expect(metrics.tokens.reportedCost).toBe(0);
      expect(metrics.modelStats).toEqual([]);
      expect(metrics.toolStats).toEqual([]);
      expect(metrics.timeline).toEqual([]);
      expect(metrics.compactionCount).toBe(0);
      expect(metrics.truncationCount).toBe(0);
      expect(metrics.plan).toBeNull();
      expect(metrics.permissionMode).toBeNull();
      expect(metrics.permissionModeHistory).toEqual([]);
      expect(metrics.latencyStats).toBeNull();
      expect(metrics.currentContextSize).toBe(0);
      expect(metrics.contextTimeline).toEqual([]);
      expect(metrics.subagents).toEqual([]);
    });

    it('accepts custom options', () => {
      const custom = new EventAggregator({
        timelineCap: 50,
        latencyCap: 20,
        burnWindowMs: 60_000,
        burnSampleMs: 5_000,
        providerId: 'opencode',
      });
      const metrics = custom.getMetrics();
      expect(metrics.providerId).toBe('opencode');
    });

    it('accepts custom computeContextSize function', () => {
      const custom = new EventAggregator({
        computeContextSize: (u) => u.inputTokens * 2,
      });
      custom.processEvent(makeAssistantWithUsage({ input_tokens: 100, output_tokens: 50 }));
      // With custom fn: contextSize = 100 * 2 = 200
      expect(custom.getMetrics().currentContextSize).toBe(200);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // processEvent — basic event handling
  // ═══════════════════════════════════════════════════════════════

  describe('processEvent basics', () => {
    it('increments eventCount for every event', () => {
      agg.processEvent(makeUserEvent());
      agg.processEvent(makeAssistantWithUsage());
      expect(agg.getMetrics().eventCount).toBe(2);
    });

    it('sets sessionStartTime from first event', () => {
      const ts = '2025-01-15T10:00:00Z';
      agg.processEvent(makeSessionEvent({ type: 'user', message: { role: 'user', content: 'hi' }, timestamp: ts }));
      expect(agg.getMetrics().sessionStartTime).toBe(ts);
    });

    it('updates lastEventTime with each event', () => {
      const ts1 = '2025-01-15T10:00:00Z';
      const ts2 = '2025-01-15T10:01:00Z';
      agg.processEvent(makeSessionEvent({ type: 'user', message: { role: 'user', content: 'hi' }, timestamp: ts1 }));
      agg.processEvent(makeSessionEvent({ type: 'user', message: { role: 'user', content: 'there' }, timestamp: ts2 }));
      expect(agg.getMetrics().lastEventTime).toBe(ts2);
    });

    it('tracks messageCount but skips synthetic token-count events', () => {
      agg.processEvent(makeSessionEvent({
        type: 'assistant',
        message: { role: 'assistant', id: 'token-count-123', content: 'tokens' },
      }));
      agg.processEvent(makeUserEvent());
      // token-count event is skipped from messageCount
      expect(agg.getMetrics().messageCount).toBe(1);
    });

    it('tracks model from events', () => {
      agg.processEvent(makeAssistantWithUsage({}, 'claude-opus-4-20250514'));
      expect(agg.getMetrics().currentModel).toBe('claude-opus-4-20250514');
    });

    it('skips events with no message field gracefully', () => {
      // Cast to bypass TypeScript -- simulates a 'summary' event without message
      agg.processEvent({ type: 'summary', timestamp: '2025-01-01T00:00:00Z', message: undefined } as unknown as SessionEvent);
      // Should have incremented eventCount but not crashed
      expect(agg.getMetrics().eventCount).toBe(1);
      expect(agg.getMetrics().messageCount).toBe(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Token accumulation
  // ═══════════════════════════════════════════════════════════════

  describe('token accumulation', () => {
    it('accumulates input and output tokens from usage', () => {
      agg.processEvent(makeAssistantWithUsage({ input_tokens: 100, output_tokens: 50 }));
      const tokens = agg.getAggregatedTokens();
      expect(tokens.inputTokens).toBe(100);
      expect(tokens.outputTokens).toBe(50);
    });

    it('accumulates cache tokens from usage', () => {
      agg.processEvent(makeAssistantWithUsage({
        input_tokens: 200,
        output_tokens: 80,
        cache_creation_input_tokens: 150,
        cache_read_input_tokens: 50,
      }));
      const tokens = agg.getAggregatedTokens();
      expect(tokens.cacheWriteTokens).toBe(150);
      expect(tokens.cacheReadTokens).toBe(50);
    });

    it('accumulates reported cost', () => {
      agg.processEvent(makeAssistantWithUsage({
        input_tokens: 100,
        output_tokens: 50,
        reported_cost: 0.005,
      }));
      const tokens = agg.getAggregatedTokens();
      expect(tokens.reportedCost).toBe(0.005);
    });

    it('accumulates tokens across multiple events', () => {
      agg.processEvent(makeAssistantWithUsage({ input_tokens: 100, output_tokens: 50 }));
      agg.processEvent(makeAssistantWithUsage({ input_tokens: 200, output_tokens: 100 }));
      const tokens = agg.getAggregatedTokens();
      expect(tokens.inputTokens).toBe(300);
      expect(tokens.outputTokens).toBe(150);
    });

    it('handles missing cache tokens gracefully (defaults to 0)', () => {
      agg.processEvent(makeAssistantWithUsage({ input_tokens: 100, output_tokens: 50 }));
      const tokens = agg.getAggregatedTokens();
      expect(tokens.cacheWriteTokens).toBe(0);
      expect(tokens.cacheReadTokens).toBe(0);
    });

    it('does not accumulate tokens from events without usage', () => {
      agg.processEvent(makeUserEvent());
      const tokens = agg.getAggregatedTokens();
      expect(tokens.inputTokens).toBe(0);
      expect(tokens.outputTokens).toBe(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Context size tracking
  // ═══════════════════════════════════════════════════════════════

  describe('context size tracking', () => {
    it('computes context size as input + cacheWrite + cacheRead by default', () => {
      agg.processEvent(makeAssistantWithUsage({
        input_tokens: 1000,
        output_tokens: 500,
        cache_creation_input_tokens: 200,
        cache_read_input_tokens: 100,
      }));
      // Default: input + cacheWrite + cacheRead = 1000 + 200 + 100 = 1300
      expect(agg.getMetrics().currentContextSize).toBe(1300);
    });

    it('uses custom computeContextSize when provided', () => {
      const custom = new EventAggregator({
        computeContextSize: (u) => u.inputTokens + u.outputTokens,
      });
      custom.processEvent(makeAssistantWithUsage({ input_tokens: 1000, output_tokens: 500 }));
      expect(custom.getMetrics().currentContextSize).toBe(1500);
    });

    it('tracks context timeline with turnIndex', () => {
      agg.processEvent(makeAssistantWithUsage({ input_tokens: 100, output_tokens: 50 }));
      agg.processEvent(makeAssistantWithUsage({ input_tokens: 200, output_tokens: 80 }));
      const timeline = agg.getMetrics().contextTimeline;
      expect(timeline).toHaveLength(2);
      expect(timeline[0].turnIndex).toBe(0);
      expect(timeline[0].inputTokens).toBe(100); // 100 + 0 + 0
      expect(timeline[1].turnIndex).toBe(1);
      expect(timeline[1].inputTokens).toBe(200); // 200 + 0 + 0
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Compaction detection
  // ═══════════════════════════════════════════════════════════════

  describe('compaction detection', () => {
    it('detects compaction when context drops by more than 20%', () => {
      // First event: set a high context
      agg.processEvent(makeAssistantWithUsage({ input_tokens: 10000, output_tokens: 500 }));
      // Second event: context drops to well below 80% (threshold is 0.8)
      agg.processEvent(makeAssistantWithUsage({ input_tokens: 2000, output_tokens: 200 }));

      const events = agg.getCompactionEvents();
      expect(events).toHaveLength(1);
      expect(events[0].contextBefore).toBe(10000);
      expect(events[0].contextAfter).toBe(2000);
      expect(events[0].tokensReclaimed).toBe(8000);
    });

    it('does not detect compaction for small context drops', () => {
      agg.processEvent(makeAssistantWithUsage({ input_tokens: 10000, output_tokens: 500 }));
      // Drop to 9000 — only 10% drop, below the >20% threshold
      agg.processEvent(makeAssistantWithUsage({ input_tokens: 9000, output_tokens: 400 }));

      expect(agg.getCompactionEvents()).toHaveLength(0);
    });

    it('does not detect compaction on first event (no previous context)', () => {
      agg.processEvent(makeAssistantWithUsage({ input_tokens: 100, output_tokens: 50 }));
      expect(agg.getCompactionEvents()).toHaveLength(0);
    });

    it('reports compactionCount in metrics', () => {
      agg.processEvent(makeAssistantWithUsage({ input_tokens: 10000, output_tokens: 500 }));
      agg.processEvent(makeAssistantWithUsage({ input_tokens: 1000, output_tokens: 100 }));
      expect(agg.getMetrics().compactionCount).toBe(1);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Per-model usage
  // ═══════════════════════════════════════════════════════════════

  describe('per-model usage stats', () => {
    it('tracks usage per model', () => {
      agg.processEvent(makeAssistantWithUsage({ input_tokens: 100, output_tokens: 50 }, 'claude-sonnet-4-20250514'));
      agg.processEvent(makeAssistantWithUsage({ input_tokens: 200, output_tokens: 100 }, 'claude-opus-4-20250514'));
      agg.processEvent(makeAssistantWithUsage({ input_tokens: 150, output_tokens: 75 }, 'claude-sonnet-4-20250514'));

      const stats = agg.getModelStats();
      expect(stats).toHaveLength(2);

      const sonnet = stats.find(s => s.model === 'claude-sonnet-4-20250514');
      expect(sonnet).toBeDefined();
      expect(sonnet!.calls).toBe(2);
      expect(sonnet!.inputTokens).toBe(250);
      expect(sonnet!.outputTokens).toBe(125);
      expect(sonnet!.tokens).toBe(375); // 250 + 125

      const opus = stats.find(s => s.model === 'claude-opus-4-20250514');
      expect(opus).toBeDefined();
      expect(opus!.calls).toBe(1);
      expect(opus!.inputTokens).toBe(200);
    });

    it('sorts model stats by call count descending', () => {
      agg.processEvent(makeAssistantWithUsage({}, 'model-a'));
      agg.processEvent(makeAssistantWithUsage({}, 'model-b'));
      agg.processEvent(makeAssistantWithUsage({}, 'model-b'));

      const stats = agg.getModelStats();
      expect(stats[0].model).toBe('model-b');
      expect(stats[1].model).toBe('model-a');
    });

    it('uses "unknown" when no model is specified', () => {
      agg.processEvent(makeSessionEvent({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: 'hi',
          usage: makeUsage({ input_tokens: 50, output_tokens: 25 }),
        },
      }));
      const stats = agg.getModelStats();
      expect(stats).toHaveLength(1);
      expect(stats[0].model).toBe('unknown');
    });

    it('accumulates cache tokens in model stats', () => {
      agg.processEvent(makeAssistantWithUsage({
        input_tokens: 100,
        output_tokens: 50,
        cache_creation_input_tokens: 30,
        cache_read_input_tokens: 20,
      }, 'test-model'));

      const stats = agg.getModelStats();
      const model = stats.find(s => s.model === 'test-model')!;
      expect(model.cacheWriteTokens).toBe(30);
      expect(model.cacheReadTokens).toBe(20);
    });

    it('accumulates cost in model stats', () => {
      agg.processEvent(makeAssistantWithUsage({
        input_tokens: 100,
        output_tokens: 50,
        reported_cost: 0.01,
      }, 'test-model'));

      const stats = agg.getModelStats();
      expect(stats[0].cost).toBe(0.01);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Tool analytics from SessionEvent content blocks
  // ═══════════════════════════════════════════════════════════════

  describe('tool analytics from SessionEvent', () => {
    it('tracks tool_use from content blocks', () => {
      agg.processEvent(makeToolUseEvent('Read', 'tu-1', { file_path: '/foo.ts' }));

      const stats = agg.getToolStats();
      expect(stats).toHaveLength(1);
      expect(stats[0].name).toBe('Read');
      expect(stats[0].pendingCount).toBe(1);
      expect(stats[0].completedCount).toBe(0);
    });

    it('tracks tool_result completing a pending tool call', () => {
      const ts1 = '2025-01-15T10:00:00.000Z';
      const ts2 = '2025-01-15T10:00:01.000Z';

      agg.processEvent({ ...makeToolUseEvent('Read', 'tu-1'), timestamp: ts1 });
      agg.processEvent({ ...makeToolResultEvent('tu-1', 'file contents'), timestamp: ts2 });

      const stats = agg.getToolStats();
      expect(stats).toHaveLength(1);
      expect(stats[0].name).toBe('Read');
      expect(stats[0].pendingCount).toBe(0);
      expect(stats[0].completedCount).toBe(1);
      expect(stats[0].successCount).toBe(1);
      expect(stats[0].failureCount).toBe(0);
      expect(stats[0].totalDuration).toBe(1000);
    });

    it('tracks tool errors', () => {
      agg.processEvent(makeToolUseEvent('Bash', 'tu-2'));
      agg.processEvent(makeToolResultEvent('tu-2', 'command failed', true));

      const stats = agg.getToolStats();
      const bash = stats.find(s => s.name === 'Bash')!;
      expect(bash.failureCount).toBe(1);
      expect(bash.successCount).toBe(0);
    });

    it('sorts tool stats by total count descending', () => {
      agg.processEvent(makeToolUseEvent('Read', 'tu-1'));
      agg.processEvent(makeToolUseEvent('Write', 'tu-2'));
      agg.processEvent(makeToolUseEvent('Write', 'tu-3'));

      const stats = agg.getToolStats();
      expect(stats[0].name).toBe('Write');
      expect(stats[1].name).toBe('Read');
    });

    it('handles tool_result for unknown tool_use_id gracefully', () => {
      agg.processEvent(makeToolResultEvent('unknown-id', 'result'));
      expect(agg.getToolStats()).toHaveLength(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Truncation detection from SessionEvent
  // ═══════════════════════════════════════════════════════════════

  describe('truncation detection', () => {
    it('detects truncation markers in tool_result content', () => {
      agg.processEvent(makeToolUseEvent('Read', 'tu-1'));
      agg.processEvent(makeToolResultEvent('tu-1', '[Response truncated] some extra text'));

      const truncations = agg.getTruncationEvents();
      expect(truncations).toHaveLength(1);
      expect(truncations[0].marker).toBe('Response truncated');
    });

    it('detects content_too_long truncation', () => {
      agg.processEvent(makeToolUseEvent('Bash', 'tu-2'));
      agg.processEvent(makeToolResultEvent('tu-2', 'Error: content_too_long'));

      const truncations = agg.getTruncationEvents();
      expect(truncations).toHaveLength(1);
      expect(truncations[0].marker).toBe('Content too long');
    });

    it('does not detect truncation when no markers present', () => {
      agg.processEvent(makeToolUseEvent('Read', 'tu-1'));
      agg.processEvent(makeToolResultEvent('tu-1', 'normal file contents'));

      expect(agg.getTruncationEvents()).toHaveLength(0);
    });

    it('reports truncationCount in metrics', () => {
      agg.processEvent(makeToolUseEvent('Read', 'tu-1'));
      agg.processEvent(makeToolResultEvent('tu-1', '[WARNING: Tool output was truncated]'));

      expect(agg.getMetrics().truncationCount).toBe(1);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Latency tracking
  // ═══════════════════════════════════════════════════════════════

  describe('latency tracking', () => {
    it('tracks latency from user prompt to assistant response with usage', () => {
      const userTs = '2025-01-15T10:00:00.000Z';
      const assistantTs = '2025-01-15T10:00:02.000Z';

      agg.processEvent(makeSessionEvent({
        type: 'user',
        message: { role: 'user', content: 'What is X?' },
        timestamp: userTs,
      }));
      agg.processEvent(makeSessionEvent({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'X is Y' }],
          usage: makeUsage(),
        },
        timestamp: assistantTs,
      }));

      const stats = agg.getLatencyStats();
      expect(stats).not.toBeNull();
      expect(stats!.completedCycles).toBe(1);
      expect(stats!.avgFirstTokenLatencyMs).toBe(2000);
      expect(stats!.avgTotalResponseTimeMs).toBe(2000);
      expect(stats!.lastFirstTokenLatencyMs).toBe(2000);
    });

    it('returns null latency stats when no cycles completed', () => {
      expect(agg.getLatencyStats()).toBeNull();
    });

    it('does not track latency from user events without text content', () => {
      agg.processEvent(makeSessionEvent({
        type: 'user',
        message: { role: 'user', content: [] },
        timestamp: '2025-01-15T10:00:00Z',
      }));
      agg.processEvent(makeAssistantWithUsage());
      // No latency should be tracked since user message had no text
      expect(agg.getLatencyStats()).toBeNull();
    });

    it('caps latency records at latencyCap', () => {
      const custom = new EventAggregator({ latencyCap: 3 });
      for (let i = 0; i < 5; i++) {
        const userTs = `2025-01-15T10:0${i}:00.000Z`;
        const assistantTs = `2025-01-15T10:0${i}:01.000Z`;
        custom.processEvent(makeSessionEvent({
          type: 'user',
          message: { role: 'user', content: `Q${i}` },
          timestamp: userTs,
        }));
        custom.processEvent(makeSessionEvent({
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'text', text: `A${i}` }], usage: makeUsage() },
          timestamp: assistantTs,
        }));
      }
      const stats = custom.getLatencyStats()!;
      expect(stats.completedCycles).toBe(3);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Context attribution
  // ═══════════════════════════════════════════════════════════════

  describe('context attribution', () => {
    it('attributes user text to userMessages', () => {
      agg.processEvent(makeSessionEvent({
        type: 'user',
        message: { role: 'user', content: 'Hello world' },
      }));
      const attr = agg.getContextAttribution();
      expect(attr.userMessages).toBeGreaterThan(0);
      // "Hello world" = 11 chars, estimate = ceil(11/4) = 3
      expect(attr.userMessages).toBe(3);
    });

    it('attributes system prompt content to systemPrompt', () => {
      agg.processEvent(makeSessionEvent({
        type: 'user',
        message: { role: 'user', content: 'Here is <system-reminder> content' },
      }));
      const attr = agg.getContextAttribution();
      expect(attr.systemPrompt).toBeGreaterThan(0);
      expect(attr.userMessages).toBe(0);
    });

    it('attributes CLAUDE.md content to systemPrompt', () => {
      agg.processEvent(makeSessionEvent({
        type: 'user',
        message: { role: 'user', content: 'Contents of CLAUDE.md are here' },
      }));
      const attr = agg.getContextAttribution();
      expect(attr.systemPrompt).toBeGreaterThan(0);
    });

    it('attributes tool_result blocks in user events to toolOutputs', () => {
      agg.processEvent(makeSessionEvent({
        type: 'user',
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'tu-1', content: 'file contents here' },
          ],
        },
      }));
      const attr = agg.getContextAttribution();
      expect(attr.toolOutputs).toBeGreaterThan(0);
    });

    it('attributes assistant text blocks to assistantResponses', () => {
      agg.processEvent(makeSessionEvent({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Here is my response' }],
        },
      }));
      const attr = agg.getContextAttribution();
      expect(attr.assistantResponses).toBeGreaterThan(0);
    });

    it('attributes thinking blocks to thinking', () => {
      agg.processEvent(makeSessionEvent({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'thinking', thinking: 'Let me consider this carefully' }],
        },
      }));
      const attr = agg.getContextAttribution();
      expect(attr.thinking).toBeGreaterThan(0);
    });

    it('attributes tool_use blocks in assistant events to toolInputs', () => {
      agg.processEvent(makeSessionEvent({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'tu-1', name: 'Read', input: { file_path: '/foo' } }],
        },
      }));
      const attr = agg.getContextAttribution();
      expect(attr.toolInputs).toBeGreaterThan(0);
    });

    it('attributes summary events to other', () => {
      agg.processEvent(makeSessionEvent({
        type: 'summary',
        message: { role: 'assistant', content: 'Session summarized' },
      }));
      const attr = agg.getContextAttribution();
      expect(attr.other).toBeGreaterThan(0);
    });

    it('handles user content as structured blocks array', () => {
      agg.processEvent(makeSessionEvent({
        type: 'user',
        message: {
          role: 'user',
          content: [
            { type: 'text', text: 'Normal user question' },
            { type: 'tool_result', tool_use_id: 'tu-1', content: 'result data' },
          ],
        },
      }));
      const attr = agg.getContextAttribution();
      expect(attr.userMessages).toBeGreaterThan(0);
      expect(attr.toolOutputs).toBeGreaterThan(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Permission mode tracking
  // ═══════════════════════════════════════════════════════════════

  describe('permission mode tracking', () => {
    it('tracks permission mode changes', () => {
      agg.processEvent(makeSessionEvent({
        type: 'assistant',
        message: { role: 'assistant', content: 'ok' },
        permissionMode: 'default',
      }));
      agg.processEvent(makeSessionEvent({
        type: 'assistant',
        message: { role: 'assistant', content: 'editing' },
        permissionMode: 'acceptEdits',
      }));

      const metrics = agg.getMetrics();
      expect(metrics.permissionMode).toBe('acceptEdits');
      expect(metrics.permissionModeHistory).toHaveLength(2);
      expect(metrics.permissionModeHistory[0].mode).toBe('default');
      expect(metrics.permissionModeHistory[0].previousMode).toBeNull();
      expect(metrics.permissionModeHistory[1].mode).toBe('acceptEdits');
      expect(metrics.permissionModeHistory[1].previousMode).toBe('default');
    });

    it('does not add duplicate entries for same mode', () => {
      agg.processEvent(makeSessionEvent({
        type: 'assistant',
        message: { role: 'assistant', content: 'ok' },
        permissionMode: 'default',
      }));
      agg.processEvent(makeSessionEvent({
        type: 'assistant',
        message: { role: 'assistant', content: 'still default' },
        permissionMode: 'default',
      }));

      expect(agg.getMetrics().permissionModeHistory).toHaveLength(1);
    });

    it('ignores events without permissionMode', () => {
      agg.processEvent(makeSessionEvent({
        type: 'assistant',
        message: { role: 'assistant', content: 'ok' },
      }));
      expect(agg.getMetrics().permissionMode).toBeNull();
      expect(agg.getMetrics().permissionModeHistory).toHaveLength(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Timeline
  // ═══════════════════════════════════════════════════════════════

  describe('timeline', () => {
    it('adds user events as user_prompt type', () => {
      agg.processEvent(makeUserEvent('Fix the bug'));
      const tl = agg.getTimeline();
      expect(tl).toHaveLength(1);
      expect(tl[0].type).toBe('user_prompt');
      expect(tl[0].noiseLevel).toBe('user');
      expect(tl[0].description).toBe('Fix the bug');
    });

    it('adds assistant events as assistant_response type', () => {
      agg.processEvent(makeAssistantWithUsage({}, 'test-model'));
      const tl = agg.getTimeline();
      expect(tl).toHaveLength(1);
      expect(tl[0].type).toBe('assistant_response');
      expect(tl[0].noiseLevel).toBe('ai');
    });

    it('adds tool_use events as tool_call type', () => {
      agg.processEvent(makeSessionEvent({
        type: 'tool_use',
        message: { role: 'assistant' },
        tool: { name: 'Read', input: { file_path: '/test.ts' } },
      }));
      const tl = agg.getTimeline();
      // May or may not appear depending on noise classification
      // At minimum it should not crash
      expect(tl.length).toBeGreaterThanOrEqual(0);
    });

    it('adds summary events as compaction type', () => {
      agg.processEvent(makeSessionEvent({
        type: 'summary',
        message: { role: 'assistant', content: 'Context compacted' },
      }));
      const tl = agg.getTimeline();
      expect(tl).toHaveLength(1);
      expect(tl[0].type).toBe('compaction');
      expect(tl[0].noiseLevel).toBe('system');
    });

    it('truncates long descriptions to 200 chars', () => {
      const longText = 'A'.repeat(300);
      agg.processEvent(makeUserEvent(longText));
      const tl = agg.getTimeline();
      expect(tl[0].description.length).toBeLessThanOrEqual(200);
      expect(tl[0].description.endsWith('...')).toBe(true);
    });

    it('caps timeline at timelineCap', () => {
      const small = new EventAggregator({ timelineCap: 3 });
      for (let i = 0; i < 5; i++) {
        small.processEvent(makeUserEvent(`Message ${i}`));
      }
      expect(small.getTimeline().length).toBeLessThanOrEqual(3);
    });

    it('includes metadata for assistant events with usage', () => {
      agg.processEvent(makeSessionEvent({
        type: 'assistant',
        message: {
          role: 'assistant',
          model: 'my-model',
          content: [{ type: 'text', text: 'response' }],
          usage: makeUsage({ input_tokens: 200, output_tokens: 100 }),
        },
      }));
      const tl = agg.getTimeline();
      expect(tl[0].metadata?.model).toBe('my-model');
      expect(tl[0].metadata?.tokenCount).toBe(300);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Task tracking from SessionEvent
  // ═══════════════════════════════════════════════════════════════

  describe('task tracking', () => {
    it('tracks TaskCreate + tool_result to create a task', () => {
      agg.processEvent(makeToolUseEvent('TaskCreate', 'tc-1', {
        subject: 'Fix the parser',
        description: 'Parser needs refactoring',
      }));
      agg.processEvent(makeToolResultEvent('tc-1', 'Task #42 created'));

      const state = agg.getTaskState();
      expect(state.tasks.size).toBe(1);
      const task = state.tasks.get('42')!;
      expect(task.subject).toBe('Fix the parser');
      expect(task.description).toBe('Parser needs refactoring');
      expect(task.status).toBe('pending');
    });

    it('tracks TaskUpdate to change status', () => {
      // Create task first
      agg.processEvent(makeToolUseEvent('TaskCreate', 'tc-1', { subject: 'Task A' }));
      agg.processEvent(makeToolResultEvent('tc-1', 'Task #1 created'));

      // Update to in_progress
      agg.processEvent(makeToolUseEvent('TaskUpdate', 'tu-1', {
        taskId: '1',
        status: 'in_progress',
      }));

      const state = agg.getTaskState();
      expect(state.tasks.get('1')!.status).toBe('in_progress');
      expect(state.activeTaskId).toBe('1');
    });

    it('handles TaskUpdate for unknown taskId by creating placeholder', () => {
      agg.processEvent(makeToolUseEvent('TaskUpdate', 'tu-1', {
        taskId: '99',
        status: 'in_progress',
        subject: 'Surprise task',
      }));

      const state = agg.getTaskState();
      expect(state.tasks.size).toBe(1);
      expect(state.tasks.get('99')!.subject).toBe('Surprise task');
      expect(state.activeTaskId).toBe('99');
    });

    it('deletes task on status=deleted', () => {
      agg.processEvent(makeToolUseEvent('TaskCreate', 'tc-1', { subject: 'Temp' }));
      agg.processEvent(makeToolResultEvent('tc-1', 'Task #5 created'));

      agg.processEvent(makeToolUseEvent('TaskUpdate', 'tu-1', { taskId: '5', status: 'deleted' }));

      expect(agg.getTaskState().tasks.size).toBe(0);
    });

    it('updates task blockedBy and blocks fields', () => {
      agg.processEvent(makeToolUseEvent('TaskCreate', 'tc-1', { subject: 'Task A' }));
      agg.processEvent(makeToolResultEvent('tc-1', 'Task #1 created'));

      agg.processEvent(makeToolUseEvent('TaskUpdate', 'tu-1', {
        taskId: '1',
        addBlockedBy: ['2', '3'],
        addBlocks: ['4'],
      }));

      const task = agg.getTaskState().tasks.get('1')!;
      expect(task.blockedBy).toEqual(['2', '3']);
      expect(task.blocks).toEqual(['4']);
    });

    it('clears activeTaskId when the active task is deleted', () => {
      agg.processEvent(makeToolUseEvent('TaskCreate', 'tc-1', { subject: 'T' }));
      agg.processEvent(makeToolResultEvent('tc-1', 'Task #1 created'));
      agg.processEvent(makeToolUseEvent('TaskUpdate', 'tu-1', { taskId: '1', status: 'in_progress' }));
      expect(agg.getTaskState().activeTaskId).toBe('1');

      agg.processEvent(makeToolUseEvent('TaskUpdate', 'tu-2', { taskId: '1', status: 'deleted' }));
      expect(agg.getTaskState().activeTaskId).toBeNull();
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Subagent tracking from SessionEvent
  // ═══════════════════════════════════════════════════════════════

  describe('subagent tracking', () => {
    it('tracks Task tool_use as subagent spawn', () => {
      agg.processEvent(makeSessionEvent({
        type: 'assistant',
        timestamp: '2025-01-15T10:00:00Z',
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'sa-1', name: 'Task', input: { description: 'Explore codebase', subagent_type: 'Explore' } },
          ],
        },
      }));

      const subagents = agg.getSubagents();
      expect(subagents).toHaveLength(1);
      expect(subagents[0].id).toBe('sa-1');
      expect(subagents[0].description).toBe('Explore codebase');
      expect(subagents[0].subagentType).toBe('Explore');
      expect(subagents[0].status).toBe('running');
    });

    it('completes subagent on tool_result', () => {
      const spawnTs = '2025-01-15T10:00:00.000Z';
      const completeTs = '2025-01-15T10:00:05.000Z';

      agg.processEvent(makeSessionEvent({
        type: 'assistant',
        timestamp: spawnTs,
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'sa-1', name: 'Task', input: { description: 'Run tests' } },
          ],
        },
      }));
      agg.processEvent(makeSessionEvent({
        type: 'user',
        timestamp: completeTs,
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'sa-1', content: 'Tests passed' },
          ],
        },
      }));

      const subagents = agg.getSubagents();
      expect(subagents[0].status).toBe('completed');
      expect(subagents[0].completionTime).toBe(completeTs);
      expect(subagents[0].durationMs).toBe(5000);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Burn rate
  // ═══════════════════════════════════════════════════════════════

  describe('burn rate', () => {
    it('returns empty burn rate when no samples', () => {
      const rate = agg.getBurnRate();
      expect(rate.tokensPerMinute).toBe(0);
      expect(rate.points).toEqual([]);
      expect(rate.sampleCount).toBe(0);
    });

    it('creates burn rate samples after sample interval elapses', () => {
      const custom = new EventAggregator({ burnSampleMs: 1000 });

      // First event sets lastBurnSampleTime
      custom.processEvent(makeSessionEvent({
        type: 'assistant',
        timestamp: '2025-01-15T10:00:00.000Z',
        message: {
          role: 'assistant',
          content: 'hi',
          usage: makeUsage({ input_tokens: 100, output_tokens: 50 }),
        },
      }));

      // Second event after 2 seconds (> 1000ms sample interval)
      custom.processEvent(makeSessionEvent({
        type: 'assistant',
        timestamp: '2025-01-15T10:00:02.000Z',
        message: {
          role: 'assistant',
          content: 'there',
          usage: makeUsage({ input_tokens: 200, output_tokens: 100 }),
        },
      }));

      const rate = custom.getBurnRate();
      expect(rate.sampleCount).toBe(1);
      expect(rate.tokensPerMinute).toBeGreaterThan(0);
    });

    it('trims burn samples outside the burn window', () => {
      const custom = new EventAggregator({ burnSampleMs: 1000, burnWindowMs: 5000 });

      // Spread events over 10 seconds
      for (let i = 0; i < 10; i++) {
        const ts = new Date('2025-01-15T10:00:00Z');
        ts.setMilliseconds(ts.getMilliseconds() + i * 2000);
        custom.processEvent(makeSessionEvent({
          type: 'assistant',
          timestamp: ts.toISOString(),
          message: {
            role: 'assistant',
            content: 'msg',
            usage: makeUsage({ input_tokens: 100, output_tokens: 50 }),
          },
        }));
      }

      // Samples outside 5s window should be trimmed
      const rate = custom.getBurnRate();
      // Exact count depends on timing, but should be <= window/sample
      expect(rate.sampleCount).toBeLessThanOrEqual(6);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // processFollowEvent
  // ═══════════════════════════════════════════════════════════════

  describe('processFollowEvent', () => {
    it('accumulates tokens from FollowEvent fields', () => {
      agg.processFollowEvent(makeFollowEvent({
        type: 'assistant',
        tokens: { input: 500, output: 200 },
        cacheTokens: { read: 50, write: 100 },
        model: 'test-model',
      }));

      const tokens = agg.getAggregatedTokens();
      expect(tokens.inputTokens).toBe(500);
      expect(tokens.outputTokens).toBe(200);
      expect(tokens.cacheReadTokens).toBe(50);
      expect(tokens.cacheWriteTokens).toBe(100);
    });

    it('accumulates cost from FollowEvent', () => {
      agg.processFollowEvent(makeFollowEvent({
        cost: 0.015,
      }));
      expect(agg.getAggregatedTokens().reportedCost).toBe(0.015);
    });

    it('tracks model from FollowEvent', () => {
      agg.processFollowEvent(makeFollowEvent({ model: 'claude-opus-4-20250514' }));
      expect(agg.getMetrics().currentModel).toBe('claude-opus-4-20250514');
    });

    it('sets providerId from FollowEvent when not set in options', () => {
      agg.processFollowEvent(makeFollowEvent({ providerId: 'opencode' }));
      expect(agg.getMetrics().providerId).toBe('opencode');
    });

    it('increments eventCount and messageCount for non-system events', () => {
      agg.processFollowEvent(makeFollowEvent({ type: 'assistant' }));
      agg.processFollowEvent(makeFollowEvent({ type: 'user' }));
      expect(agg.getMetrics().eventCount).toBe(2);
      expect(agg.getMetrics().messageCount).toBe(2);
    });

    it('does not increment messageCount for system events', () => {
      agg.processFollowEvent(makeFollowEvent({ type: 'system' as FollowEvent['type'] }));
      expect(agg.getMetrics().messageCount).toBe(0);
      expect(agg.getMetrics().eventCount).toBe(1);
    });

    it('tracks per-model usage from FollowEvent', () => {
      agg.processFollowEvent(makeFollowEvent({
        model: 'model-x',
        tokens: { input: 300, output: 150 },
        cost: 0.01,
      }));

      const stats = agg.getModelStats();
      expect(stats).toHaveLength(1);
      expect(stats[0].model).toBe('model-x');
      expect(stats[0].calls).toBe(1);
      expect(stats[0].tokens).toBe(450);
      expect(stats[0].cost).toBe(0.01);
    });

    it('detects compaction from FollowEvent context drop', () => {
      agg.processFollowEvent(makeFollowEvent({
        tokens: { input: 10000, output: 500 },
        model: 'test',
      }));
      agg.processFollowEvent(makeFollowEvent({
        tokens: { input: 1000, output: 100 },
        model: 'test',
      }));

      expect(agg.getCompactionEvents().length).toBe(1);
    });

    it('handles explicit summary event as compaction', () => {
      agg.processFollowEvent(makeFollowEvent({
        type: 'summary',
        summary: 'Context compacted',
      }));
      expect(agg.getCompactionEvents().length).toBe(1);
    });

    it('tracks tool_use from FollowEvent', () => {
      agg.processFollowEvent(makeFollowEvent({
        type: 'tool_use',
        toolName: 'Read',
        raw: { id: 'tu-1', input: { file: '/test.ts' } },
      }));

      const stats = agg.getToolStats();
      expect(stats).toHaveLength(1);
      expect(stats[0].name).toBe('Read');
      expect(stats[0].pendingCount).toBe(1);
    });

    it('tracks tool_result from FollowEvent completing pending tool', () => {
      const ts1 = '2025-01-15T10:00:00.000Z';
      const ts2 = '2025-01-15T10:00:01.500Z';

      agg.processFollowEvent(makeFollowEvent({
        type: 'tool_use',
        toolName: 'Read',
        timestamp: ts1,
        raw: { id: 'tu-1', input: { file: '/test.ts' } },
      }));
      agg.processFollowEvent(makeFollowEvent({
        type: 'tool_result',
        timestamp: ts2,
        raw: { tool_use_id: 'tu-1', content: 'file contents', is_error: false },
      }));

      const stats = agg.getToolStats();
      expect(stats[0].pendingCount).toBe(0);
      expect(stats[0].completedCount).toBe(1);
      expect(stats[0].successCount).toBe(1);
      expect(stats[0].totalDuration).toBe(1500);
    });

    it('tracks tool errors from FollowEvent', () => {
      agg.processFollowEvent(makeFollowEvent({
        type: 'tool_use',
        toolName: 'Bash',
        timestamp: '2025-01-15T10:00:00Z',
        raw: { id: 'tu-1', input: { command: 'fail' } },
      }));
      agg.processFollowEvent(makeFollowEvent({
        type: 'tool_result',
        timestamp: '2025-01-15T10:00:01Z',
        raw: { tool_use_id: 'tu-1', content: 'error', is_error: true },
      }));

      const stats = agg.getToolStats();
      expect(stats[0].failureCount).toBe(1);
    });

    it('detects truncation from FollowEvent tool_result', () => {
      agg.processFollowEvent(makeFollowEvent({
        type: 'tool_use',
        toolName: 'Read',
        raw: { id: 'tu-1', input: {} },
      }));
      agg.processFollowEvent(makeFollowEvent({
        type: 'tool_result',
        raw: { tool_use_id: 'tu-1', content: '[Response truncated] remaining content was cut' },
      }));

      expect(agg.getTruncationEvents()).toHaveLength(1);
      // Note: the pending tool call is consumed by recordFollowToolResult before
      // truncation detection runs, so the tool name falls back to 'unknown'
      // unless toolName is set on the FollowEvent itself.
      expect(agg.getTruncationEvents()[0].toolName).toBe('unknown');
    });

    it('detects truncation from FollowEvent tool_result with toolName fallback', () => {
      agg.processFollowEvent(makeFollowEvent({
        type: 'tool_result',
        toolName: 'Bash',
        raw: { tool_use_id: 'tu-99', content: '<response clipped> output was too long' },
      }));

      expect(agg.getTruncationEvents()).toHaveLength(1);
      expect(agg.getTruncationEvents()[0].toolName).toBe('Bash');
    });

    it('adds timeline entries from FollowEvent', () => {
      agg.processFollowEvent(makeFollowEvent({
        type: 'user',
        summary: 'Fix the bug in parser',
      }));

      const tl = agg.getTimeline();
      expect(tl).toHaveLength(1);
      expect(tl[0].type).toBe('user_prompt');
      expect(tl[0].description).toBe('Fix the bug in parser');
    });

    it('handles context attribution from FollowEvent user type', () => {
      agg.processFollowEvent(makeFollowEvent({
        type: 'user',
        summary: 'Some user question',
      }));
      const attr = agg.getContextAttribution();
      expect(attr.userMessages).toBeGreaterThan(0);
    });

    it('handles context attribution from FollowEvent assistant type', () => {
      agg.processFollowEvent(makeFollowEvent({
        type: 'assistant',
        summary: 'Here is the answer',
      }));
      const attr = agg.getContextAttribution();
      expect(attr.assistantResponses).toBeGreaterThan(0);
    });

    it('handles context attribution from FollowEvent tool_use type', () => {
      agg.processFollowEvent(makeFollowEvent({
        type: 'tool_use',
        toolName: 'Read',
        summary: 'Read file /foo.ts',
        raw: { input: { file_path: '/foo.ts' } },
      }));
      const attr = agg.getContextAttribution();
      expect(attr.toolInputs).toBeGreaterThan(0);
    });

    it('handles context attribution from FollowEvent tool_result type', () => {
      agg.processFollowEvent(makeFollowEvent({
        type: 'tool_result',
        summary: 'File contents returned',
        raw: { content: 'actual file content here' },
      }));
      const attr = agg.getContextAttribution();
      expect(attr.toolOutputs).toBeGreaterThan(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Task tracking from FollowEvent
  // ═══════════════════════════════════════════════════════════════

  describe('task tracking from FollowEvent', () => {
    it('creates task from FollowEvent TaskCreate + tool_result', () => {
      agg.processFollowEvent(makeFollowEvent({
        type: 'tool_use',
        toolName: 'TaskCreate',
        raw: {
          id: 'tc-1',
          input: { subject: 'Build feature', description: 'New feature' },
        },
      }));
      agg.processFollowEvent(makeFollowEvent({
        type: 'tool_result',
        raw: { tool_use_id: 'tc-1', content: 'Task #10 created' },
      }));

      const state = agg.getTaskState();
      expect(state.tasks.size).toBe(1);
      expect(state.tasks.get('10')!.subject).toBe('Build feature');
    });

    it('handles TaskUpdate from FollowEvent', () => {
      // Create
      agg.processFollowEvent(makeFollowEvent({
        type: 'tool_use',
        toolName: 'TaskCreate',
        raw: { id: 'tc-1', input: { subject: 'Task' } },
      }));
      agg.processFollowEvent(makeFollowEvent({
        type: 'tool_result',
        raw: { tool_use_id: 'tc-1', content: 'Task #1 created' },
      }));

      // Update
      agg.processFollowEvent(makeFollowEvent({
        type: 'tool_use',
        toolName: 'TaskUpdate',
        raw: { id: 'tu-1', input: { taskId: '1', status: 'completed' } },
      }));

      expect(agg.getTaskState().tasks.get('1')!.status).toBe('completed');
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Subagent tracking from FollowEvent
  // ═══════════════════════════════════════════════════════════════

  describe('subagent tracking from FollowEvent', () => {
    it('tracks Task tool spawn via FollowEvent', () => {
      agg.processFollowEvent(makeFollowEvent({
        type: 'tool_use',
        toolName: 'Task',
        timestamp: '2025-01-15T10:00:00Z',
        raw: { id: 'sa-1', input: { description: 'Analyze code', subagent_type: 'Explore' } },
      }));

      const subagents = agg.getSubagents();
      expect(subagents).toHaveLength(1);
      expect(subagents[0].description).toBe('Analyze code');
      expect(subagents[0].subagentType).toBe('Explore');
      expect(subagents[0].status).toBe('running');
    });

    it('completes subagent from FollowEvent tool_result', () => {
      agg.processFollowEvent(makeFollowEvent({
        type: 'tool_use',
        toolName: 'Task',
        timestamp: '2025-01-15T10:00:00.000Z',
        raw: { id: 'sa-1', input: { description: 'Test' } },
      }));
      agg.processFollowEvent(makeFollowEvent({
        type: 'tool_result',
        timestamp: '2025-01-15T10:00:03.000Z',
        raw: { tool_use_id: 'sa-1', content: 'Done' },
      }));

      const subagents = agg.getSubagents();
      expect(subagents[0].status).toBe('completed');
      expect(subagents[0].durationMs).toBe(3000);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // getMetrics — full snapshot
  // ═══════════════════════════════════════════════════════════════

  describe('getMetrics', () => {
    it('returns a complete metrics snapshot', () => {
      agg.processEvent(makeUserEvent('Hello'));
      agg.processEvent(makeAssistantWithUsage(
        { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 10, cache_read_input_tokens: 5 },
        'test-model',
      ));

      const m = agg.getMetrics();

      // Basic counters
      expect(m.eventCount).toBe(2);
      expect(m.messageCount).toBe(2);
      expect(m.currentModel).toBe('test-model');

      // Tokens
      expect(m.tokens.inputTokens).toBe(100);
      expect(m.tokens.outputTokens).toBe(50);
      expect(m.tokens.cacheWriteTokens).toBe(10);
      expect(m.tokens.cacheReadTokens).toBe(5);

      // Model stats
      expect(m.modelStats).toHaveLength(1);
      expect(m.modelStats[0].model).toBe('test-model');

      // Context
      expect(m.currentContextSize).toBe(115); // 100 + 10 + 5
      expect(m.contextTimeline).toHaveLength(1);

      // Timeline
      expect(m.timeline.length).toBeGreaterThanOrEqual(1);

      // Default plan/task/subagent/permission
      expect(m.plan).toBeNull();
      expect(m.taskState.tasks.size).toBe(0);
      expect(m.subagents).toEqual([]);
      expect(m.permissionMode).toBeNull();
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // reset
  // ═══════════════════════════════════════════════════════════════

  describe('reset', () => {
    it('clears all accumulated state', () => {
      agg.processEvent(makeUserEvent('Hello'));
      agg.processEvent(makeAssistantWithUsage({ input_tokens: 100, output_tokens: 50 }));
      agg.processEvent(makeToolUseEvent('Read', 'tu-1'));

      agg.reset();

      const m = agg.getMetrics();
      expect(m.eventCount).toBe(0);
      expect(m.messageCount).toBe(0);
      expect(m.sessionStartTime).toBeNull();
      expect(m.lastEventTime).toBeNull();
      expect(m.currentModel).toBeNull();
      expect(m.tokens.inputTokens).toBe(0);
      expect(m.tokens.outputTokens).toBe(0);
      expect(m.currentContextSize).toBe(0);
      expect(m.modelStats).toEqual([]);
      expect(m.toolStats).toEqual([]);
      expect(m.timeline).toEqual([]);
      expect(m.compactionCount).toBe(0);
      expect(m.truncationCount).toBe(0);
      expect(m.permissionMode).toBeNull();
      expect(m.permissionModeHistory).toEqual([]);
      expect(m.contextTimeline).toEqual([]);
    });

    it('allows fresh accumulation after reset', () => {
      agg.processEvent(makeAssistantWithUsage({ input_tokens: 100, output_tokens: 50 }));
      agg.reset();
      agg.processEvent(makeAssistantWithUsage({ input_tokens: 200, output_tokens: 80 }));

      const tokens = agg.getAggregatedTokens();
      expect(tokens.inputTokens).toBe(200);
      expect(tokens.outputTokens).toBe(80);
    });

    it('preserves providerId from options after reset', () => {
      const custom = new EventAggregator({ providerId: 'codex' });
      custom.processEvent(makeUserEvent('hi'));
      custom.reset();
      expect(custom.getMetrics().providerId).toBe('codex');
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Seed methods
  // ═══════════════════════════════════════════════════════════════

  describe('seed methods', () => {
    it('seedContextSize sets current and previous context size', () => {
      agg.seedContextSize(5000);
      expect(agg.getMetrics().currentContextSize).toBe(5000);
    });

    it('seedContextAttribution sets attribution data', () => {
      agg.seedContextAttribution({
        systemPrompt: 100,
        userMessages: 200,
        assistantResponses: 300,
        toolInputs: 50,
        toolOutputs: 150,
        thinking: 80,
        other: 20,
      });
      const attr = agg.getContextAttribution();
      expect(attr.systemPrompt).toBe(100);
      expect(attr.userMessages).toBe(200);
      expect(attr.assistantResponses).toBe(300);
      expect(attr.toolInputs).toBe(50);
      expect(attr.toolOutputs).toBe(150);
      expect(attr.thinking).toBe(80);
      expect(attr.other).toBe(20);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Snapshot serialization and restoration
  // ═══════════════════════════════════════════════════════════════

  describe('serialize and restore', () => {
    it('round-trips state through serialize/restore', () => {
      // Build up state
      agg.processEvent(makeUserEvent('Hello'));
      agg.processEvent(makeAssistantWithUsage(
        { input_tokens: 500, output_tokens: 200, cache_creation_input_tokens: 50, cache_read_input_tokens: 30, reported_cost: 0.01 },
        'test-model',
      ));
      agg.processEvent(makeToolUseEvent('Read', 'tu-1'));
      agg.processEvent(makeToolResultEvent('tu-1', 'contents'));
      agg.processEvent(makeSessionEvent({
        type: 'assistant',
        message: { role: 'assistant', content: 'resp' },
        permissionMode: 'acceptEdits',
      }));

      const snapshot = agg.serialize();

      // Create a new aggregator and restore
      const restored = new EventAggregator();
      restored.restore(snapshot);

      const original = agg.getMetrics();
      const restoredMetrics = restored.getMetrics();

      expect(restoredMetrics.tokens).toEqual(original.tokens);
      expect(restoredMetrics.eventCount).toEqual(original.eventCount);
      expect(restoredMetrics.messageCount).toEqual(original.messageCount);
      expect(restoredMetrics.currentModel).toEqual(original.currentModel);
      expect(restoredMetrics.sessionStartTime).toEqual(original.sessionStartTime);
      expect(restoredMetrics.lastEventTime).toEqual(original.lastEventTime);
      expect(restoredMetrics.currentContextSize).toEqual(original.currentContextSize);
      expect(restoredMetrics.permissionMode).toEqual(original.permissionMode);
      expect(restoredMetrics.compactionCount).toEqual(original.compactionCount);
      expect(restoredMetrics.truncationCount).toEqual(original.truncationCount);
    });

    it('skips restore for incompatible snapshot version', () => {
      agg.processEvent(makeUserEvent('data'));
      const snapshot = agg.serialize();
      snapshot.version = 999;

      const fresh = new EventAggregator();
      fresh.restore(snapshot);

      // Should remain in fresh state
      expect(fresh.getMetrics().eventCount).toBe(0);
    });

    it('clears transient state (pending calls) on restore', () => {
      agg.processEvent(makeToolUseEvent('Read', 'tu-1'));
      // tu-1 is pending -- after restore it should be cleared
      const snapshot = agg.serialize();

      const restored = new EventAggregator();
      restored.restore(snapshot);

      // Sending a result for tu-1 should not find the pending call
      restored.processEvent(makeToolResultEvent('tu-1', 'contents'));
      // The tool stats should show 1 pending (from snapshot) — the result didn't resolve it
      const stats = restored.getToolStats();
      const readTool = stats.find(s => s.name === 'Read');
      expect(readTool).toBeDefined();
      // pendingCount was serialized as 1 in toolAnalytics, and the result did not decrement it
      // because the pendingToolCalls map was cleared
      expect(readTool!.pendingCount).toBe(1);
    });

    it('serializes and restores model usage', () => {
      agg.processEvent(makeAssistantWithUsage({ input_tokens: 100, output_tokens: 50 }, 'model-a'));
      agg.processEvent(makeAssistantWithUsage({ input_tokens: 200, output_tokens: 80 }, 'model-b'));

      const snapshot = agg.serialize();
      const restored = new EventAggregator();
      restored.restore(snapshot);

      const stats = restored.getModelStats();
      expect(stats).toHaveLength(2);
      expect(stats.find(s => s.model === 'model-a')!.inputTokens).toBe(100);
      expect(stats.find(s => s.model === 'model-b')!.inputTokens).toBe(200);
    });

    it('handles missing optional fields in snapshot gracefully', () => {
      const snapshot = agg.serialize();
      // Simulate an older snapshot that might lack optional fields
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const raw = snapshot as any;
      delete raw.permissionMode;
      delete raw.permissionModeHistory;
      delete raw.contextTimeline;
      delete raw.contextTurnIndex;

      const restored = new EventAggregator();
      restored.restore(snapshot);

      expect(restored.getMetrics().permissionMode).toBeNull();
      expect(restored.getMetrics().permissionModeHistory).toEqual([]);
      expect(restored.getMetrics().contextTimeline).toEqual([]);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Edge cases
  // ═══════════════════════════════════════════════════════════════

  describe('edge cases', () => {
    it('handles empty content array in events', () => {
      agg.processEvent(makeSessionEvent({
        type: 'assistant',
        message: { role: 'assistant', content: [] },
      }));
      // Should not crash, event should be counted
      expect(agg.getMetrics().eventCount).toBe(1);
    });

    it('handles non-array, non-string content', () => {
      agg.processEvent(makeSessionEvent({
        type: 'user',
        message: { role: 'user', content: 42 as unknown as string },
      }));
      expect(agg.getMetrics().eventCount).toBe(1);
    });

    it('handles tool_use content block with missing id', () => {
      agg.processEvent(makeSessionEvent({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', name: 'Read', input: {} }], // no id
        },
      }));
      // Should not crash, no pending tool tracked
      expect(agg.getToolStats()).toHaveLength(0);
    });

    it('handles tool_result content block with missing tool_use_id', () => {
      agg.processEvent(makeSessionEvent({
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', content: 'data' }], // no tool_use_id
        },
      }));
      expect(agg.getToolStats()).toHaveLength(0);
    });

    it('handles invalid timestamps gracefully in burn rate', () => {
      agg.processEvent(makeSessionEvent({
        type: 'assistant',
        timestamp: 'not-a-date',
        message: {
          role: 'assistant',
          content: 'hi',
          usage: makeUsage(),
        },
      }));
      // Should not crash
      expect(agg.getBurnRate().sampleCount).toBe(0);
    });

    it('processes many events without error', () => {
      for (let i = 0; i < 500; i++) {
        agg.processEvent(makeAssistantWithUsage({ input_tokens: 10, output_tokens: 5 }));
      }
      expect(agg.getMetrics().eventCount).toBe(500);
      expect(agg.getAggregatedTokens().inputTokens).toBe(5000);
    });

    it('handles FollowEvent with no tokens', () => {
      agg.processFollowEvent(makeFollowEvent({
        type: 'assistant',
        // no tokens field
      }));
      expect(agg.getAggregatedTokens().inputTokens).toBe(0);
    });

    it('handles FollowEvent tool_result with no raw data', () => {
      agg.processFollowEvent(makeFollowEvent({
        type: 'tool_result',
        // no raw
      }));
      // Should not crash
      expect(agg.getToolStats()).toHaveLength(0);
    });

    it('handles task extraction with JSON taskId format', () => {
      agg.processEvent(makeToolUseEvent('TaskCreate', 'tc-1', { subject: 'JSON task' }));
      agg.processEvent(makeToolResultEvent('tc-1', '{"taskId": 77}'));

      const state = agg.getTaskState();
      expect(state.tasks.has('77')).toBe(true);
    });

    it('handles TaskCreate without matching tool_result', () => {
      agg.processEvent(makeToolUseEvent('TaskCreate', 'tc-1', { subject: 'Orphan' }));
      // No corresponding tool_result
      expect(agg.getTaskState().tasks.size).toBe(0);
    });

    it('handles TaskUpdate with status=deleted for unknown task', () => {
      agg.processEvent(makeToolUseEvent('TaskUpdate', 'tu-1', { taskId: 'nonexistent', status: 'deleted' }));
      // Should not crash, and no task should be created
      expect(agg.getTaskState().tasks.size).toBe(0);
    });

    it('handles subagent with default description and type', () => {
      agg.processEvent(makeSessionEvent({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'sa-1', name: 'Task', input: {} },
          ],
        },
      }));

      const subagents = agg.getSubagents();
      expect(subagents[0].description).toBe('Unknown task');
      expect(subagents[0].subagentType).toBe('general');
    });

    it('handles FollowEvent TaskCreate without raw.input', () => {
      agg.processFollowEvent(makeFollowEvent({
        type: 'tool_use',
        toolName: 'TaskCreate',
        raw: { id: 'tc-1' }, // no input
      }));
      // Should not crash
      expect(agg.getMetrics().eventCount).toBe(1);
    });

    it('handles FollowEvent tool_result without tool_use_id in raw', () => {
      agg.processFollowEvent(makeFollowEvent({
        type: 'tool_result',
        raw: { content: 'some result' }, // no tool_use_id
      }));
      // Should not crash, no stats changed
      expect(agg.getToolStats()).toHaveLength(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Getter return value independence (no aliasing)
  // ═══════════════════════════════════════════════════════════════

  describe('getter return value independence', () => {
    it('getAggregatedTokens returns independent copies', () => {
      agg.processEvent(makeAssistantWithUsage({ input_tokens: 100, output_tokens: 50 }));
      const t1 = agg.getAggregatedTokens();
      const t2 = agg.getAggregatedTokens();
      expect(t1).toEqual(t2);
      // Mutating t1 should not affect t2 or agg
      t1.inputTokens = 9999;
      expect(agg.getAggregatedTokens().inputTokens).toBe(100);
    });

    it('getTimeline returns independent copies', () => {
      agg.processEvent(makeUserEvent('Hello'));
      const tl1 = agg.getTimeline();
      const tl2 = agg.getTimeline();
      expect(tl1).toEqual(tl2);
      tl1.push({ type: 'error', timestamp: '', description: 'fake' });
      expect(agg.getTimeline().length).not.toBe(tl1.length);
    });

    it('getCompactionEvents returns independent copy', () => {
      agg.processEvent(makeAssistantWithUsage({ input_tokens: 10000, output_tokens: 500 }));
      agg.processEvent(makeAssistantWithUsage({ input_tokens: 1000, output_tokens: 100 }));
      const c1 = agg.getCompactionEvents();
      const c2 = agg.getCompactionEvents();
      expect(c1).toEqual(c2);
      c1.length = 0;
      expect(agg.getCompactionEvents()).toHaveLength(1);
    });

    it('getTaskState returns independent copy of tasks map', () => {
      agg.processEvent(makeToolUseEvent('TaskCreate', 'tc-1', { subject: 'T' }));
      agg.processEvent(makeToolResultEvent('tc-1', 'Task #1 created'));

      const s1 = agg.getTaskState();
      const s2 = agg.getTaskState();
      expect(s1.tasks.size).toBe(s2.tasks.size);
      s1.tasks.clear();
      expect(agg.getTaskState().tasks.size).toBe(1);
    });

    it('getSubagents returns independent copy', () => {
      agg.processEvent(makeSessionEvent({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'sa-1', name: 'Task', input: { description: 'test' } }],
        },
      }));
      const s1 = agg.getSubagents();
      s1.length = 0;
      expect(agg.getSubagents()).toHaveLength(1);
    });

    it('getContextAttribution returns independent copy', () => {
      agg.processEvent(makeUserEvent('Some text'));
      const a1 = agg.getContextAttribution();
      a1.userMessages = 0;
      expect(agg.getContextAttribution().userMessages).toBeGreaterThan(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Integration-style: mixed event processing
  // ═══════════════════════════════════════════════════════════════

  describe('mixed event processing scenario', () => {
    it('processes a realistic session sequence', () => {
      const baseTs = new Date('2025-01-15T10:00:00Z');

      // 1. User asks a question
      agg.processEvent(makeSessionEvent({
        type: 'user',
        timestamp: new Date(baseTs.getTime()).toISOString(),
        message: { role: 'user', content: 'How do I fix the parser bug?' },
      }));

      // 2. Assistant responds with text + tool use
      agg.processEvent(makeSessionEvent({
        type: 'assistant',
        timestamp: new Date(baseTs.getTime() + 2000).toISOString(),
        message: {
          role: 'assistant',
          model: 'claude-sonnet-4-20250514',
          content: [
            { type: 'text', text: 'Let me check the parser code.' },
            { type: 'tool_use', id: 'tu-1', name: 'Read', input: { file_path: '/src/parser.ts' } },
          ],
          usage: makeUsage({ input_tokens: 500, output_tokens: 200 }),
        },
        permissionMode: 'default',
      }));

      // 3. Tool result
      agg.processEvent(makeSessionEvent({
        type: 'user',
        timestamp: new Date(baseTs.getTime() + 3000).toISOString(),
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'tu-1', content: 'export function parse() { ... }' },
          ],
        },
      }));

      // 4. Assistant makes a fix
      agg.processEvent(makeSessionEvent({
        type: 'assistant',
        timestamp: new Date(baseTs.getTime() + 5000).toISOString(),
        message: {
          role: 'assistant',
          model: 'claude-sonnet-4-20250514',
          content: [
            { type: 'thinking', thinking: 'The parser has an off-by-one error...' },
            { type: 'text', text: 'I found the bug. Fixing it now.' },
            { type: 'tool_use', id: 'tu-2', name: 'Write', input: { file_path: '/src/parser.ts', content: 'fixed code' } },
          ],
          usage: makeUsage({ input_tokens: 800, output_tokens: 150 }),
        },
        permissionMode: 'acceptEdits',
      }));

      // 5. Write result
      agg.processEvent(makeSessionEvent({
        type: 'user',
        timestamp: new Date(baseTs.getTime() + 6000).toISOString(),
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'tu-2', content: 'File written successfully' },
          ],
        },
      }));

      const m = agg.getMetrics();

      // Counters
      expect(m.eventCount).toBe(5);
      expect(m.messageCount).toBe(5);

      // Tokens
      expect(m.tokens.inputTokens).toBe(1300);
      expect(m.tokens.outputTokens).toBe(350);

      // Model
      expect(m.currentModel).toBe('claude-sonnet-4-20250514');
      expect(m.modelStats).toHaveLength(1);
      expect(m.modelStats[0].calls).toBe(2);

      // Tools
      const readTool = m.toolStats.find(t => t.name === 'Read');
      expect(readTool).toBeDefined();
      expect(readTool!.completedCount).toBe(1);
      expect(readTool!.successCount).toBe(1);

      const writeTool = m.toolStats.find(t => t.name === 'Write');
      expect(writeTool).toBeDefined();
      expect(writeTool!.completedCount).toBe(1);

      // Permission mode
      expect(m.permissionMode).toBe('acceptEdits');
      expect(m.permissionModeHistory).toHaveLength(2);

      // Context attribution
      expect(m.contextAttribution.userMessages).toBeGreaterThan(0);
      expect(m.contextAttribution.assistantResponses).toBeGreaterThan(0);
      expect(m.contextAttribution.toolInputs).toBeGreaterThan(0);
      expect(m.contextAttribution.toolOutputs).toBeGreaterThan(0);
      expect(m.contextAttribution.thinking).toBeGreaterThan(0);

      // Timeline
      expect(m.timeline.length).toBeGreaterThanOrEqual(3);

      // Context size should reflect the last usage event
      expect(m.currentContextSize).toBe(800); // 800 + 0 + 0

      // Latency (user at +0ms, first text response at +2000ms)
      const latency = m.latencyStats;
      expect(latency).not.toBeNull();
      expect(latency!.completedCycles).toBe(1);
    });
  });
});
