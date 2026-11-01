/**
 * Settling background subagents that never get a final notification (stop
 * markers, task statuses, host meta evidence), and Codex subagent lifecycles.
 * Shapes are redacted from real Claude Code 2.1.29x–2.1.31x and Codex 0.166
 * sessions.
 */
import { describe, expect, it } from 'vitest';
import { EventAggregator, SNAPSHOT_SCHEMA_VERSION } from './EventAggregator';
import { extractSessionEvents } from '../schemas/sessionEvent';
import { resolveSubagentDisplayState } from '../subagentDisplayState';
import { CodexRolloutParser } from '../parsers/codexParser';
import {
  CALL_SPAWN,
  CALL_SPAWN_FAILED,
  CHILD_ID,
  CHILD_PATH,
  at,
  parentRollout,
  type CodexFixtureRow,
} from '../testing/codexSubagentFixtures';
import type { CodexRolloutLine } from '../types/codex';
import type { SessionEvent } from '../types/sessionEvent';
import type { FollowEvent } from '../watchers/types';
import { toFollowEvents } from '../watchers/eventBridge';

const SPAWN_TS = '2026-10-12T20:00:00.000Z';
const LAUNCH_TS = '2026-10-12T20:00:01.000Z';
const LATER_TS = '2026-10-12T22:35:58.442Z';

function spawn(id: string, description: string): SessionEvent {
  return {
    type: 'assistant',
    timestamp: SPAWN_TS,
    message: {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id,
          name: 'Agent',
          input: { description, subagent_type: 'general-purpose', run_in_background: true },
        },
      ],
    },
  };
}

function launch(id: string, agentId: string): SessionEvent {
  return {
    type: 'user',
    timestamp: LAUNCH_TS,
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: id,
          content: [
            {
              type: 'text',
              text: `Async agent launched successfully.\nagentId: ${agentId} (internal ID - do not mention to user.)\nThe agent is working in the background.`,
            },
          ],
        },
      ],
    },
  };
}

function notification(
  agentId: string,
  toolUseId: string,
  timestamp: string,
  interim = false,
): SessionEvent {
  const summary = interim
    ? `Agent "x" stopped with background work of its own still running; it may resume`
    : `Agent "x" finished`;
  return {
    type: 'user',
    timestamp,
    origin: { kind: 'task-notification' },
    message: {
      role: 'user',
      content: `<task-notification>\n<task-id>${agentId}</task-id>\n<tool-use-id>${toolUseId}</tool-use-id>\n<status>completed</status>\n<summary>${summary}</summary>\n</task-notification>`,
    },
  };
}

/** A parent with background agents `a` … launched, as Claude Code records them. */
function withAgents(...names: string[]): EventAggregator {
  const agg = new EventAggregator({ providerId: 'claude-code' });
  for (const name of names) {
    agg.processEvent(spawn(`toolu_${name}`, `Agent ${name.toUpperCase()}`));
    agg.processEvent(launch(`toolu_${name}`, `a${name}0000000000000`));
  }
  return agg;
}

const agentsKilledLine = {
  parentUuid: 'd1827e08-2995-4247-b76a-c1299a65d72a',
  isSidechain: false,
  type: 'system',
  subtype: 'agents_killed',
  timestamp: LATER_TS,
  uuid: '47d24655-4d4c-4d34-97a2-9d6964639802',
  isMeta: false,
  entrypoint: 'cli',
};

function stopNoticeLine(prompt: string): Record<string, unknown> {
  return {
    parentUuid: '58458d50-dd36-4825-80b8-e4108f174807',
    isSidechain: false,
    type: 'attachment',
    timestamp: LATER_TS,
    attachment: {
      type: 'queued_command',
      prompt,
      commandMode: 'task-notification',
      timestamp: LATER_TS,
    },
  };
}

function taskStatusLine(taskId: string, status: string): Record<string, unknown> {
  return {
    isSidechain: false,
    type: 'attachment',
    timestamp: LATER_TS,
    attachment: {
      type: 'task_status',
      taskId,
      taskType: 'local_agent',
      description: 'Agent B',
      status,
      deltaSummary: null,
      canContinueAgent: true,
    },
  };
}

function ingestRaw(agg: EventAggregator, raw: unknown): void {
  for (const event of extractSessionEvents(raw, { includeTaskNotifications: true })) {
    agg.processEvent(event);
  }
}

