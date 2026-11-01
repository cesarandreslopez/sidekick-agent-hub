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

import { EventAggregator, type SessionEvent, type TimelineEvent } from 'sidekick-shared';
import { SubagentTreeProvider } from './SubagentTreeProvider';
import type { SessionMonitor } from '../services/SessionMonitor';

const SESSION_ID = 'session-1';
const AGENT_ID = 'a1b2c3d4e5f6a7b8c';
const SPAWN_ID = 'toolu_spawn';

/** The parts of SessionMonitor the tree reads, over a real shared aggregator. */
class FakeSessionMonitor {
  readonly aggregator = new EventAggregator({ providerId: 'claude-code' });
  private readonly sessionStart = new MockEventEmitter<string>();
  private readonly timeline = new MockEventEmitter<TimelineEvent>();
  readonly onSessionStart = this.sessionStart.event;
  readonly onTimelineEvent = this.timeline.event;

  constructor(
    private readonly sessionPath: string | null,
    private readonly sessionId: string | null,
  ) {}

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
    return [];
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

function create(monitor: FakeSessionMonitor): SubagentTreeProvider {
  const provider = new SubagentTreeProvider(monitor as unknown as SessionMonitor, {
    minRescanIntervalMs: 0,
  });
  providers.push(provider);
  return provider;
}

beforeEach(() => {
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
});
