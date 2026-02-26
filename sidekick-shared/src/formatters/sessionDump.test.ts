import { describe, it, expect } from 'vitest';
import {
  formatSessionText,
  formatSessionMarkdown,
  formatSessionJson,
  fmtTokens,
  fmtCost,
  formatTimestamp,
  formatDuration,
} from './sessionDump';
import type { AggregatedMetrics } from '../aggregation/types';
import type { TimelineEvent } from '../types/sessionEvent';

/** Minimal valid AggregatedMetrics for testing. */
function mockMetrics(overrides: Partial<AggregatedMetrics> = {}): AggregatedMetrics {
  return {
    sessionStartTime: '2025-06-15T10:00:00Z',
    lastEventTime: '2025-06-15T10:05:30Z',
    messageCount: 4,
    eventCount: 12,
    currentModel: 'claude-sonnet-4-20250514',
    providerId: 'claude-code',
    tokens: {
      inputTokens: 15000,
      outputTokens: 3000,
      cacheWriteTokens: 500,
      cacheReadTokens: 12000,
      reportedCost: 0,
    },
    modelStats: [],
    currentContextSize: 15000,
    contextAttribution: { systemPrompt: 0, userMessages: 0, assistantResponses: 0, toolInputs: 0, toolOutputs: 0, thinking: 0, other: 0 },
    compactionCount: 0,
    compactionEvents: [],
    truncationCount: 0,
    truncationEvents: [],
    toolStats: [],
    burnRate: { tokensPerMinute: 0, points: [], sampleCount: 0 },
    taskState: { tasks: new Map(), activeTaskId: null },
    subagents: [],
    plan: null,
    permissionMode: null,
    permissionModeHistory: [],
    contextTimeline: [],
    timeline: [],
    latencyStats: null,
    ...overrides,
  };
}

function makeEvent(overrides: Partial<TimelineEvent> = {}): TimelineEvent {
  return {
    type: 'assistant_response',
    timestamp: '2025-06-15T10:01:00Z',
    description: 'Hello world',
    ...overrides,
  };
}

describe('formatSessionJson', () => {
  it('produces valid JSON with trailing newline', () => {
    const metrics = mockMetrics();
    const result = formatSessionJson(metrics);
    expect(result.endsWith('\n')).toBe(true);
    expect(() => JSON.parse(result)).not.toThrow();
  });

  it('includes key metric fields', () => {
    const result = formatSessionJson(mockMetrics());
    const parsed = JSON.parse(result);
    expect(parsed.messageCount).toBe(4);
    expect(parsed.eventCount).toBe(12);
    expect(parsed.providerId).toBe('claude-code');
  });
});

describe('formatSessionText', () => {
  it('includes header with provider and model', () => {
    const result = formatSessionText(mockMetrics());
    expect(result).toContain('claude-code');
    expect(result).toContain('claude-sonnet-4-20250514');
    expect(result).toContain('4 messages');
    expect(result).toContain('12 events');
  });

  it('includes token summary', () => {
    const result = formatSessionText(mockMetrics());
    expect(result).toContain('Tokens:');
    expect(result).toContain('18.0k total');
    expect(result).toContain('15.0k in');
    expect(result).toContain('3.0k out');
  });

  it('includes model stats when present', () => {
    const result = formatSessionText(mockMetrics({
      modelStats: [{ model: 'claude-sonnet-4-20250514', calls: 3, tokens: 18000, inputTokens: 15000, outputTokens: 3000, cacheWriteTokens: 0, cacheReadTokens: 0, cost: 0.12 }],
    }));
    expect(result).toContain('Models:');
    expect(result).toContain('claude-sonnet-4-20250514: 3 calls');
  });

  it('includes tool stats sorted by call count', () => {
    const result = formatSessionText(mockMetrics({
      toolStats: [
        { name: 'Read', successCount: 2, failureCount: 0, totalDuration: 200, completedCount: 2, pendingCount: 0 },
        { name: 'Bash', successCount: 5, failureCount: 1, totalDuration: 3000, completedCount: 5, pendingCount: 0 },
      ],
    }));
    expect(result).toContain('Tools:');
    // Bash (6 total) should come before Read (2 total)
    const bashIdx = result.indexOf('Bash');
    const readIdx = result.indexOf('Read');
    expect(bashIdx).toBeLessThan(readIdx);
    expect(result).toContain('(1 failed)');
  });

  it('includes compaction/truncation info', () => {
    const result = formatSessionText(mockMetrics({ compactionCount: 2, truncationCount: 1 }));
    expect(result).toContain('Context: 2 compaction(s), 1 truncation(s)');
  });

  it('shows timeline events', () => {
    const result = formatSessionText(mockMetrics({
      timeline: [
        makeEvent({ type: 'user_prompt', description: 'Fix the bug' }),
        makeEvent({ type: 'tool_call', description: 'Read src/main.ts' }),
      ],
    }));
    expect(result).toContain('Timeline:');
    expect(result).toContain('Fix the bug');
    expect(result).toContain('Read src/main.ts');
  });

  it('shows (no events) when timeline is empty', () => {
    const result = formatSessionText(mockMetrics());
    expect(result).toContain('(no events)');
  });

  it('filters noise events by default', () => {
    const result = formatSessionText(mockMetrics({
      timeline: [
        makeEvent({ type: 'user_prompt', description: 'Visible', noiseLevel: 'user' }),
        makeEvent({ type: 'tool_result', description: 'Hidden noise', noiseLevel: 'noise' }),
      ],
    }));
    expect(result).toContain('Visible');
    expect(result).not.toContain('Hidden noise');
  });

  it('shows noise events when expand is true', () => {
    const result = formatSessionText(mockMetrics({
      timeline: [
        makeEvent({ type: 'tool_result', description: 'Noise event', noiseLevel: 'noise' }),
      ],
    }), { expand: true });
    expect(result).toContain('Noise event');
  });

  it('respects width option', () => {
    const result = formatSessionText(mockMetrics(), { width: 40 });
    // Horizontal rule should be 40 chars
    expect(result).toContain('\u2500'.repeat(40));
  });
});