const byId = (agg: EventAggregator, id: string) => agg.getSubagents().find((s) => s.id === id)!;
const card = (agg: EventAggregator, id: string) => agg.getTaskState().tasks.get(`agent-${id}`);

describe('settling background agents without a final notification', () => {
  it('records settledBy on notification-driven completion and clears it on an interim notice', () => {
    const agg = withAgents('a');
    agg.processEvent(notification('aa0000000000000', 'toolu_a', '2026-10-12T20:05:00.000Z'));
    expect(byId(agg, 'toolu_a')).toMatchObject({
      status: 'completed',
      outcome: 'completed',
      settledBy: 'notification',
    });
    agg.processEvent(notification('aa0000000000000', 'toolu_a', '2026-10-12T20:06:00.000Z', true));
    expect(byId(agg, 'toolu_a').status).toBe('running');
    expect(byId(agg, 'toolu_a').settledBy).toBeUndefined();
  });

  it('interim-only, ended cleanly: running, finished (no report), then meta finished', () => {
    const agg = withAgents('a');
    agg.processEvent(notification('aa0000000000000', 'toolu_a', '2026-10-12T20:05:00.000Z', true));
    const agent = byId(agg, 'toolu_a');
    expect(agent.status).toBe('running');

    const trace = { endedCleanly: true, lastActivityAt: '2026-10-12T20:05:00.000Z' };
    expect(
      resolveSubagentDisplayState(agent, trace, { now: Date.parse('2026-10-12T20:08:00.000Z') }),
    ).toEqual({ state: 'finished-unreported', reason: 'clean-end' });

    expect(
      agg.applySubagentEvidence(
        { agentId: 'aa0000000000000', finished: true },
        trace.lastActivityAt,
      ),
    ).toBe(true);
    expect(byId(agg, 'toolu_a')).toMatchObject({
      status: 'completed',
      outcome: 'completed',
      settledBy: 'meta',
      completionTime: '2026-10-12T20:05:00.000Z',
      durationMs: 300_000,
    });
    expect(card(agg, 'toolu_a')?.status).toBe('completed');
    // Applying the same evidence again changes nothing.
    expect(
      agg.applySubagentEvidence({ agentId: 'aa0000000000000', finished: true }, LATER_TS),
    ).toBe(false);
  });

  it('a silent stop from the UI (meta stoppedByUser) settles as stopped, by tool_use id', () => {
    const agg = withAgents('a', 'b');
    expect(
      agg.applySubagentEvidence(
        { toolUseId: 'toolu_b', agentId: 'ab0000000000000', stoppedByUser: true, finished: true },
        LATER_TS,
      ),
    ).toBe(true);
    expect(byId(agg, 'toolu_b')).toMatchObject({
      status: 'completed',
      outcome: 'stopped',
      settledBy: 'meta',
    });
    expect(byId(agg, 'toolu_a').status).toBe('running');
    expect(card(agg, 'toolu_b')?.status).toBe('completed');
    expect(agg.applySubagentEvidence({ agentId: 'unknown', finished: true }, LATER_TS)).toBe(false);
  });

  it('meta evidence never overrides a notification, and finished:false reopens only a meta settle', () => {
    const agg = withAgents('a', 'b');
    agg.processEvent(notification('aa0000000000000', 'toolu_a', '2026-10-12T20:05:00.000Z'));
    agg.applySubagentEvidence({ agentId: 'aa0000000000000', stoppedByUser: true }, LATER_TS);
    expect(byId(agg, 'toolu_a')).toMatchObject({ outcome: 'completed', settledBy: 'notification' });
    agg.applySubagentEvidence({ agentId: 'aa0000000000000', finished: false }, LATER_TS);
    expect(byId(agg, 'toolu_a').status).toBe('completed');

    agg.applySubagentEvidence({ agentId: 'ab0000000000000', finished: true }, LATER_TS);
    expect(byId(agg, 'toolu_b').settledBy).toBe('meta');
    expect(
      agg.applySubagentEvidence({ agentId: 'ab0000000000000', finished: false }, LATER_TS),
    ).toBe(true);
    expect(byId(agg, 'toolu_b').status).toBe('running');
    expect(card(agg, 'toolu_b')?.status).toBe('in_progress');
  });

  it('agents_killed stops every running background agent, not finished or foreground ones', () => {
    const agg = withAgents('a', 'b');
    agg.processEvent(notification('aa0000000000000', 'toolu_a', '2026-10-12T20:05:00.000Z'));
    agg.processEvent(spawn('toolu_fg', 'Foreground'));
    const before = agg.getMetrics().eventCount;
    ingestRaw(agg, agentsKilledLine);

    expect(byId(agg, 'toolu_a')).toMatchObject({ outcome: 'completed', settledBy: 'notification' });
    expect(byId(agg, 'toolu_b')).toMatchObject({
      status: 'completed',
      outcome: 'stopped',
      settledBy: 'stop-marker',
      completionTime: LATER_TS,
    });
    expect(byId(agg, 'toolu_fg').status).toBe('running');
    // The system line counts as an event, as it always has.
    expect(agg.getMetrics().eventCount).toBe(before + 1);
  });

  it('the plural stop notice settles the named running agents by description', () => {
    const agg = withAgents('a', 'b', 'c');
    agg.processEvent(notification('aa0000000000000', 'toolu_a', '2026-10-12T20:05:00.000Z'));
    const before = agg.getMetrics();
    ingestRaw(
      agg,
      stopNoticeLine('2 background agents were stopped by the user: "Agent A", "Agent B".'),
    );
    expect(byId(agg, 'toolu_a')).toMatchObject({ outcome: 'completed', settledBy: 'notification' });
    expect(byId(agg, 'toolu_b')).toMatchObject({ outcome: 'stopped', settledBy: 'stop-marker' });
    expect(byId(agg, 'toolu_c').status).toBe('running');
    const after = agg.getMetrics();
    expect(after.eventCount).toBe(before.eventCount);
    expect(after.messageCount).toBe(before.messageCount);
    expect(after.timeline.at(-1)).toMatchObject({
      description: 'Background agents stopped by the user (2)',
      noiseLevel: 'system',
    });
  });

  it('a final task_status settles by agent id; a running one does not', () => {
    const agg = withAgents('a', 'b');
    ingestRaw(agg, taskStatusLine('ab0000000000000', 'running'));
    expect(byId(agg, 'toolu_b').status).toBe('running');
    const before = agg.getMetrics();
    ingestRaw(agg, taskStatusLine('ab0000000000000', 'completed'));
    expect(byId(agg, 'toolu_b')).toMatchObject({
      status: 'completed',
      outcome: 'completed',
      settledBy: 'task-status',
    });
    expect(byId(agg, 'toolu_a').status).toBe('running');
    expect(agg.getMetrics().messageCount).toBe(before.messageCount);
    expect(agg.getMetrics().eventCount).toBe(before.eventCount);
  });

  it('killed mid-work with no evidence reads as ended once the parent is idle over 6 h', () => {
    const agg = withAgents('a');
    const agent = byId(agg, 'toolu_a');
    const trace = { endedCleanly: false, lastActivityAt: '2026-10-12T20:30:00.000Z' };
    const parentLastActivity = agg.getMetrics().lastEventTime;
    expect(
      resolveSubagentDisplayState(agent, trace, {
        now: Date.parse('2026-10-12T21:00:00.000Z'),
        parentLastActivity,
      }).state,
    ).toBe('running');
    expect(
      resolveSubagentDisplayState(agent, trace, {
        now: Date.parse('2026-10-13T03:00:00.000Z'),
        parentLastActivity,
      }),
    ).toEqual({ state: 'ended', reason: 'parent-idle' });
  });

  it('a resumed agent after finished (no report) reads as running again', () => {
    const agg = withAgents('a');
    agg.processEvent(notification('aa0000000000000', 'toolu_a', '2026-10-12T20:05:00.000Z', true));
    const now = Date.parse('2026-10-12T20:20:00.000Z');
    const quiet = { endedCleanly: true, lastActivityAt: '2026-10-12T20:05:00.000Z' };
    expect(resolveSubagentDisplayState(byId(agg, 'toolu_a'), quiet, { now }).state).toBe(
      'finished-unreported',
    );
    // SendMessage resumed it: a new prompt, then work.
    const resumed = { endedCleanly: false, lastActivityAt: '2026-10-12T20:19:30.000Z' };
    expect(resolveSubagentDisplayState(byId(agg, 'toolu_a'), resumed, { now }).state).toBe(
      'running',
    );
  });

  it('follows the same records through FollowEvents (the CLI watcher raw lines)', () => {
    const agg = new EventAggregator({ providerId: 'claude-code' });
    const follow = (event: Partial<FollowEvent>) =>
      agg.processFollowEvent({
        providerId: 'claude-code',
        type: 'system',
        timestamp: LATER_TS,
        summary: '',
        ...event,
      } as FollowEvent);
    for (const name of ['a', 'b', 'c']) {
      follow({
        type: 'tool_use',
        toolName: 'Agent',
        timestamp: SPAWN_TS,
        raw: { id: `toolu_${name}`, input: { description: `Agent ${name.toUpperCase()}` } },
      });
      follow({
        type: 'tool_result',
        timestamp: LAUNCH_TS,
        raw: {
          tool_use_id: `toolu_${name}`,
          content: `Async agent launched successfully.\nagentId: a${name}0000000000000 (internal)`,
        },
      });
    }
    const eventCount = agg.getMetrics().eventCount;
    follow({ raw: taskStatusLine('aa0000000000000', 'completed') });
    follow({ raw: stopNoticeLine('Background agent "Agent B" was stopped by the user.') });
    expect(byId(agg, 'toolu_a').settledBy).toBe('task-status');
    expect(byId(agg, 'toolu_b')).toMatchObject({ outcome: 'stopped', settledBy: 'stop-marker' });
    expect(byId(agg, 'toolu_c').status).toBe('running');
    follow({ raw: agentsKilledLine });
    expect(byId(agg, 'toolu_c')).toMatchObject({ outcome: 'stopped', settledBy: 'stop-marker' });
    expect(agg.getMetrics().eventCount).toBe(eventCount);
  });

  it('serializes settledBy and agentPath (schema version 7)', () => {
    expect(SNAPSHOT_SCHEMA_VERSION).toBe(7);
    const agg = withAgents('a');
    agg.applySubagentEvidence({ agentId: 'aa0000000000000', stoppedByUser: true }, LATER_TS);
    const restored = new EventAggregator();
    expect(restored.restore(JSON.parse(JSON.stringify(agg.serialize())))).toBe(true);
    expect(restored.getSubagents()[0]).toMatchObject({ outcome: 'stopped', settledBy: 'meta' });
    expect(restored.restore({ ...agg.serialize(), version: 6 })).toBe(false);
  });
});

