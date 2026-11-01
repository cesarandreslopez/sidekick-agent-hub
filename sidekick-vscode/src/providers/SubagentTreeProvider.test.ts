import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { MockTreeItem, MockThemeIcon, MockEventEmitter } = vi.hoisted(() => ({
  MockTreeItem: class {
    label: string;
    collapsibleState: number;
    description?: string;
    iconPath?: unknown;
    tooltip?: unknown;
    command?: { command: string; arguments?: unknown[] };
    constructor(label: string, collapsibleState: number) {
      this.label = label;
      this.collapsibleState = collapsibleState;
    }
  },
  MockThemeIcon: class {
    constructor(public id: string) {}
  },
  MockEventEmitter: class<T> {
    private listeners = new Set<(value: T) => void>();
    event = (listener: (value: T) => void) => {
      this.listeners.add(listener);
      return { dispose: () => this.listeners.delete(listener) };
    };
    fire(value: T): void {
      for (const listener of this.listeners) listener(value);
    }
    dispose(): void {
      this.listeners.clear();
    }
  },
}));

vi.mock('vscode', () => ({
  TreeItem: MockTreeItem,
  ThemeIcon: MockThemeIcon,
  EventEmitter: MockEventEmitter,
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  Uri: { file: (fsPath: string) => ({ fsPath }) },
}));

import {
  EventAggregator,
  type SessionEvent,
  type SubagentDisplayTrace,
  type SubagentEvidence,
  type SubagentStats,
  type TimelineEvent,
} from 'sidekick-shared';
import { SubagentTreeProvider } from './SubagentTreeProvider';
import type { SessionMonitor } from '../services/SessionMonitor';

const SESSION_ID = 'session-1';
const AGENT_ID = 'a1b2c3d4e5f6a7b8c';
const SPAWN_ID = 'toolu_spawn';

/** The parts of SessionMonitor the tree reads, over a real shared aggregator. */
class FakeSessionMonitor {
  readonly aggregator: EventAggregator;
  private readonly sessionStart = new MockEventEmitter<string>();
  private readonly timeline = new MockEventEmitter<TimelineEvent>();
  private readonly subagentsChanged = new MockEventEmitter<void>();
  readonly onSessionStart = this.sessionStart.event;
  readonly onTimelineEvent = this.timeline.event;
  readonly onSubagentsChanged = this.subagentsChanged.event;
  traceFacts = new Map<string, SubagentDisplayTrace>();
  subagentStats: SubagentStats[] = [];
  evidenceCalls = 0;

  constructor(
    private readonly sessionPath: string | null,
    private readonly sessionId: string | null,
    private readonly providerId: 'claude-code' | 'codex' = 'claude-code',
  ) {
    this.aggregator = new EventAggregator({ providerId });
  }

  getProvider() {
    return { id: this.providerId };
  }
  applySubagentEvidence(evidence: SubagentEvidence, timestamp: string): boolean {
    this.evidenceCalls++;
    const changed = this.aggregator.applySubagentEvidence(evidence, timestamp);
    if (changed) this.subagentsChanged.fire();
    return changed;
  }
  setSubagentTraceFacts(facts: ReadonlyMap<string, SubagentDisplayTrace>): void {
    this.traceFacts = new Map(facts);
  }
  fireSubagentsChanged(): void {
    this.subagentsChanged.fire();
  }

  getSessionPath(): string | null {
    return this.sessionPath;
  }
  getSessionId(): string | null {
    return this.sessionId;
  }
  getAggregatedMetrics() {
    return this.aggregator.getMetrics();
  }
  getSubagentStats() {
    return this.subagentStats;
  }

  /** Feeds a session event, then fires the timeline event SessionMonitor would. */
  ingest(event: SessionEvent, timeline?: Partial<TimelineEvent>): void {
    this.aggregator.processEvent(event);
    if (timeline) {
      this.timeline.fire({
        type: 'tool_result',
        timestamp: event.timestamp,
        description: '',
        ...timeline,
      } as TimelineEvent);
    }
  }

  startSession(): void {
    if (this.sessionPath) this.sessionStart.fire(this.sessionPath);
  }
}

function spawnEvent(name = 'Agent', id = SPAWN_ID): SessionEvent {
  return {
    type: 'assistant',
    timestamp: '2026-11-01T03:00:00.000Z',
    message: {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id,
          name,
          input: { description: 'Explore auth flow', subagent_type: 'Explore' },
        },
      ],
    },
  };
}

