import { describe, it, expect, vi } from 'vitest';
import { MindMapDataService } from './MindMapDataService';
import type { SessionStats, PlanState, TaskState, TrackedTask } from '../types/claudeSession';

// Mock vscode module (required by Logger.ts)
vi.mock('vscode', () => ({
  window: {
    createOutputChannel: vi.fn(() => ({
      appendLine: vi.fn(),
      show: vi.fn(),
      dispose: vi.fn(),
    })),
  },
  workspace: {
    getConfiguration: vi.fn(() => ({
      get: vi.fn(),
    })),
  },
}));

function makeEmptyStats(overrides?: Partial<SessionStats>): SessionStats {
  return {
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheWriteTokens: 0,
    totalCacheReadTokens: 0,
    messageCount: 1,
    toolCalls: [],
    modelUsage: new Map(),
    lastUpdated: new Date(),
    toolAnalytics: new Map(),
    timeline: [],
    errorDetails: new Map(),
    currentContextSize: 0,
    recentUsageEvents: [],
    sessionStartTime: new Date(),
    ...overrides,
  };
}

function makePlanState(overrides?: Partial<PlanState>): PlanState {
  return {
    active: false,
    steps: [
      { id: 'step-0', description: 'Read existing code', status: 'completed' },
      { id: 'step-1', description: 'Implement feature', status: 'in_progress' },
      { id: 'step-2', description: 'Write tests', status: 'pending' },
    ],
    title: 'Implementation Plan',
    source: 'claude-code',
    ...overrides,
  };
}

function makeTask(id: string, subject: string, status: 'pending' | 'in_progress' | 'completed' = 'pending'): TrackedTask {
  return {
    taskId: id,
    subject,
    status,
    createdAt: new Date(),
    updatedAt: new Date(),
    blockedBy: [],
    blocks: [],
    associatedToolCalls: [],
  };
}

