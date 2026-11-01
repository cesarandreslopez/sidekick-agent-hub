/**
 * Subagent display states in the CLI dashboard: stale background agents,
 * Claude Code meta evidence, Codex lifecycles, and their rendering.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CodexRolloutParser,
  toFollowEvents,
  type FollowEvent,
  type SubagentStats,
} from 'sidekick-shared';
import { DashboardState, summarizeSubagentStates } from './DashboardState';
import { applyClaudeSubagentMeta } from './subagentEvidence';
import { SessionsPanel } from './panels/SessionsPanel';
import { buildMindMapTree } from './MindMapBuilder';
import type { PanelItem } from './panels/types';
import type { StaticData } from './StaticDataLoader';

const SPAWN_TS = '2026-10-12T20:00:00.000Z';
const LAUNCH_TS = '2026-10-12T20:00:01.000Z';

function follow(state: DashboardState, event: Partial<FollowEvent>): void {
  state.processEvent({
    providerId: 'claude-code',
    type: 'system',
    timestamp: SPAWN_TS,
    summary: '',
    ...event,
  } as FollowEvent);
}

/** A parent that launched background agents `a`, `b`, … (agent ids `a<name>…`). */
function withBackgroundAgents(...names: string[]): DashboardState {
  const state = new DashboardState();
  for (const name of names) {
    follow(state, {
      type: 'tool_use',
      toolName: 'Agent',
      timestamp: SPAWN_TS,
      raw: {
        id: `toolu_${name}`,
        input: { description: `Agent ${name}`, subagent_type: 'general-purpose' },
      },
    });
    follow(state, {
      type: 'tool_result',
      timestamp: LAUNCH_TS,
      raw: {
        tool_use_id: `toolu_${name}`,
        content: `Async agent launched successfully.\nagentId: a${name}000 (internal)`,
      },
    });
  }
  return state;
}

function stats(agentId: string, endTime: string, endedCleanly: boolean): SubagentStats {
  return {
    agentId,
    toolCalls: [],
    inputTokens: 1,
    outputTokens: 1,
    totalTokens: 2,
    startTime: new Date(LAUNCH_TS),
    endTime: new Date(endTime),
    endedCleanly,
  };
}

const roots: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('CLI subagent display states', () => {
  it('carries outcome, background, agentId, and the display state', () => {
    vi.useFakeTimers({ now: Date.parse('2026-10-12T20:10:00.000Z') });
    const state = withBackgroundAgents('a', 'b', 'c');
    state.setSubagentStats([
      stats('aa000', '2026-10-12T20:05:00.000Z', true),
      stats('ab000', '2026-10-12T20:09:30.000Z', false),
    ]);
    const [a, b, c] = state.getMetrics().subagents;
    expect(a).toMatchObject({
      id: 'toolu_a',
      status: 'running',
      background: true,
      agentId: 'aa000',
      displayState: 'finished-unreported',
    });
    expect(b.displayState).toBe('running');
    expect(c.displayState).toBe('running');
    expect(summarizeSubagentStates([a, b, c])).toEqual({
      running: 2,
      done: 0,
      other: [{ label: 'finished (no report)', count: 1 }],
    });

    // The agent's task items stop reading as "Running …".
    const items = state.getMetrics().tasks.filter((task) => task.subject === 'Agent a');
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(item).toMatchObject({ status: 'completed', agentState: 'finished (no report)' });
      expect(item.activeForm).toBeUndefined();
    }
    const running = state.getMetrics().tasks.filter((task) => task.subject === 'Agent b');
    expect(running.every((item) => item.status === 'in_progress' && item.activeForm)).toBe(true);
  });

  it('reads an agent as ended once the parent is idle for over 6 hours', () => {
    const state = withBackgroundAgents('a');
    state.setSubagentStats([stats('aa000', '2026-10-12T20:30:00.000Z', false)]);
    vi.useFakeTimers({ now: Date.parse('2026-10-13T04:00:00.000Z') });
    state.setSubagentStats([stats('aa000', '2026-10-12T20:30:00.000Z', false)]);
    expect(state.getMetrics().subagents[0].displayState).toBe('ended');
  });

  it('applies Claude Code meta flags from the subagents directory', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-cli-meta-'));
    roots.push(root);
    const sessionPath = path.join(root, 'session-1.jsonl');
    const dir = path.join(root, 'session-1', 'subagents');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'agent-aa000.meta.json'),
      JSON.stringify({ toolUseId: 'toolu_a', stoppedByUser: true, requestShape: 'background' }),
    );
    fs.writeFileSync(
      path.join(dir, 'agent-ab000.meta.json'),
      JSON.stringify({ toolUseId: 'toolu_b', finished: true }),
    );
    const state = withBackgroundAgents('a', 'b', 'c');
    const scanned = [
      stats('aa000', '2026-10-12T20:05:00.000Z', false),
      stats('ab000', '2026-10-12T20:06:00.000Z', true),
      stats('ac000', '2026-10-12T20:07:00.000Z', false),
    ];
    state.setSubagentStats(scanned);
    expect(applyClaudeSubagentMeta(state, sessionPath, scanned)).toBe(true);
    const [a, b, c] = state.getMetrics().subagents;
    expect(a).toMatchObject({ status: 'completed', outcome: 'stopped', displayState: 'stopped' });
    expect(b).toMatchObject({
      status: 'completed',
      outcome: 'completed',
      displayState: 'completed',
      completionTime: '2026-10-12T20:06:00.000Z',
    });
    expect(c.status).toBe('running');
    expect(applyClaudeSubagentMeta(state, sessionPath, scanned)).toBe(false);
  });

  it('renders the states distinctly in the Sessions panel and the mind map', () => {
    vi.useFakeTimers({ now: Date.parse('2026-10-12T20:10:00.000Z') });
    const state = withBackgroundAgents('a', 'b', 'c');
    state.setSubagentStats([stats('aa000', '2026-10-12T20:05:00.000Z', true)]);
    state.applySubagentEvidence({ agentId: 'ab000', stoppedByUser: true }, LAUNCH_TS);
    const metrics = state.getMetrics();

    const panel = new SessionsPanel();
    const item: PanelItem = {
      id: 'active',
      label: 'session',
      sortKey: 0,
      data: { type: 'active', metrics },
    };
    const agentsTab = panel.detailTabs.find((tab) => tab.label === 'Agents')!;
    const out = agentsTab.render(item, metrics, {} as StaticData, { width: 100 });
    expect(out).toContain('1{/bold} running');
    expect(out).toContain('1{/bold} finished (no report)');
    expect(out).toContain('1{/bold} stopped');
    expect(out).toContain('[finished (no report)]');
    expect(out).toContain('[stopped]');
    const summary = panel.detailTabs[0].render(item, metrics, { sessions: [] } as never);
    expect(summary).toContain('1 running{/green-fg}, 0 done, 1 finished (no report), 1 stopped');
    const [label] = panel.getItems(metrics, { sessions: [] } as never).map((entry) => entry.label);
    expect(label).toContain('[1⊛]');
    panel.dispose?.();

    const staticData: StaticData = {
      sessions: [],
      tasks: [],
      decisions: [],
      notes: [],
      plans: [],
      totalTokens: 0,
      totalCost: 0,
      totalSessions: 0,
    };
    const tree = buildMindMapTree(metrics, staticData);
    const text = JSON.stringify(tree);
    expect(text).toContain('Subagents (3, 1 running)');
    expect(text).toContain('(finished (no report))');
    expect(text).toContain('(stopped)');
  });
});

