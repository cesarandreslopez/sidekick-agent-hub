import { describe, expect, it } from 'vitest';
import { CodexRolloutParser } from './parsers/codexParser';
import {
  classifyTurnState,
  createTurnStateTracker,
  DEFAULT_TURN_STATE_IDLE_MS,
  DEFAULT_TURN_STATE_STALE_MS,
  TURN_STATE_REPLY_GRACE_MS,
} from './turnState';
import type { CodexRolloutLine } from './types/codex';
import type { SessionEvent } from './types/sessionEvent';

const T0 = Date.parse('2026-11-01T10:00:00.000Z');
const at = (seconds: number): string => new Date(T0 + seconds * 1000).toISOString();
const after = (seconds: number): number => T0 + seconds * 1000;

function user(seconds: number, content: unknown, extra: Partial<SessionEvent> = {}): SessionEvent {
  return {
    type: 'user',
    timestamp: at(seconds),
    message: { role: 'user', content },
    ...extra,
  } as SessionEvent;
}

function assistant(
  seconds: number,
  content: unknown[],
  stopReason: string | undefined,
  extra: Record<string, unknown> = {},
): SessionEvent {
  return {
    type: 'assistant',
    timestamp: at(seconds),
    message: {
      role: 'assistant',
      id: `msg_${seconds}`,
      model: 'claude-opus-5',
      content,
      ...(stopReason ? { stop_reason: stopReason } : {}),
    },
    ...extra,
  } as SessionEvent;
}

const text = (value: string) => ({ type: 'text', text: value });
const toolUse = (id: string, name = 'Bash') => ({ type: 'tool_use', id, name, input: {} });
const toolResult = (id: string) => ({ type: 'tool_result', tool_use_id: id, content: 'ok' });

