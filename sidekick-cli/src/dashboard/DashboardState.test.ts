import { describe, it, expect } from 'vitest';
import { DashboardState } from './DashboardState';
import type { FollowEvent } from 'sidekick-shared';

function makeEvent(overrides: Partial<FollowEvent> = {}): FollowEvent {
  return {
    providerId: 'claude-code',
    type: 'assistant',
    timestamp: new Date().toISOString(),
    summary: 'test',
    ...overrides,
  };
}

describe('DashboardState', () => {
  describe('token aggregation', () => {
    it('accumulates input and output tokens', () => {
      const state = new DashboardState();
      state.processEvent(makeEvent({ tokens: { input: 100, output: 50 }, cost: 0.01 }));
      state.processEvent(makeEvent({ tokens: { input: 200, output: 100 }, cost: 0.02 }));
      const m = state.getMetrics();
      expect(m.tokens.input).toBe(300);
      expect(m.tokens.output).toBe(150);
      expect(m.tokens.cost).toBeCloseTo(0.03);
    });

    it('accumulates cache tokens', () => {
      const state = new DashboardState();
      state.processEvent(makeEvent({
        tokens: { input: 100, output: 50 },
        cacheTokens: { read: 80, write: 20 },
      }));
      state.processEvent(makeEvent({
        tokens: { input: 200, output: 100 },
        cacheTokens: { read: 150, write: 30 },
      }));
      const m = state.getMetrics();
      expect(m.tokens.cacheRead).toBe(230);
      expect(m.tokens.cacheWrite).toBe(50);
    });
  });

  describe('context gauge', () => {
    it('computes percentage from last input tokens (no cache)', () => {
      const state = new DashboardState();
      state.processEvent(makeEvent({
        model: 'claude-sonnet-4-20250514',
        tokens: { input: 100_000, output: 500 },
      }));
      const m = state.getMetrics();
      expect(m.context.used).toBe(100_000);
      expect(m.context.limit).toBe(200_000);
      expect(m.context.percent).toBe(50);
    });

    it('includes cache tokens in context window usage', () => {
      const state = new DashboardState();
      state.processEvent(makeEvent({
        model: 'claude-sonnet-4-20250514',
        tokens: { input: 5_000, output: 500 },
        cacheTokens: { read: 90_000, write: 5_000 },
      }));
      const m = state.getMetrics();
      // Full context = input (5K) + cache_read (90K) + cache_write (5K) = 100K
      expect(m.context.used).toBe(100_000);
      expect(m.context.limit).toBe(200_000);
      expect(m.context.percent).toBe(50);
    });
  });

  describe('tool stats', () => {
    it('counts tool calls', () => {
      const state = new DashboardState();
      state.processEvent(makeEvent({
        type: 'tool_use',
        toolName: 'Read',
        raw: { id: 'tu1', name: 'Read', input: { file_path: '/foo.ts' } },
      }));
      state.processEvent(makeEvent({
        type: 'tool_use',
        toolName: 'Read',
        raw: { id: 'tu2', name: 'Read', input: { file_path: '/bar.ts' } },
      }));
      state.processEvent(makeEvent({
        type: 'tool_use',
        toolName: 'Edit',
        raw: { id: 'tu3', name: 'Edit', input: { file_path: '/foo.ts' } },
      }));
      const m = state.getMetrics();
      const readStats = m.toolStats.find(t => t.name === 'Read');
      expect(readStats?.calls).toBe(2);
      const editStats = m.toolStats.find(t => t.name === 'Edit');
      expect(editStats?.calls).toBe(1);
    });
  });

  describe('model stats', () => {
    it('groups by model ID', () => {
      const state = new DashboardState();
      state.processEvent(makeEvent({
        model: 'claude-sonnet-4-20250514',
        tokens: { input: 1000, output: 500 },
        cost: 0.05,
      }));
      state.processEvent(makeEvent({
        model: 'claude-sonnet-4-20250514',
        tokens: { input: 2000, output: 1000 },
        cost: 0.10,
      }));
      state.processEvent(makeEvent({
        model: 'claude-haiku-4-5',
        tokens: { input: 500, output: 200 },
        cost: 0.01,
      }));
      const m = state.getMetrics();
      expect(m.modelStats).toHaveLength(2);
      const sonnet = m.modelStats.find(s => s.model.includes('sonnet'));
      expect(sonnet?.calls).toBe(2);
      expect(sonnet?.tokens).toBe(4500);
    });
  });

  describe('timeline', () => {
    it('keeps events up to ring buffer size', () => {
      const state = new DashboardState();
      for (let i = 0; i < 250; i++) {
        state.processEvent(makeEvent({ summary: `event-${i}` }));
      }
      const m = state.getMetrics();
      expect(m.timeline).toHaveLength(200);
      expect(m.timeline[0].summary).toBe('event-50');
    });
  });

  describe('compaction detection', () => {
    it('counts explicit summary events', () => {
      const state = new DashboardState();
      state.processEvent(makeEvent({ type: 'summary', summary: 'Context compacted', timestamp: '2025-01-01T00:00:01Z' }));
      state.processEvent(makeEvent({ type: 'assistant', summary: 'Hello', timestamp: '2025-01-01T00:00:02Z' }));
      state.processEvent(makeEvent({ type: 'summary', summary: 'Context compacted', timestamp: '2025-01-01T00:00:03Z' }));
      expect(state.getMetrics().compactionCount).toBe(2);
    });

    it('detects compaction via >20% context size drop', () => {
      const state = new DashboardState();
      // First turn: 150K context
      state.processEvent(makeEvent({
        type: 'assistant', model: 'claude-sonnet-4-20250514',
        tokens: { input: 150_000, output: 500 },
        timestamp: '2025-01-01T00:00:01Z',
      }));
      // Next turn: drops to 60K (60% drop — well over 20% threshold)
      state.processEvent(makeEvent({
        type: 'assistant', model: 'claude-sonnet-4-20250514',
        tokens: { input: 60_000, output: 500 },
        timestamp: '2025-01-01T00:00:02Z',
      }));
      const m = state.getMetrics();
      expect(m.compactionCount).toBe(1);
      expect(m.compactionEvents).toHaveLength(1);
      expect(m.compactionEvents[0].contextBefore).toBe(150_000);
      expect(m.compactionEvents[0].contextAfter).toBe(60_000);
      expect(m.compactionEvents[0].tokensReclaimed).toBe(90_000);
    });

    it('records both summary event and context drop as separate compactions', () => {
      const state = new DashboardState();
      // Establish context size
      state.processEvent(makeEvent({
        type: 'assistant', model: 'claude-sonnet-4-20250514',
        tokens: { input: 150_000, output: 500 },
        timestamp: '2025-01-01T00:00:01Z',
      }));
      // Summary event fires (no tokens) — aggregator records compaction #1
      state.processEvent(makeEvent({
        type: 'summary', summary: 'Context compacted',
        timestamp: '2025-01-01T00:00:02Z',
      }));
      // Next assistant event has lower context — aggregator records compaction #2 via drop detection
      state.processEvent(makeEvent({
        type: 'assistant', model: 'claude-sonnet-4-20250514',
        tokens: { input: 60_000, output: 500 },
        timestamp: '2025-01-01T00:00:03Z',
      }));
      const m = state.getMetrics();
      // The shared EventAggregator records both the explicit summary event and the
      // subsequent context size drop as separate compaction events.
      expect(m.compactionCount).toBe(2);
      expect(m.compactionEvents).toHaveLength(2);
      // First compaction: from summary event (contextAfter=0 since no tokens on summary)
      expect(m.compactionEvents[0].contextBefore).toBe(150_000);
      expect(m.compactionEvents[0].contextAfter).toBe(0);
      // Second compaction: from drop detection (150K -> 60K)
      expect(m.compactionEvents[1].contextBefore).toBe(150_000);
      expect(m.compactionEvents[1].contextAfter).toBe(60_000);
    });

    it('injects compaction into timeline', () => {
      const state = new DashboardState();
      state.processEvent(makeEvent({
        type: 'assistant', model: 'claude-sonnet-4-20250514',
        tokens: { input: 150_000, output: 500 },
        timestamp: '2025-01-01T00:00:01Z',
      }));
      state.processEvent(makeEvent({
        type: 'assistant', model: 'claude-sonnet-4-20250514',
        tokens: { input: 60_000, output: 500 },
        timestamp: '2025-01-01T00:00:02Z',
      }));
      const m = state.getMetrics();
      const compactionEntry = m.timeline.find(e => e.type === 'summary' && e.summary.includes('compacted'));
      expect(compactionEntry).toBeDefined();
      expect(compactionEntry!.summary).toContain('150.0K');
      expect(compactionEntry!.summary).toContain('60.0K');
    });
  });

  describe('task extraction (two-phase: tool_use → tool_result)', () => {
    it('creates tasks from TaskCreate tool_use + tool_result pair', () => {
      const state = new DashboardState();
      // Phase 1: TaskCreate tool_use (no taskId in input — it doesn't exist yet)
      state.processEvent(makeEvent({
        type: 'tool_use',
        toolName: 'TaskCreate',
        raw: {
          id: 'toolu_abc',
          name: 'TaskCreate',
          input: { subject: 'Implement auth', activeForm: 'Implementing auth' },
        },
      }));
      // Task should NOT be visible yet (still pending result)
      expect(state.getMetrics().tasks).toHaveLength(0);

      // Phase 2: tool_result with the real task ID
      state.processEvent(makeEvent({
        type: 'tool_result',
        raw: {
          type: 'tool_result',
          tool_use_id: 'toolu_abc',
          content: 'Task #1 created successfully',
        },
      }));
      const m = state.getMetrics();
      expect(m.tasks).toHaveLength(1);
      expect(m.tasks[0].taskId).toBe('1');
      expect(m.tasks[0].subject).toBe('Implement auth');
      expect(m.tasks[0].status).toBe('pending');
    });

    it('updates task status from TaskUpdate events', () => {
      const state = new DashboardState();
      // Create task via two-phase flow
      state.processEvent(makeEvent({
        type: 'tool_use', toolName: 'TaskCreate',
        raw: { id: 'toolu_abc', name: 'TaskCreate', input: { subject: 'Fix bug' } },
      }));
      state.processEvent(makeEvent({
        type: 'tool_result',
        raw: { type: 'tool_result', tool_use_id: 'toolu_abc', content: 'Task #1 created' },
      }));
      // Update the task
      state.processEvent(makeEvent({
        type: 'tool_use', toolName: 'TaskUpdate',
        raw: { id: 'toolu_def', name: 'TaskUpdate', input: { taskId: '1', status: 'in_progress' } },
      }));
      const m = state.getMetrics();
      expect(m.tasks[0].status).toBe('in_progress');
    });

    it('handles TaskUpdate for unknown task by creating placeholder', () => {
      const state = new DashboardState();
      state.processEvent(makeEvent({
        type: 'tool_use', toolName: 'TaskUpdate',
        raw: { id: 'toolu_xyz', name: 'TaskUpdate', input: { taskId: '5', status: 'in_progress', subject: 'Imported task' } },
      }));
      const m = state.getMetrics();
      expect(m.tasks).toHaveLength(1);
      expect(m.tasks[0].taskId).toBe('5');
      expect(m.tasks[0].subject).toBe('Imported task');
      expect(m.tasks[0].status).toBe('in_progress');
    });

    it('removes tasks with deleted status', () => {
      const state = new DashboardState();
      // Create task
      state.processEvent(makeEvent({
        type: 'tool_use', toolName: 'TaskCreate',
        raw: { id: 'toolu_abc', name: 'TaskCreate', input: { subject: 'Temp task' } },
      }));
      state.processEvent(makeEvent({
        type: 'tool_result',
        raw: { type: 'tool_result', tool_use_id: 'toolu_abc', content: 'Task #1 created' },
      }));
      expect(state.getMetrics().tasks).toHaveLength(1);

      // Delete it
      state.processEvent(makeEvent({
        type: 'tool_use', toolName: 'TaskUpdate',
        raw: { id: 'toolu_del', name: 'TaskUpdate', input: { taskId: '1', status: 'deleted' } },
      }));
      expect(state.getMetrics().tasks).toHaveLength(0);
    });

    it('does not count task management tools in task tool call counts', () => {
      const state = new DashboardState();
      // Create and activate a task
      state.processEvent(makeEvent({
        type: 'tool_use', toolName: 'TaskCreate',
        raw: { id: 'toolu_abc', name: 'TaskCreate', input: { subject: 'Active task' } },
      }));
      state.processEvent(makeEvent({
        type: 'tool_result',
        raw: { type: 'tool_result', tool_use_id: 'toolu_abc', content: 'Task #1 created' },
      }));
      state.processEvent(makeEvent({
        type: 'tool_use', toolName: 'TaskUpdate',
        raw: { id: 'toolu_upd', name: 'TaskUpdate', input: { taskId: '1', status: 'in_progress' } },
      }));

      // Do some real work
      state.processEvent(makeEvent({
        type: 'tool_use', toolName: 'Read',
        raw: { id: 'toolu_r1', name: 'Read', input: { file_path: '/foo.ts' } },
      }));
      state.processEvent(makeEvent({
        type: 'tool_use', toolName: 'Edit',
        raw: { id: 'toolu_e1', name: 'Edit', input: { file_path: '/foo.ts' } },
      }));
      // TaskList should NOT count
      state.processEvent(makeEvent({
        type: 'tool_use', toolName: 'TaskList',
        raw: { id: 'toolu_tl', name: 'TaskList', input: {} },
      }));

      const m = state.getMetrics();
      expect(m.tasks[0].toolCallCount).toBe(2); // Read + Edit, not TaskList
    });

    it('extracts task ID from JSON-style result content', () => {
      const state = new DashboardState();
      state.processEvent(makeEvent({
        type: 'tool_use', toolName: 'TaskCreate',
        raw: { id: 'toolu_json', name: 'TaskCreate', input: { subject: 'JSON result' } },
      }));
      state.processEvent(makeEvent({
        type: 'tool_result',
        raw: { type: 'tool_result', tool_use_id: 'toolu_json', content: '{"taskId": "42", "status": "pending"}' },
      }));
      const m = state.getMetrics();
      expect(m.tasks).toHaveLength(1);
      expect(m.tasks[0].taskId).toBe('42');
    });
  });

  describe('file touch extraction', () => {
    it('tracks file reads, writes, edits', () => {
      const state = new DashboardState();
      state.processEvent(makeEvent({
        type: 'tool_use', toolName: 'Read',
        raw: { id: 'tu1', name: 'Read', input: { file_path: '/src/foo.ts' } },
      }));
      state.processEvent(makeEvent({
        type: 'tool_use', toolName: 'Read',
        raw: { id: 'tu2', name: 'Read', input: { file_path: '/src/foo.ts' } },
      }));
      state.processEvent(makeEvent({
        type: 'tool_use', toolName: 'Edit',
        raw: { id: 'tu3', name: 'Edit', input: { file_path: '/src/foo.ts' } },
      }));
      state.processEvent(makeEvent({
        type: 'tool_use', toolName: 'Write',
        raw: { id: 'tu4', name: 'Write', input: { file_path: '/src/bar.ts' } },
      }));
      const m = state.getMetrics();
      const foo = m.fileTouches.find(f => f.path === '/src/foo.ts');
      expect(foo?.reads).toBe(2);
      expect(foo?.edits).toBe(1);
      const bar = m.fileTouches.find(f => f.path === '/src/bar.ts');
      expect(bar?.writes).toBe(1);
    });
  });

  describe('subagent extraction', () => {
    it('tracks Task tool_use as subagent spawns with running status', () => {
      const state = new DashboardState();
      state.processEvent(makeEvent({
        type: 'tool_use', toolName: 'Task',
        raw: {
          id: 'tu1', name: 'Task',
          input: { description: 'Search auth patterns', subagent_type: 'Explore' },
        },
      }));
      const m = state.getMetrics();
      expect(m.subagents).toHaveLength(1);
      expect(m.subagents[0].subagentType).toBe('Explore');
      expect(m.subagents[0].id).toBe('tu1');
      expect(m.subagents[0].status).toBe('running');
    });

    it('completes subagent on tool_result with duration', () => {
      const state = new DashboardState();
      state.processEvent(makeEvent({
        type: 'tool_use', toolName: 'Task',
        timestamp: '2025-01-01T00:00:00Z',
        raw: {
          id: 'tu1', name: 'Task',
          input: { description: 'Explore codebase', subagent_type: 'Explore' },
        },
      }));
      expect(state.getMetrics().subagents[0].status).toBe('running');

      state.processEvent(makeEvent({
        type: 'tool_result',
        timestamp: '2025-01-01T00:00:05Z',
        raw: { type: 'tool_result', tool_use_id: 'tu1', content: 'Done' },
      }));
      const m = state.getMetrics();
      expect(m.subagents[0].status).toBe('completed');
      expect(m.subagents[0].completionTime).toBe('2025-01-01T00:00:05Z');
      expect(m.subagents[0].durationMs).toBe(5000);
    });

    it('detects parallel subagents with overlapping lifetimes', () => {
      const state = new DashboardState();
      // Agent A: 00:00 → 00:10
      state.processEvent(makeEvent({
        type: 'tool_use', toolName: 'Task',
        timestamp: '2025-01-01T00:00:00Z',
        raw: { id: 'a1', name: 'Task', input: { description: 'Agent A', subagent_type: 'Explore' } },
      }));
      // Agent B: 00:02 → 00:08 (overlaps with A)
      state.processEvent(makeEvent({
        type: 'tool_use', toolName: 'Task',
        timestamp: '2025-01-01T00:00:02Z',
        raw: { id: 'a2', name: 'Task', input: { description: 'Agent B', subagent_type: 'Bash' } },
      }));
      // Complete B first
      state.processEvent(makeEvent({
        type: 'tool_result',
        timestamp: '2025-01-01T00:00:08Z',
        raw: { type: 'tool_result', tool_use_id: 'a2', content: 'Done' },
      }));
      // Complete A
      state.processEvent(makeEvent({
        type: 'tool_result',
        timestamp: '2025-01-01T00:00:10Z',
        raw: { type: 'tool_result', tool_use_id: 'a1', content: 'Done' },
      }));
      const m = state.getMetrics();
      expect(m.subagents).toHaveLength(2);
      expect(m.subagents[0].isParallel).toBe(true);
      expect(m.subagents[1].isParallel).toBe(true);
    });

    it('does not flag non-overlapping agents as parallel', () => {
      const state = new DashboardState();
      // Agent A: 00:00 → 00:05
      state.processEvent(makeEvent({
        type: 'tool_use', toolName: 'Task',
        timestamp: '2025-01-01T00:00:00Z',
        raw: { id: 'a1', name: 'Task', input: { description: 'Agent A', subagent_type: 'Explore' } },
      }));
      state.processEvent(makeEvent({
        type: 'tool_result',
        timestamp: '2025-01-01T00:00:05Z',
        raw: { type: 'tool_result', tool_use_id: 'a1', content: 'Done' },
      }));
      // Agent B: 00:06 → 00:10 (after A)
      state.processEvent(makeEvent({
        type: 'tool_use', toolName: 'Task',
        timestamp: '2025-01-01T00:00:06Z',
        raw: { id: 'a2', name: 'Task', input: { description: 'Agent B', subagent_type: 'Bash' } },
      }));
      state.processEvent(makeEvent({
        type: 'tool_result',
        timestamp: '2025-01-01T00:00:10Z',
        raw: { type: 'tool_result', tool_use_id: 'a2', content: 'Done' },
      }));
      const m = state.getMetrics();
      expect(m.subagents[0].isParallel).toBe(false);
      expect(m.subagents[1].isParallel).toBe(false);
    });
  });

  describe('provider extraction', () => {
    it('extracts provider from first event', () => {
      const state = new DashboardState();
      state.processEvent(makeEvent({ providerId: 'claude-code' as const }));
      const m = state.getMetrics();
      expect(m.providerId).toBe('claude-code');
      expect(m.providerName).toBe('Claude Code');
    });

    it('maps opencode provider to display name', () => {
      const state = new DashboardState();
      state.processEvent(makeEvent({ providerId: 'opencode' as const }));
      const m = state.getMetrics();
      expect(m.providerName).toBe('OpenCode');
    });

    it('maps codex provider to display name', () => {
      const state = new DashboardState();
      state.processEvent(makeEvent({ providerId: 'codex' as const }));
      const m = state.getMetrics();
      expect(m.providerName).toBe('Codex CLI');
    });
  });

  describe('event count', () => {
    it('counts all processed events', () => {
      const state = new DashboardState();
      state.processEvent(makeEvent({ type: 'user' }));
      state.processEvent(makeEvent({ type: 'assistant' }));
      state.processEvent(makeEvent({ type: 'tool_use', toolName: 'Read' }));
      expect(state.getMetrics().eventCount).toBe(3);
    });
  });
});