describe('CLI Codex subagent lifecycles', () => {
  it('flows Codex spawn and activity records through the aggregator', () => {
    vi.useFakeTimers({ now: Date.parse('2026-10-31T01:45:00.000Z') });
    const PARENT = '01a18f87-0000-7000-8000-000000000001';
    const CHILD = '01a18f9d-0000-7000-8000-000000000002';
    const rows: Array<Record<string, unknown>> = [
      {
        timestamp: '2026-10-31T01:15:00.000Z',
        type: 'session_meta',
        payload: { id: PARENT, cwd: '/work', cli_version: '0.166.0', source: 'vscode' },
      },
      {
        timestamp: '2026-10-31T01:40:33.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call',
          name: 'spawn_agent',
          namespace: 'collaboration',
          arguments: JSON.stringify({
            task_name: 'review_builder',
            message: 'x',
            agent_type: 'worker',
          }),
          call_id: 'call_spawn',
        },
      },
      {
        timestamp: '2026-10-31T01:40:33.100Z',
        type: 'event_msg',
        payload: {
          type: 'item_completed',
          thread_id: PARENT,
          turn_id: 't',
          item: {
            type: 'SubAgentActivity',
            id: 'call_spawn',
            kind: 'started',
            agent_thread_id: CHILD,
            agent_path: '/root/review_builder',
          },
        },
      },
      {
        timestamp: '2026-10-31T01:40:33.200Z',
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          call_id: 'call_spawn',
          output: '{"task_name":"/root/review_builder"}',
        },
      },
    ];
    const state = new DashboardState();
    const parser = new CodexRolloutParser({ includeSubagentActivity: true });
    const feed = (row: Record<string, unknown>) => {
      for (const event of parser.convertLine(row as never)) {
        for (const fe of toFollowEvents(event, 'codex')) state.processEvent(fe);
      }
    };
    rows.forEach(feed);
    expect(state.getMetrics().subagents).toMatchObject([
      {
        id: 'call_spawn',
        description: 'review_builder',
        subagentType: 'worker',
        status: 'running',
        background: true,
        agentId: CHILD,
        displayState: 'running',
      },
    ]);
    feed({
      timestamp: '2026-10-31T01:42:21.000Z',
      type: 'event_msg',
      payload: {
        type: 'item_completed',
        thread_id: PARENT,
        turn_id: 't',
        item: {
          type: 'SubAgentActivity',
          id: 'subagent-completed-turn-1',
          kind: 'completed',
          agent_thread_id: CHILD,
          agent_path: '/root/review_builder',
        },
      },
    });
    expect(state.getMetrics().subagents[0]).toMatchObject({
      status: 'completed',
      outcome: 'completed',
      displayState: 'completed',
    });
    // The activity summaries never read as the session ending.
    expect(
      state
        .getMetrics()
        .timeline.filter((e) => e.type === 'system' && e.summary === 'Session ended'),
    ).toEqual([]);
  });
});