describe('classifyTurnState — Claude Code', () => {
  const turn = [
    user(0, 'fix the bug'),
    assistant(2, [text('Looking.'), toolUse('toolu_1')], 'tool_use'),
    user(5, [toolResult('toolu_1')]),
    assistant(8, [text('Fixed.')], 'end_turn'),
  ];

  it('is working while tools run and waiting once the turn ends', () => {
    expect(classifyTurnState(turn.slice(0, 1), { now: after(1) })).toMatchObject({
      state: 'working',
      reason: 'user-prompt',
      evidence: 'reported',
    });
    expect(classifyTurnState(turn.slice(0, 2), { now: after(3) })).toEqual({
      state: 'working',
      since: at(0),
      reason: 'tool-pending',
      lastEventAt: at(2),
      pendingToolUseIds: ['toolu_1'],
      evidence: 'reported',
    });
    expect(classifyTurnState(turn, { now: after(9) })).toEqual({
      state: 'waiting',
      since: at(8),
      reason: 'end-turn',
      lastEventAt: at(8),
      evidence: 'reported',
    });
  });

  it('ends a turn on turn_duration, stop hooks, API errors, and interrupts', () => {
    const base = turn.slice(0, 3);
    const durations: Array<[SessionEvent, string]> = [
      [
        { type: 'system', subtype: 'turn_duration', timestamp: at(9) } as SessionEvent,
        'turn-duration',
      ],
      [
        { type: 'system', subtype: 'stop_hook_summary', timestamp: at(9) } as SessionEvent,
        'stop-hook',
      ],
      [
        assistant(9, [text('API Error: 529 overloaded')], undefined, {
          message: {
            role: 'assistant',
            model: '<synthetic>',
            content: [text('API Error: 529 overloaded')],
          },
        }),
        'api-error',
      ],
      [user(9, [text('[Request interrupted by user]')]), 'interrupted'],
    ];
    for (const [event, reason] of durations) {
      const result = classifyTurnState([...base, event], { now: after(10) });
      expect(result, reason).toMatchObject({ state: 'waiting', reason, evidence: 'reported' });
      expect(result.pendingToolUseIds).toBeUndefined();
    }
  });

  it('waits for the user while a question or plan approval is open', () => {
    const asking = [
      user(0, 'plan it'),
      assistant(2, [toolUse('toolu_q', 'AskUserQuestion')], 'tool_use'),
    ];
    expect(classifyTurnState(asking, { now: after(30) })).toMatchObject({
      state: 'waiting',
      reason: 'awaiting-input',
      pendingToolUseIds: ['toolu_q'],
    });
    const answered = [...asking, user(40, [toolResult('toolu_q')])];
    expect(classifyTurnState(answered, { now: after(41) })).toMatchObject({
      state: 'working',
      reason: 'tool-result',
    });
  });

  it('turns idle, then ended, as time passes, unless the process is known', () => {
    const idleAt = after(8) + DEFAULT_TURN_STATE_IDLE_MS + 1;
    expect(classifyTurnState(turn, { now: idleAt })).toMatchObject({
      state: 'idle',
      since: new Date(after(8) + DEFAULT_TURN_STATE_IDLE_MS).toISOString(),
      evidence: 'inferred',
    });
    const staleAt = after(8) + DEFAULT_TURN_STATE_STALE_MS + 1;
    expect(classifyTurnState(turn, { now: staleAt })).toMatchObject({
      state: 'ended',
      reason: 'stale',
    });
    expect(classifyTurnState(turn, { now: staleAt, processRunning: true })).toMatchObject({
      state: 'idle',
    });
    // A long tool call keeps the turn working while the process lives.
    expect(
      classifyTurnState(turn.slice(0, 2), { now: staleAt, processRunning: true }),
    ).toMatchObject({ state: 'working', reason: 'tool-pending' });
    expect(classifyTurnState(turn.slice(0, 2), { now: after(3), processRunning: false })).toEqual({
      state: 'ended',
      since: at(2),
      reason: 'process-exited',
      lastEventAt: at(2),
      pendingToolUseIds: ['toolu_1'],
      evidence: 'reported',
    });
    expect(classifyTurnState([], { now: after(1) })).toEqual({
      state: 'idle',
      since: null,
      reason: 'no-events',
      lastEventAt: null,
      evidence: 'inferred',
    });
  });

  it('ignores sidechain and meta records', () => {
    const events = [
      ...turn,
      user(10, 'subagent prompt', { isSidechain: true }),
      assistant(11, [toolUse('toolu_side')], 'tool_use', { isSidechain: true }),
      user(12, 'caveat', { isMeta: true }),
    ];
    expect(classifyTurnState(events, { now: after(13) })).toMatchObject({
      state: 'waiting',
      reason: 'end-turn',
    });
  });
});