describe('formatSessionMarkdown', () => {
  it('starts with H1 Session Report', () => {
    const result = formatSessionMarkdown(mockMetrics());
    expect(result.startsWith('# Session Report')).toBe(true);
  });

  it('includes summary table', () => {
    const result = formatSessionMarkdown(mockMetrics());
    expect(result).toContain('## Summary');
    expect(result).toContain('| Messages | 4 |');
    expect(result).toContain('| Events | 12 |');
    expect(result).toContain('| Provider | claude-code |');
  });

  it('includes session file name when provided', () => {
    const result = formatSessionMarkdown(mockMetrics(), { sessionFileName: 'abc123.jsonl' });
    expect(result).toContain('`abc123.jsonl`');
  });

  it('omits session file row when not provided', () => {
    const result = formatSessionMarkdown(mockMetrics());
    expect(result).not.toContain('Session file');
  });

  it('includes tokens table', () => {
    const result = formatSessionMarkdown(mockMetrics());
    expect(result).toContain('## Tokens');
    expect(result).toContain('| Input | 15.0k |');
    expect(result).toContain('| Output | 3.0k |');
  });

  it('includes cost row when reportedCost > 0', () => {
    const result = formatSessionMarkdown(mockMetrics({
      tokens: { inputTokens: 1000, outputTokens: 500, cacheWriteTokens: 0, cacheReadTokens: 0, reportedCost: 0.05 },
    }));
    expect(result).toContain('| Cost | $0.05 |');
  });

  it('includes tool calls table', () => {
    const result = formatSessionMarkdown(mockMetrics({
      toolStats: [
        { name: 'Read', successCount: 3, failureCount: 0, totalDuration: 150, completedCount: 3, pendingCount: 0 },
      ],
    }));
    expect(result).toContain('## Tool Calls');
    expect(result).toContain('| Read | 3 | 0 | 50ms |');
  });

  it('includes subagents table', () => {
    const result = formatSessionMarkdown(mockMetrics({
      subagents: [
        { id: 'a1', description: 'Research task', subagentType: 'Explore', spawnTime: '2025-06-15T10:01:00Z', status: 'completed', durationMs: 12000 },
      ],
    }));
    expect(result).toContain('## Subagents');
    expect(result).toContain('| Explore | Research task | completed | 12s |');
  });

  it('includes compaction events with timestamps', () => {
    const result = formatSessionMarkdown(mockMetrics({
      compactionCount: 1,
      compactionEvents: [{ timestamp: new Date('2025-06-15T10:03:00Z'), contextBefore: 100000, contextAfter: 30000, tokensReclaimed: 70000 }],
    }));
    expect(result).toContain('## Context Management');
    expect(result).toContain('**Compactions:** 1');
    expect(result).toContain('100.0k -> 30.0k tokens');
  });

  it('includes timeline in code block', () => {
    const result = formatSessionMarkdown(mockMetrics({
      timeline: [makeEvent({ type: 'user_prompt', description: 'Hello' })],
    }));
    expect(result).toContain('## Timeline');
    expect(result).toContain('```');
    expect(result).toContain('Hello');
  });

  it('filters noise in timeline by default', () => {
    const result = formatSessionMarkdown(mockMetrics({
      timeline: [
        makeEvent({ description: 'Signal', noiseLevel: 'user' }),
        makeEvent({ description: 'Noise', noiseLevel: 'noise' }),
      ],
    }));
    expect(result).toContain('Signal');
    expect(result).not.toContain('Noise');
  });

  it('shows _(no events)_ for empty timeline', () => {
    const result = formatSessionMarkdown(mockMetrics());
    expect(result).toContain('_(no events)_');
  });
});

