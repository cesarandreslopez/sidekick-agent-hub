import { describe, expect, it } from 'vitest';
import { EventAggregator } from './aggregation/EventAggregator';
import { buildSessionContextSnapshot } from './context/sessionContext';
import { CodexRolloutParser } from './parsers/codexParser';
import { childRollout } from './testing/codexSubagentFixtures';
import { projectSessionTranscript } from './transcript';
import {
  describeTurnLifecycle,
  isTurnLifecycleSystemEvent,
  turnLifecycleFromEvent,
  TURN_LIFECYCLE_ORIGIN_KIND,
} from './turnLifecycle';
import type { CodexRolloutLine } from './types/codex';
import type { SessionEvent } from './types/sessionEvent';
import { toFollowEvents } from './watchers/eventBridge';

function line(second: number, type: string, payload: Record<string, unknown>): CodexRolloutLine {
  return {
    timestamp: `2026-11-01T10:00:${String(second).padStart(2, '0')}.000Z`,
    type,
    payload,
  } as unknown as CodexRolloutLine;
}

const ROWS = [
  line(0, 'session_meta', { id: 'thread-1', cwd: '/work/repo', source: 'cli' }),
  line(1, 'event_msg', { type: 'task_started', turn_id: 'turn-1', model_context_window: 1000 }),
  line(2, 'response_item', {
    type: 'message',
    role: 'user',
    content: [{ type: 'input_text', text: 'hello' }],
  }),
  line(3, 'response_item', {
    type: 'message',
    role: 'assistant',
    content: [{ type: 'output_text', text: 'hi' }],
  }),
  line(4, 'event_msg', { type: 'task_complete', turn_id: 'turn-1', last_agent_message: 'hi' }),
  line(5, 'event_msg', { type: 'task_started', turn_id: 'turn-2' }),
  line(6, 'event_msg', { type: 'turn_aborted', turn_id: 'turn-2', reason: 'interrupted' }),
  line(7, 'event_msg', { type: 'turn_started', turn_id: 'turn-3' }),
  line(8, 'event_msg', {
    type: 'task_complete',
    turn_id: 'turn-3',
    error: { message: 'usage limit' },
  }),
];

function parse(rows: CodexRolloutLine[], includeTurnLifecycle: boolean): SessionEvent[] {
  const parser = new CodexRolloutParser({ includeTurnLifecycle });
  return rows.flatMap((row) => parser.convertLine(row));
}

describe('Codex turn lifecycle events', () => {
  it('are off by default', () => {
    expect(parse(ROWS, false).some(isTurnLifecycleSystemEvent)).toBe(false);
  });

  it('report each turn start, completion, and abort', () => {
    const lifecycle = parse(ROWS, true).filter(isTurnLifecycleSystemEvent);
    expect(lifecycle.map((event) => (event as { subtype?: string }).subtype)).toEqual([
      'task_started',
      'task_complete',
      'task_started',
      'turn_aborted',
      'task_started',
      'task_complete',
    ]);
    expect(lifecycle[0]).toMatchObject({
      type: 'system',
      timestamp: '2026-11-01T10:00:01.000Z',
      origin: { kind: TURN_LIFECYCLE_ORIGIN_KIND },
    });
    expect(lifecycle.map(turnLifecycleFromEvent)).toEqual([
      { kind: 'task_started', turnId: 'turn-1' },
      { kind: 'task_complete', turnId: 'turn-1' },
      { kind: 'task_started', turnId: 'turn-2' },
      { kind: 'turn_aborted', turnId: 'turn-2', reason: 'interrupted' },
      { kind: 'task_started', turnId: 'turn-3' },
      { kind: 'task_complete', turnId: 'turn-3', failed: true },
    ]);
    expect(lifecycle.map((event) => describeTurnLifecycle(turnLifecycleFromEvent(event)!))).toEqual(
      [
        'Turn started',
        'Turn complete',
        'Turn started',
        'Turn aborted (interrupted)',
        'Turn started',
        'Turn ended with an error',
      ],
    );
    expect(turnLifecycleFromEvent({ type: 'system', timestamp: 'x' } as SessionEvent)).toBe(null);
  });

  it("are skipped inside a fork's inherited parent history", () => {
    const rows = childRollout({ cwd: '/work/repo' });
    // Make one inherited record a parent turn boundary.
    const inherited = rows.map((row, index) =>
      index === 2
        ? { ...row, type: 'event_msg', payload: { type: 'task_complete', turn_id: 'parent' } }
        : row,
    );
    const events = parse(inherited as unknown as CodexRolloutLine[], true);
    expect(events.filter(isTurnLifecycleSystemEvent).map(turnLifecycleFromEvent)).toEqual([
      { kind: 'task_started', turnId: '01a18f9d-0000-7000-8000-0000000000t1' },
    ]);
  });

  it('stay out of transcripts, context, and the aggregator counts, and summarize when followed', () => {
    const withLifecycle = parse(ROWS, true);
    const without = parse(ROWS, false);
    // Same messages; only their positions in the event list (`eventIndex`) differ.
    const messages = (events: SessionEvent[]) =>
      projectSessionTranscript(events).messages.map(({ source, ...message }) => ({
        ...message,
        source: { ...source, eventIndex: 0 },
      }));
    expect(messages(withLifecycle)).toEqual(messages(without));
    expect(buildSessionContextSnapshot(withLifecycle)).toEqual(
      buildSessionContextSnapshot(without),
    );
    const counted = new EventAggregator();
    for (const event of withLifecycle) counted.processEvent(event);
    const plain = new EventAggregator();
    for (const event of without) plain.processEvent(event);
    expect(counted.getMetrics().eventCount).toBe(plain.getMetrics().eventCount);

    const followed = withLifecycle.flatMap((event) => toFollowEvents(event, 'codex'));
    expect(
      followed.filter((event) => isTurnLifecycleSystemEvent(event.raw as SessionEvent)),
    ).toHaveLength(6);
    expect(followed.map((event) => event.summary)).toContain('Turn aborted (interrupted)');
    const viaFollow = new EventAggregator();
    for (const event of followed) viaFollow.processFollowEvent(event);
    const plainFollow = new EventAggregator();
    for (const event of without.flatMap((e) => toFollowEvents(e, 'codex'))) {
      plainFollow.processFollowEvent(event);
    }
    expect(viaFollow.getMetrics().eventCount).toBe(plainFollow.getMetrics().eventCount);
  });
});