describe('classifyTurnState — Codex', () => {
  function line(seconds: number, type: string, payload: Record<string, unknown>) {
    return { timestamp: at(seconds), type, payload } as unknown as CodexRolloutLine;
  }
  const rollout = [
    line(0, 'session_meta', { id: 'thread-1', cwd: '/work/repo', source: 'cli' }),
    line(1, 'event_msg', { type: 'task_started', turn_id: 'turn-1' }),
    line(1, 'response_item', {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'run the tests' }],
    }),
    line(2, 'response_item', {
      type: 'function_call',
      name: 'exec_command',
      arguments: '{"cmd":"npm test"}',
      call_id: 'call_1',
    }),
    line(4, 'response_item', {
      type: 'function_call_output',
      call_id: 'call_1',
      output: 'Process exited with code 0',
    }),
    line(5, 'response_item', {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'All green.' }],
    }),
    line(5, 'event_msg', {
      type: 'token_count',
      info: { last_token_usage: { input_tokens: 10, output_tokens: 2 } },
    }),
    line(6, 'event_msg', {
      type: 'task_complete',
      turn_id: 'turn-1',
      last_agent_message: 'All green.',
    }),
  ];
  const parse = (rows: CodexRolloutLine[], includeTurnLifecycle: boolean) => {
    const parser = new CodexRolloutParser({ includeTurnLifecycle });
    return rows.flatMap((row) => parser.convertLine(row));
  };

  it('follows the reported turn lifecycle', () => {
    const events = parse(rollout, true);
    expect(classifyTurnState(parse(rollout.slice(0, 4), true), { now: after(3) })).toMatchObject({
      state: 'working',
      pendingToolUseIds: ['call_1'],
      evidence: 'reported',
    });
    expect(classifyTurnState(parse(rollout.slice(0, 7), true), { now: after(60) })).toMatchObject({
      state: 'working',
      evidence: 'reported',
    });
    expect(classifyTurnState(events, { now: after(7) })).toEqual({
      state: 'waiting',
      since: at(6),
      reason: 'turn-complete',
      lastEventAt: at(6),
      evidence: 'reported',
    });
    const aborted = parse(
      [
        ...rollout.slice(0, 4),
        line(5, 'event_msg', { type: 'turn_aborted', turn_id: 'turn-1', reason: 'interrupted' }),
      ],
      true,
    );
    expect(classifyTurnState(aborted, { now: after(6) })).toMatchObject({
      state: 'waiting',
      reason: 'turn-aborted',
    });
    expect(classifyTurnState(aborted, { now: after(6) }).pendingToolUseIds).toBeUndefined();
  });

  it('infers the end of a turn without lifecycle events after a grace period', () => {
    const events = parse(rollout, false);
    expect(classifyTurnState(events, { now: after(5) + 1000 })).toMatchObject({
      state: 'working',
      evidence: 'inferred',
    });
    expect(classifyTurnState(events, { now: after(5) + TURN_STATE_REPLY_GRACE_MS })).toMatchObject({
      state: 'waiting',
      reason: 'quiet-after-reply',
      since: new Date(after(5) + TURN_STATE_REPLY_GRACE_MS).toISOString(),
      evidence: 'inferred',
    });
    // A tool call still running is never inferred finished.
    expect(classifyTurnState(parse(rollout.slice(0, 4), false), { now: after(60) })).toMatchObject({
      state: 'working',
      pendingToolUseIds: ['call_1'],
    });
  });

  it('ignores the synthetic plan-mode tool uses, which never get results', () => {
    const plan = parse(
      [
        rollout[0],
        line(1, 'event_msg', {
          type: 'task_started',
          turn_id: 'turn-1',
          collaboration_mode_kind: 'plan',
        }),
        rollout[2],
        line(3, 'response_item', {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Here is the plan.' }],
        }),
        line(4, 'event_msg', { type: 'task_complete', turn_id: 'turn-1' }),
      ],
      true,
    );
    expect(plan.some((event) => JSON.stringify(event).includes('EnterPlanMode'))).toBe(true);
    expect(classifyTurnState(plan, { now: after(5) })).toMatchObject({
      state: 'waiting',
      reason: 'turn-complete',
    });
    expect(classifyTurnState(plan, { now: after(5) }).pendingToolUseIds).toBeUndefined();
  });
});

describe('createTurnStateTracker', () => {
  it('matches classifyTurnState incrementally and survives export and import', () => {
    const events = [
      user(0, 'go'),
      assistant(2, [toolUse('toolu_1')], 'tool_use'),
      user(4, [toolResult('toolu_1')]),
      assistant(6, [text('Done.')], 'end_turn'),
    ];
    const tracker = createTurnStateTracker();
    for (let index = 0; index < events.length; index++) {
      tracker.observe(events[index]);
      const resumed = createTurnStateTracker();
      expect(resumed.import(JSON.parse(JSON.stringify(tracker.export())))).toBe(true);
      const now = { now: after(index * 2 + 1) };
      expect(tracker.current(now)).toEqual(classifyTurnState(events.slice(0, index + 1), now));
      expect(resumed.current(now)).toEqual(tracker.current(now));
    }
    tracker.reset();
    expect(tracker.current({ now: after(10) }).reason).toBe('no-events');
    for (const bad of [null, { version: 2 }, { ...tracker.export(), reason: 'bored' }]) {
      expect(createTurnStateTracker().import(bad)).toBe(false);
    }
  });
});