describe('icon mapping', () => {
  it('maps all TimelineEvent types to non-space icons', () => {
    const types = ['user_prompt', 'assistant_response', 'tool_call', 'tool_result', 'compaction', 'error', 'session_start', 'session_end'] as const;
    for (const type of types) {
      const result = formatSessionText(mockMetrics({
        timeline: [makeEvent({ type, description: `event-${type}` })],
      }));
      // Each event should have a non-space icon character before the description
      const line = result.split('\n').find(l => l.includes(`event-${type}`));
      expect(line).toBeDefined();
      // Icon is between timestamp and description — check it's not just whitespace
      const match = line!.match(/\d{2}:\d{2}:\d{2} (.) event-/);
      expect(match).toBeTruthy();
      expect(match![1].trim().length).toBeGreaterThan(0);
    }
  });
});

describe('helper functions', () => {
  describe('fmtTokens', () => {
    it('formats millions', () => expect(fmtTokens(1_500_000)).toBe('1.5M'));
    it('formats thousands', () => expect(fmtTokens(15_000)).toBe('15.0k'));
    it('formats small numbers', () => expect(fmtTokens(42)).toBe('42'));
    it('formats zero', () => expect(fmtTokens(0)).toBe('0'));
  });

  describe('fmtCost', () => {
    it('formats zero', () => expect(fmtCost(0)).toBe('$0.00'));
    it('formats small costs with 4 decimals', () => expect(fmtCost(0.0023)).toBe('$0.0023'));
    it('formats normal costs with 2 decimals', () => expect(fmtCost(1.23)).toBe('$1.23'));
    it('formats negative as $0.00', () => expect(fmtCost(-5)).toBe('$0.00'));
  });

  describe('formatTimestamp', () => {
    it('formats ISO timestamp to HH:MM:SS', () => {
      // Use a fixed UTC time and check the local representation
      const result = formatTimestamp('2025-06-15T10:30:45Z');
      expect(result).toMatch(/^\d{2}:\d{2}:\d{2}$/);
    });

    it('returns ??:??:?? for invalid input', () => {
      expect(formatTimestamp('not-a-date')).toBe('??:??:??');
    });
  });

  describe('formatDuration', () => {
    it('formats seconds', () => expect(formatDuration('2025-01-01T00:00:00Z', '2025-01-01T00:00:45Z')).toBe('45s'));
    it('formats minutes and seconds', () => expect(formatDuration('2025-01-01T00:00:00Z', '2025-01-01T00:05:30Z')).toBe('5m 30s'));
    it('formats hours', () => expect(formatDuration('2025-01-01T00:00:00Z', '2025-01-01T01:30:15Z')).toBe('1h 30m 15s'));
    it('returns N/A for null start', () => expect(formatDuration(null, '2025-01-01T00:00:00Z')).toBe('N/A'));
    it('returns N/A for null end', () => expect(formatDuration('2025-01-01T00:00:00Z', null)).toBe('N/A'));
    it('returns N/A for negative duration', () => expect(formatDuration('2025-01-01T01:00:00Z', '2025-01-01T00:00:00Z')).toBe('N/A'));
  });
});

describe('edge cases', () => {
  it('handles zero tokens', () => {
    const metrics = mockMetrics({
      tokens: { inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, reportedCost: 0 },
    });
    const result = formatSessionText(metrics);
    expect(result).toContain('Tokens: 0 total');
  });

  it('handles null timestamps', () => {
    const metrics = mockMetrics({ sessionStartTime: null, lastEventTime: null });
    const result = formatSessionMarkdown(metrics);
    expect(result).toContain('| Started | N/A |');
    expect(result).toContain('| Duration | N/A |');
  });

  it('handles empty timeline in all formats', () => {
    const metrics = mockMetrics();
    expect(formatSessionText(metrics)).toContain('(no events)');
    expect(formatSessionMarkdown(metrics)).toContain('_(no events)_');
    // JSON always includes the timeline array
    const json = JSON.parse(formatSessionJson(metrics));
    expect(json.timeline).toEqual([]);
  });
});