// ── Codex ──

const CWD = '/work/repo';

function codexEvents(rows: CodexFixtureRow[]): SessionEvent[] {
  const parser = new CodexRolloutParser({ includeSubagentActivity: true });
  return rows.flatMap((row) => parser.convertLine(row as unknown as CodexRolloutLine));
}

/** Feeds rows up to (and including) the first row matching `until`. */
function feedCodex(
  rows: CodexFixtureRow[],
  until?: (row: CodexFixtureRow) => boolean,
): EventAggregator {
  const agg = new EventAggregator({ providerId: 'codex' });
  const parser = new CodexRolloutParser({ includeSubagentActivity: true });
  for (const row of rows) {
    for (const event of parser.convertLine(row as unknown as CodexRolloutLine)) {
      agg.processEvent(event);
    }
    if (until?.(row)) break;
  }
  return agg;
}

const isActivity = (kind: string) => (row: CodexFixtureRow) =>
  (row.payload as { item?: { kind?: string } } | undefined)?.item?.kind === kind;
const isFinalAnswer = (row: CodexFixtureRow) =>
  (row.payload as { type?: string } | undefined)?.type === 'agent_message' &&
  (row.payload as { id?: string }).id === 'amsg_final';

describe('Codex subagent lifecycles', () => {
  it('spawn → started → completed, with the child thread and agent path', () => {
    const rows = parentRollout({ cwd: CWD });
    const started = feedCodex(rows, isActivity('started'));
    expect(byId(started, CALL_SPAWN)).toMatchObject({
      status: 'running',
      description: 'review_builder',
      subagentType: 'default',
      agentId: CHILD_ID,
      agentPath: CHILD_PATH,
      background: true,
    });
    expect(card(started, CALL_SPAWN)).toMatchObject({
      status: 'in_progress',
      subject: 'review_builder',
    });

    const completed = feedCodex(rows, isActivity('completed'));
    expect(byId(completed, CALL_SPAWN)).toMatchObject({
      status: 'completed',
      outcome: 'completed',
      settledBy: 'notification',
      completionTime: at(42, 21),
    });
    expect(card(completed, CALL_SPAWN)?.status).toBe('completed');
  });

  it('the {"task_name"} result is a background launch, not a completion', () => {
    const rows = parentRollout({ cwd: CWD });
    const launchIndex = rows.findIndex(
      (row) =>
        (row.payload as { type?: string; call_id?: string }).type === 'function_call_output' &&
        (row.payload as { call_id?: string }).call_id === CALL_SPAWN,
    );
    const agg = feedCodex(rows.slice(0, launchIndex + 1));
    expect(byId(agg, CALL_SPAWN)).toMatchObject({ status: 'running', background: true });
  });

  it('a failed spawn is failed and its card is dropped', () => {
    const agg = feedCodex(parentRollout({ cwd: CWD }));
    expect(byId(agg, CALL_SPAWN_FAILED)).toMatchObject({
      status: 'completed',
      outcome: 'failed',
      description: 'review_extra',
    });
    expect(byId(agg, CALL_SPAWN_FAILED).settledBy).toBeUndefined();
    expect(card(agg, CALL_SPAWN_FAILED)?.status).toBe('deleted');
  });

  it('FINAL_ANSWER alone completes it (Codex before 0.150)', () => {
    const rows = parentRollout({ cwd: CWD, withoutCompleted: true });
    const agg = feedCodex(rows, isFinalAnswer);
    expect(byId(agg, CALL_SPAWN)).toMatchObject({
      status: 'completed',
      settledBy: 'notification',
      completionTime: at(42, 25),
    });
  });

  it('matches FINAL_ANSWER by the launch result path when no activity was recorded', () => {
    const rows = parentRollout({ cwd: CWD, withoutActivity: true });
    const agg = feedCodex(rows, isFinalAnswer);
    expect(byId(agg, CALL_SPAWN)).toMatchObject({
      status: 'completed',
      agentPath: CHILD_PATH,
      settledBy: 'notification',
    });
    expect(byId(agg, CALL_SPAWN).agentId).toBeUndefined();
  });

  it('a followup_task reopens it, send_message does not, interrupt_agent stops it', () => {
    const rows = parentRollout({ cwd: CWD });
    const followed = feedCodex(rows, isActivity('interacted'));
    expect(byId(followed, CALL_SPAWN).status).toBe('running');
    expect(byId(followed, CALL_SPAWN).settledBy).toBeUndefined();
    expect(card(followed, CALL_SPAWN)?.status).toBe('in_progress');

    // Settle it, then the send_message interaction must not reopen it.
    const sendIndex = rows.findIndex(
      (row, i) => isActivity('interacted')(row) && i > rows.findIndex(isActivity('interacted')),
    );
    const agg = new EventAggregator({ providerId: 'codex' });
    const parser = new CodexRolloutParser({ includeSubagentActivity: true });
    rows.forEach((row, i) => {
      if (i === sendIndex) {
        agg.applySubagentEvidence({ agentId: CHILD_ID, finished: true }, at(45, 39));
      }
      for (const event of parser.convertLine(row as unknown as CodexRolloutLine)) {
        agg.processEvent(event);
      }
      if (i === sendIndex) expect(byId(agg, CALL_SPAWN).status).toBe('completed');
    });

    const all = feedCodex(rows);
    // Reopened by the follow-up, then interrupted.
    expect(byId(all, CALL_SPAWN)).toMatchObject({
      status: 'completed',
      outcome: 'stopped',
      settledBy: 'stop-marker',
      completionTime: at(46, 0),
    });
  });

  it('keeps activity events out of the counters and gives the same result through FollowEvents', () => {
    const rows = parentRollout({ cwd: CWD });
    const events = codexEvents(rows);
    const direct = new EventAggregator({ providerId: 'codex' });
    const followed = new EventAggregator({ providerId: 'codex' });
    for (const event of events) {
      direct.processEvent(event);
      for (const fe of toFollowEvents(event, 'codex')) followed.processFollowEvent(fe);
    }
    const plain = new EventAggregator({ providerId: 'codex' });
    for (const row of rows) {
      for (const event of new CodexRolloutParser().convertLine(
        row as unknown as CodexRolloutLine,
      )) {
        plain.processEvent(event);
      }
    }
    expect(direct.getMetrics().messageCount).toBe(plain.getMetrics().messageCount);
    expect(direct.getMetrics().eventCount).toBe(plain.getMetrics().eventCount);
    const shape = (agg: EventAggregator) =>
      agg.getSubagents().map(({ id, status, outcome, agentId, agentPath, settledBy }) => ({
        id,
        status,
        outcome,
        agentId,
        agentPath,
        settledBy,
      }));
    expect(shape(followed)).toEqual(shape(direct));
  });
});