describe('MindMapDataService', () => {
  describe('buildGraph with planState', () => {
    it('should create plan root and plan-step nodes', () => {
      const stats = makeEmptyStats({ planState: makePlanState() });
      const graph = MindMapDataService.buildGraph(stats);

      // Should have: session-root + plan-root + 3 plan-step nodes
      expect(graph.nodes.length).toBe(5);

      const planRoot = graph.nodes.find(n => n.id === 'plan-root');
      expect(planRoot).toBeDefined();
      expect(planRoot!.type).toBe('plan');
      expect(planRoot!.label).toBe('Implementation Plan');
      expect(planRoot!.count).toBe(3);

      const step0 = graph.nodes.find(n => n.id === 'plan-step-0');
      expect(step0).toBeDefined();
      expect(step0!.type).toBe('plan-step');
      expect(step0!.planStepStatus).toBe('completed');

      const step1 = graph.nodes.find(n => n.id === 'plan-step-1');
      expect(step1!.planStepStatus).toBe('in_progress');

      const step2 = graph.nodes.find(n => n.id === 'plan-step-2');
      expect(step2!.planStepStatus).toBe('pending');
    });

    it('should link plan root to session root', () => {
      const stats = makeEmptyStats({ planState: makePlanState() });
      const graph = MindMapDataService.buildGraph(stats);

      const rootLink = graph.links.find(
        l => l.source === 'session-root' && l.target === 'plan-root'
      );
      expect(rootLink).toBeDefined();
    });

    it('should link steps to plan root', () => {
      const stats = makeEmptyStats({ planState: makePlanState() });
      const graph = MindMapDataService.buildGraph(stats);

      for (let i = 0; i < 3; i++) {
        const link = graph.links.find(
          l => l.source === 'plan-root' && l.target === `plan-step-${i}`
        );
        expect(link).toBeDefined();
      }
    });

    it('should create sequential plan-sequence links', () => {
      const stats = makeEmptyStats({ planState: makePlanState() });
      const graph = MindMapDataService.buildGraph(stats);

      const seqLink01 = graph.links.find(
        l => l.source === 'plan-step-0' && l.target === 'plan-step-1' && l.linkType === 'plan-sequence'
      );
      expect(seqLink01).toBeDefined();

      const seqLink12 = graph.links.find(
        l => l.source === 'plan-step-1' && l.target === 'plan-step-2' && l.linkType === 'plan-sequence'
      );
      expect(seqLink12).toBeDefined();
    });

    it('should not create plan nodes when planState has no steps', () => {
      const stats = makeEmptyStats({
        planState: { active: false, steps: [], source: 'claude-code' },
      });
      const graph = MindMapDataService.buildGraph(stats);

      expect(graph.nodes.find(n => n.id === 'plan-root')).toBeUndefined();
    });

    it('should use default label when no title', () => {
      const stats = makeEmptyStats({
        planState: makePlanState({ title: undefined }),
      });
      const graph = MindMapDataService.buildGraph(stats);

      const planRoot = graph.nodes.find(n => n.id === 'plan-root');
      expect(planRoot!.label).toBe('Plan');
    });

    it('should include phase in step labels', () => {
      const stats = makeEmptyStats({
        planState: makePlanState({
          steps: [
            { id: 'step-0', description: 'Setup', status: 'pending', phase: 'Init' },
          ],
        }),
      });
      const graph = MindMapDataService.buildGraph(stats);

      const step = graph.nodes.find(n => n.id === 'plan-step-0');
      expect(step!.label).toBe('[Init] Setup');
    });
  });

  describe('plan-to-task cross-references', () => {
    it('should link plan steps to matching task nodes via fuzzy match', () => {
      const taskState: TaskState = {
        tasks: new Map([
          ['1', makeTask('1', 'Implement feature', 'in_progress')],
        ]),
        activeTaskId: '1',
      };

      const stats = makeEmptyStats({
        taskState,
        planState: makePlanState(),
      });
      const graph = MindMapDataService.buildGraph(stats);

      // step-1 ("Implement feature") should link to task-1 ("Implement feature")
      const crossRef = graph.links.find(
        l => l.source === 'plan-step-1' && l.target === 'task-1' && l.linkType === 'task-action'
      );
      expect(crossRef).toBeDefined();
    });

    it('should link Codex plan steps to matching plan-{i} task nodes by index', () => {
      const taskState: TaskState = {
        tasks: new Map([
          ['plan-0', makeTask('plan-0', 'Read code', 'completed')],
          ['plan-1', makeTask('plan-1', 'Write code', 'in_progress')],
        ]),
        activeTaskId: 'plan-1',
      };

      const stats = makeEmptyStats({
        taskState,
        planState: makePlanState({
          source: 'codex',
          steps: [
            { id: 'step-0', description: 'Read code', status: 'completed' },
            { id: 'step-1', description: 'Write code', status: 'in_progress' },
          ],
        }),
      });
      const graph = MindMapDataService.buildGraph(stats);

      const crossRef0 = graph.links.find(
        l => l.source === 'plan-step-0' && l.target === 'task-plan-0' && l.linkType === 'task-action'
      );
      expect(crossRef0).toBeDefined();

      const crossRef1 = graph.links.find(
        l => l.source === 'plan-step-1' && l.target === 'task-plan-1' && l.linkType === 'task-action'
      );
      expect(crossRef1).toBeDefined();
    });
  });

  describe('buildGraph link/node counts', () => {
    it('should produce correct counts for a plan with 3 steps', () => {
      const stats = makeEmptyStats({ planState: makePlanState() });
      const graph = MindMapDataService.buildGraph(stats);

      // Nodes: session-root + plan-root + 3 steps = 5
      expect(graph.nodes.length).toBe(5);

      // Links:
      // session-root -> plan-root (1)
      // plan-root -> step-0, step-1, step-2 (3)
      // step-0 -> step-1, step-1 -> step-2 (2 sequence links)
      // Total: 6
      expect(graph.links.length).toBe(6);
    });
  });
});