function resultEvent(content: unknown, id = SPAWN_ID): SessionEvent {
  return {
    type: 'user',
    timestamp: '2026-11-01T03:00:01.000Z',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] },
  };
}

const launchResult = [
  {
    type: 'text',
    text: `Async agent launched successfully.\nagentId: ${AGENT_ID} (internal ID - do not mention to user.)\nThe agent is working in the background.`,
  },
];

function notificationEvent(): SessionEvent {
  return {
    type: 'user',
    timestamp: '2026-11-01T03:05:00.000Z',
    origin: { kind: 'task-notification' },
    message: {
      role: 'user',
      content: `<task-notification>\n<task-id>${AGENT_ID}</task-id>\n<tool-use-id>${SPAWN_ID}</tool-use-id>\n<status>completed</status>\n<summary>Agent "Explore auth flow" finished</summary>\n<result>Done.</result>\n</task-notification>`,
    },
  };
}

let root: string;
let sessionDir: string;
let sessionPath: string;
let providers: SubagentTreeProvider[] = [];

function subagentsDir(): string {
  return path.join(sessionDir, SESSION_ID, 'subagents');
}

function writeTrace(agentId: string, meta: Record<string, unknown>, lines: unknown[]): string {
  fs.mkdirSync(subagentsDir(), { recursive: true });
  const file = path.join(subagentsDir(), `agent-${agentId}.jsonl`);
  fs.writeFileSync(file, lines.map((line) => JSON.stringify(line)).join('\n') + '\n');
  fs.writeFileSync(path.join(subagentsDir(), `agent-${agentId}.meta.json`), JSON.stringify(meta));
  return file;
}

function traceLines(stopReason: string | null = 'end_turn'): unknown[] {
  return [
    {
      type: 'user',
      timestamp: '2026-11-01T03:00:02.000Z',
      message: { role: 'user', content: 'Explore the auth flow' },
    },
    {
      type: 'assistant',
      timestamp: '2026-11-01T03:04:00.000Z',
      message: {
        role: 'assistant',
        id: 'msg_1',
        model: 'claude-sonnet-4-5',
        stop_reason: stopReason,
        usage: { input_tokens: 100, output_tokens: 50 },
        content: [{ type: 'text', text: 'Auth flow mapped.' }],
      },
    },
  ];
}

/** The tests' clock: shortly after the fixtures' events. */
let now = Date.parse('2026-11-01T03:06:00.000Z');

function create(
  monitor: FakeSessionMonitor,
  options: { pollIntervalMs?: number } = {},
): SubagentTreeProvider {
  const provider = new SubagentTreeProvider(monitor as unknown as SessionMonitor, {
    minRescanIntervalMs: 0,
    now: () => now,
    ...options,
  });
  providers.push(provider);
  return provider;
}

beforeEach(() => {
  now = Date.parse('2026-11-01T03:06:00.000Z');
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-subagent-tree-'));
  sessionDir = path.join(root, 'project');
  fs.mkdirSync(sessionDir, { recursive: true });
  sessionPath = path.join(sessionDir, `${SESSION_ID}.jsonl`);
  fs.writeFileSync(sessionPath, '');
});

afterEach(() => {
  for (const provider of providers) provider.dispose();
  providers = [];
  fs.rmSync(root, { recursive: true, force: true });
});

describe('SubagentTreeProvider', () => {
  it('shows one running row for an Agent spawn', () => {
    const monitor = new FakeSessionMonitor(sessionPath, SESSION_ID);
    const provider = create(monitor);
    monitor.ingest(spawnEvent(), {
      type: 'tool_call',
      description: 'Agent: Subagent spawned: Explore auth flow',
      metadata: { toolName: 'Agent', toolUseId: SPAWN_ID },
    });

    const rows = provider.getChildren();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: SPAWN_ID,
      type: 'running',
      agentType: 'Explore',
      label: 'Explore auth flow (Explore)',
    });
    expect(rows[0].label).not.toMatch(/live-worker/);
    expect(provider.getTreeItem(rows[0]).description).toBe('Running...');
  });

  it('keeps a background agent running after its async-launch result', () => {
    const monitor = new FakeSessionMonitor(sessionPath, SESSION_ID);
    const provider = create(monitor);
    monitor.ingest(spawnEvent(), { type: 'tool_call', metadata: { toolName: 'Agent' } });
    monitor.ingest(resultEvent(launchResult), { metadata: { toolName: 'Agent' } });

    const rows = provider.getChildren();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      type: 'running',
      agentId: AGENT_ID,
      label: 'a1b2c3d4 (Explore)',
    });
  });

  it('completes the row when the task notification arrives', () => {
    const monitor = new FakeSessionMonitor(sessionPath, SESSION_ID);
    const provider = create(monitor);
    monitor.ingest(spawnEvent(), { type: 'tool_call', metadata: { toolName: 'Agent' } });
    monitor.ingest(resultEvent(launchResult), { metadata: { toolName: 'Agent' } });
    monitor.ingest(notificationEvent(), {
      description: 'Agent "Explore auth flow" finished',
      noiseLevel: 'system',
      metadata: { toolName: 'Agent', toolUseId: SPAWN_ID },
    });

    const rows = provider.getChildren();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ type: 'completed', durationMs: 300_000 });
    const item = provider.getTreeItem(rows[0]);
    expect((item.iconPath as { id: string }).id).toBe('check');
    expect(item.description).toBe('5m 0s');
  });

  it('enriches the spawn row from its transcript instead of adding another', () => {
    const monitor = new FakeSessionMonitor(sessionPath, SESSION_ID);
    const provider = create(monitor);
    monitor.ingest(spawnEvent(), { type: 'tool_call', metadata: { toolName: 'Agent' } });
    monitor.ingest(resultEvent(launchResult), { metadata: { toolName: 'Agent' } });
    expect(provider.getChildren()).toHaveLength(1);

    const transcript = writeTrace(
      AGENT_ID,
      {
        agentType: 'Explore',
        description: 'Explore auth flow',
        toolUseId: SPAWN_ID,
        requestShape: 'background',
      },
      traceLines(),
    );
    monitor.ingest(notificationEvent(), {
      metadata: { toolName: 'Agent', toolUseId: SPAWN_ID },
    });

    const rows = provider.getChildren();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: SPAWN_ID,
      agentId: AGENT_ID,
      label: 'a1b2c3d4 (Explore)',
      type: 'completed',
      transcriptPath: transcript,
      totalTokens: 150,
    });
    const item = provider.getTreeItem(rows[0]);
    expect(item.command).toMatchObject({
      command: 'vscode.open',
      arguments: [{ fsPath: transcript }],
    });
    expect(item.description).toBe('150 tok | 5m 0s');
  });

  it('opens the subagents-layout transcript while the agent is still running', () => {
    const monitor = new FakeSessionMonitor(sessionPath, SESSION_ID);
    const transcript = writeTrace(
      AGENT_ID,
      { agentType: 'Explore', toolUseId: SPAWN_ID, requestShape: 'background' },
      traceLines(null).slice(0, 1),
    );
    monitor.aggregator.processEvent(spawnEvent());
    monitor.aggregator.processEvent(resultEvent(launchResult));
    const provider = create(monitor);

    const [row] = provider.getChildren();
    expect(row).toMatchObject({ type: 'running', transcriptPath: transcript });
    expect(provider.getTreeItem(row).command?.arguments).toEqual([{ fsPath: transcript }]);
  });

  it('still tracks Task spawns, completing a foreground one on its result', () => {
    const monitor = new FakeSessionMonitor(sessionPath, SESSION_ID);
    const provider = create(monitor);
    monitor.ingest(spawnEvent('Task', 'toolu_task'), {
      type: 'tool_call',
      metadata: { toolName: 'Task' },
    });
    expect(provider.getChildren()[0]).toMatchObject({ id: 'toolu_task', type: 'running' });

    monitor.ingest(resultEvent('Found the auth module.', 'toolu_task'), {
      metadata: { toolName: 'Task' },
    });
    const rows = provider.getChildren();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ type: 'completed', outcome: 'completed' });
  });

  it('nests a child spawned by a subagent and rebuilds on session start', () => {
    const monitor = new FakeSessionMonitor(sessionPath, SESSION_ID);
    monitor.aggregator.processEvent(spawnEvent());
    monitor.aggregator.processEvent(resultEvent(launchResult));
    monitor.aggregator.processEvent(notificationEvent());
    writeTrace(
      AGENT_ID,
      { agentType: 'Explore', toolUseId: SPAWN_ID, requestShape: 'background', finished: true },
      traceLines(),
    );
    const child = writeTrace(
      'c0ffee00c0ffee00c',
      {
        agentType: 'general-purpose',
        toolUseId: 'toolu_nested',
        parentAgentId: AGENT_ID,
        requestShape: 'foreground',
      },
      traceLines(),
    );
    const provider = create(new FakeSessionMonitor(null, null));
    expect(provider.getChildren()).toEqual([]);

    // The real monitor fires onSessionStart once replay finishes.
    const live = create(monitor);
    monitor.startSession();
    const [parent] = live.getChildren();
    expect(parent).toMatchObject({ id: SPAWN_ID, type: 'completed' });
    expect(parent.children).toHaveLength(1);
    expect(parent.children[0]).toMatchObject({
      agentId: 'c0ffee00c0ffee00c',
      label: 'c0ffee00 (Task)',
      type: 'completed',
      transcriptPath: child,
    });
    expect(live.getChildren(parent)).toBe(parent.children);
    expect(live.getTreeItem(parent).description).toContain('1 child');
  });

  it('falls back to the flat transcript layout of older sessions', () => {
    const monitor = new FakeSessionMonitor(sessionPath, SESSION_ID);
    const flat = path.join(sessionDir, 'agent-0ld0ld0ld.jsonl');
    fs.writeFileSync(flat, JSON.stringify(traceLines()[1]) + '\n');
    const provider = create(monitor);

    const rows = provider.getChildren();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: '0ld0ld0ld', type: 'completed', transcriptPath: flat });
  });

  it('reads an interim-only agent that ended cleanly as finished (no report), then running on resume', () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
    try {
      const monitor = new FakeSessionMonitor(sessionPath, SESSION_ID);
      monitor.aggregator.processEvent(spawnEvent());
      monitor.aggregator.processEvent(resultEvent(launchResult));
      const transcript = writeTrace(
        AGENT_ID,
        { agentType: 'Explore', toolUseId: SPAWN_ID, requestShape: 'background' },
        traceLines(),
      );
      now = Date.parse('2026-11-01T03:04:30.000Z');
      const provider = create(monitor, { pollIntervalMs: 15_000 });
      expect(provider.getChildren()[0]).toMatchObject({ type: 'running', displayState: 'running' });

      // Quiet for two minutes after its clean end: the next poll says so.
      now = Date.parse('2026-11-01T03:06:00.000Z');
      vi.advanceTimersByTime(15_000);
      const [row] = provider.getChildren();
      expect(row).toMatchObject({ type: 'running', displayState: 'finished-unreported' });
      const item = provider.getTreeItem(row);
      expect((item.iconPath as { id: string }).id).toBe('pass');
      expect(item.description).toContain('finished (no report)');
      expect(monitor.traceFacts.get(SPAWN_ID)).toMatchObject({ endedCleanly: true });

      // SendMessage resumed it: a new prompt lands in the transcript.
      fs.appendFileSync(
        transcript,
        JSON.stringify({
          type: 'user',
          timestamp: '2026-11-01T03:06:10.000Z',
          message: { role: 'user', content: 'One more thing.' },
        }) + '\n',
      );
      now = Date.parse('2026-11-01T03:06:15.000Z');
      vi.advanceTimersByTime(15_000);
      expect(provider.getChildren()[0].displayState).toBe('running');
    } finally {
      vi.useRealTimers();
    }
  });

  it('settles a silent UI stop from the meta flags', () => {
    const monitor = new FakeSessionMonitor(sessionPath, SESSION_ID);
    monitor.aggregator.processEvent(spawnEvent());
    monitor.aggregator.processEvent(resultEvent(launchResult));
    writeTrace(
      AGENT_ID,
      {
        agentType: 'Explore',
        toolUseId: SPAWN_ID,
        requestShape: 'background',
        stoppedByUser: true,
      },
      traceLines(null).slice(0, 1),
    );
    const provider = create(monitor);
    const [row] = provider.getChildren();
    expect(row).toMatchObject({ type: 'completed', outcome: 'stopped', displayState: 'stopped' });
    expect(monitor.aggregator.getSubagents()[0]).toMatchObject({
      outcome: 'stopped',
      settledBy: 'meta',
    });
    const item = provider.getTreeItem(row);
    expect((item.iconPath as { id: string }).id).toBe('debug-stop');
    expect(item.description).toContain('stopped');
  });

  it('reads an agent killed mid-work as ended once the parent is idle for 6 hours, and stops polling', () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
    try {
      const monitor = new FakeSessionMonitor(sessionPath, SESSION_ID);
      monitor.aggregator.processEvent(spawnEvent());
      monitor.aggregator.processEvent(resultEvent(launchResult));
      writeTrace(
        AGENT_ID,
        { agentType: 'Explore', toolUseId: SPAWN_ID, requestShape: 'background' },
        [traceLines()[0], { ...(traceLines('tool_use')[1] as object) }],
      );
      const provider = create(monitor, { pollIntervalMs: 15_000 });
      expect(provider.getChildren()[0].displayState).toBe('running');
      expect(vi.getTimerCount()).toBe(1);

      now = Date.parse('2026-11-01T09:30:00.000Z');
      vi.advanceTimersByTime(15_000);
      const [row] = provider.getChildren();
      expect(row.displayState).toBe('ended');
      expect((provider.getTreeItem(row).iconPath as { id: string }).id).toBe('circle-slash');
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears its poll timer on dispose', () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
    try {
      const monitor = new FakeSessionMonitor(sessionPath, SESSION_ID);
      monitor.aggregator.processEvent(spawnEvent());
      const provider = create(monitor, { pollIntervalMs: 15_000 });
      expect(vi.getTimerCount()).toBe(1);
      provider.dispose();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('SubagentTreeProvider (Codex)', () => {
  const PARENT_ID = '01a18f87-0000-7000-8000-000000000001';
  const CHILD_ID = '01a18f9d-0000-7000-8000-000000000002';
  const SIBLING_ID = '01a18f9d-0000-7000-8000-000000000009';
  const GRANDCHILD_ID = '01a18fa0-0000-7000-8000-000000000003';

  function codexEvent(
    timestamp: string,
    content: unknown[],
    type: 'assistant' | 'user' = 'assistant',
  ): SessionEvent {
    return { type, timestamp, message: { role: type, content } } as SessionEvent;
  }
  function spawn(callId: string, taskName: string, agentType?: string): SessionEvent {
    return codexEvent('2026-10-31T01:40:33.000Z', [
      {
        type: 'tool_use',
        id: callId,
        name: 'Spawn_agent',
        input: {
          task_name: taskName,
          message: 'gAAAA',
          ...(agentType ? { agent_type: agentType } : {}),
          _sidekickRawToolName: 'spawn_agent',
        },
      },
    ]);
  }
  function activity(timestamp: string, block: Record<string, unknown>): SessionEvent {
    return {
      type: 'system',
      timestamp,
      origin: { kind: 'subagent-activity' },
      message: {
        role: 'system',
        id: `subagent-activity:${String(block.callId ?? block.kind)}`,
        sourceLabel: 'subagent activity',
        content: [{ type: 'subagent_activity', ...block }],
      },
    };
  }

  function childStats(file: string): SubagentStats[] {
    const base = { toolCalls: [], inputTokens: 10, outputTokens: 5, totalTokens: 15 };
    return [
      {
        ...base,
        agentId: CHILD_ID,
        description: 'Banach',
        filePath: file,
        spawnToolUseId: 'call_spawn_builder',
        agentNickname: 'Banach',
        agentPath: '/root/review_builder',
        parentAgentId: PARENT_ID,
        depth: 1,
        startTime: new Date('2026-10-31T01:40:33.000Z'),
        endTime: new Date('2026-10-31T01:42:20.000Z'),
        endedCleanly: true,
      },
      {
        ...base,
        agentId: SIBLING_ID,
        description: 'Hopper',
        filePath: file + '.sibling',
        spawnToolUseId: 'call_spawn_infra',
        agentNickname: 'Hopper',
        agentPath: '/root/review_infra',
        parentAgentId: PARENT_ID,
        depth: 1,
        endTime: new Date('2026-10-31T01:42:00.000Z'),
      },
      {
        ...base,
        agentId: GRANDCHILD_ID,
        agentType: 'explorer',
        description: 'Noether',
        filePath: file + '.grandchild',
        spawnToolUseId: 'call_spawn_deep_dive',
        agentNickname: 'Noether',
        agentPath: '/root/review_builder/deep_dive',
        parentAgentId: CHILD_ID,
        depth: 2,
        endTime: new Date('2026-10-31T01:40:41.000Z'),
        endedCleanly: true,
      },
    ];
  }

  it('builds rows from child discovery, joined to the Codex lifecycles', () => {
    now = Date.parse('2026-10-31T01:43:00.000Z');
    const rollout = path.join(sessionDir, `rollout-${CHILD_ID}.jsonl`);
    fs.writeFileSync(rollout, '{}\n');
    const monitor = new FakeSessionMonitor(sessionPath, PARENT_ID, 'codex');
    monitor.subagentStats = childStats(rollout);
    monitor.aggregator.processEvent(spawn('call_spawn_builder', 'review_builder'));
    monitor.aggregator.processEvent(
      activity('2026-10-31T01:40:33.100Z', {
        kind: 'started',
        callId: 'call_spawn_builder',
        agentThreadId: CHILD_ID,
        agentPath: '/root/review_builder',
      }),
    );
    monitor.aggregator.processEvent(spawn('call_spawn_infra', 'review_infra', 'worker'));
    monitor.aggregator.processEvent(
      activity('2026-10-31T01:40:34.000Z', {
        kind: 'started',
        callId: 'call_spawn_infra',
        agentThreadId: SIBLING_ID,
        agentPath: '/root/review_infra',
      }),
    );
    monitor.aggregator.processEvent(
      activity('2026-10-31T01:42:21.000Z', {
        kind: 'completed',
        agentThreadId: CHILD_ID,
        agentPath: '/root/review_builder',
      }),
    );

    const provider = create(monitor);
    const rows = provider.getChildren();
    expect(rows).toHaveLength(2);
    const builder = rows.find((row) => row.agentId === CHILD_ID)!;
    const infra = rows.find((row) => row.agentId === SIBLING_ID)!;
    // Nicknames, not the shared UUIDv7 prefix.
    expect(builder).toMatchObject({
      id: 'call_spawn_builder',
      label: 'Banach (Task)',
      type: 'completed',
      displayState: 'completed',
      transcriptPath: rollout,
      totalTokens: 15,
    });
    expect(infra).toMatchObject({
      id: 'call_spawn_infra',
      label: 'Hopper (Task)',
      type: 'running',
      displayState: 'running',
    });
    expect(builder.children).toHaveLength(1);
    expect(builder.children[0]).toMatchObject({
      agentId: GRANDCHILD_ID,
      label: 'Noether (Explore)',
      type: 'completed',
    });
    expect(provider.getTreeItem(builder).command).toMatchObject({
      command: 'vscode.open',
      arguments: [{ fsPath: rollout }],
    });
  });

  it('labels a Codex spawn without a rollout yet by its task name, and rescans on activity', () => {
    now = Date.parse('2026-10-31T01:41:00.000Z');
    const monitor = new FakeSessionMonitor(sessionPath, PARENT_ID, 'codex');
    const provider = create(monitor);
    monitor.ingest(spawn('call_spawn_builder', 'review_builder'), {
      type: 'tool_call',
      metadata: { toolName: 'Spawn_agent', toolUseId: 'call_spawn_builder' },
    });
    expect(provider.getChildren()[0]).toMatchObject({
      label: 'review_builder (Task)',
      type: 'running',
    });

    const rollout = path.join(sessionDir, `rollout-${CHILD_ID}.jsonl`);
    fs.writeFileSync(rollout, '{}\n');
    monitor.subagentStats = childStats(rollout).slice(0, 1);
    monitor.ingest(
      activity('2026-10-31T01:40:33.100Z', {
        kind: 'started',
        callId: 'call_spawn_builder',
        agentThreadId: CHILD_ID,
        agentPath: '/root/review_builder',
      }),
      {
        description: 'Subagent /root/review_builder started',
        metadata: { toolName: 'Spawn_agent', toolUseId: 'call_spawn_builder' },
      },
    );
    expect(provider.getChildren()).toHaveLength(1);
    expect(provider.getChildren()[0]).toMatchObject({
      id: 'call_spawn_builder',
      label: 'Banach (Task)',
      transcriptPath: rollout,
    });
  });
});
