import { describe, expect, it } from 'vitest';
import { EventAggregator } from '../aggregation/EventAggregator';
import { projectSessionTranscript } from '../transcript';
import { buildSessionContextSnapshot } from '../context/sessionContext';
import {
  describeSubagentActivity,
  isSubagentActivitySystemEvent,
  parseCodexAgentMessageText,
  subagentActivityFromEvent,
  type SubagentActivity,
} from '../subagentActivity';
import {
  CALL_FOLLOWUP,
  CALL_INTERRUPT,
  CALL_SEND,
  CALL_SPAWN,
  CALL_SPAWN_FAILED,
  CHILD_ID,
  CHILD_PATH,
  CHILD_TURN_ID,
  PARENT_ID,
  childRollout,
  parentRollout,
  type CodexFixtureRow,
} from '../testing/codexSubagentFixtures';
import type { CodexRolloutLine } from '../types/codex';
import type { SessionEvent } from '../types/sessionEvent';
import { extractNormalizedUsage } from '../usageNormalization';
import { toFollowEvents } from '../watchers/eventBridge';
import { CodexRolloutParser, type CodexRolloutParserOptions } from './codexParser';

const CWD = '/work/repo';

function parse(rows: CodexFixtureRow[], options: CodexRolloutParserOptions = {}): SessionEvent[] {
  const parser = new CodexRolloutParser(options);
  return rows.flatMap((row) => parser.convertLine(row as unknown as CodexRolloutLine));
}

function activities(events: SessionEvent[]): SubagentActivity[] {
  return events
    .map((event) => subagentActivityFromEvent(event))
    .filter((a): a is SubagentActivity => a !== null);
}

function toolUseIds(events: SessionEvent[]): string[] {
  const ids: string[] = [];
  for (const event of events) {
    if (event.type !== 'assistant' || !Array.isArray(event.message.content)) continue;
    for (const block of event.message.content as Array<Record<string, unknown>>) {
      if (block.type === 'tool_use') ids.push(String(block.id));
    }
  }
  return ids;
}

function totalTokens(events: SessionEvent[]): number {
  return events.reduce((sum, event) => sum + (extractNormalizedUsage(event)?.totalTokens ?? 0), 0);
}

describe('CodexRolloutParser subagent activity (opt-in)', () => {
  it('emits nothing for subagent records by default', () => {
    const events = parse(parentRollout({ cwd: CWD }));
    expect(events.some(isSubagentActivitySystemEvent)).toBe(false);
    // The spawn call and its output are ordinary tool events either way.
    expect(toolUseIds(events)).toContain(CALL_SPAWN);
  });

  it('turns spawn → started → completed → FINAL_ANSWER into typed system events', () => {
    const off = parse(parentRollout({ cwd: CWD }));
    const on = parse(parentRollout({ cwd: CWD }), { includeSubagentActivity: true });
    // Only the activity events are added; everything else is unchanged.
    expect(on.filter((event) => !isSubagentActivitySystemEvent(event))).toEqual(off);

    const found = activities(on);
    expect(found.map((a) => a.kind)).toEqual([
      'started',
      'completed',
      'final-answer',
      'interacted',
      'interacted',
      'interrupted',
    ]);
    expect(found[0]).toEqual({
      kind: 'started',
      callId: CALL_SPAWN,
      tool: 'spawn_agent',
      agentThreadId: CHILD_ID,
      agentPath: CHILD_PATH,
      model: 'gpt-test',
      reasoningEffort: 'high',
      parentThreadId: PARENT_ID,
      parentTurnId: `${PARENT_ID}-turn`,
    });
    expect(found[1]).toMatchObject({
      kind: 'completed',
      turnId: CHILD_TURN_ID,
      agentThreadId: CHILD_ID,
      agentPath: CHILD_PATH,
    });
    expect(found[1].callId).toBeUndefined();
    // MESSAGE progress notes are not activity; the final answer is.
    expect(found[2]).toEqual({
      kind: 'final-answer',
      agentPath: CHILD_PATH,
      recipient: '/root',
      text: 'Found two issues.',
    });
    expect(found[3]).toMatchObject({
      kind: 'interacted',
      callId: CALL_FOLLOWUP,
      tool: 'followup_task',
    });
    expect(found[4]).toMatchObject({ kind: 'interacted', callId: CALL_SEND, tool: 'send_message' });
    expect(found[5]).toMatchObject({
      kind: 'interrupted',
      callId: CALL_INTERRUPT,
      tool: 'interrupt_agent',
    });

    const event = on.find(isSubagentActivitySystemEvent)!;
    expect(event).toMatchObject({
      type: 'system',
      origin: { kind: 'subagent-activity' },
      message: {
        role: 'system',
        id: `subagent-activity:${CALL_SPAWN}`,
        sourceLabel: 'subagent activity',
      },
      providerMetadata: { providerId: 'codex', source: 'codex-rollout' },
    });
  });

  it('reports a FINAL_ANSWER without a completed record (Codex before 0.150)', () => {
    const events = parse(parentRollout({ cwd: CWD, withoutCompleted: true }), {
      includeSubagentActivity: true,
    });
    const kinds = activities(events).map((a) => a.kind);
    expect(kinds).not.toContain('completed');
    expect(kinds).toContain('final-answer');
  });

  it('keeps a failed spawn as an errored tool result with no started record', () => {
    const events = parse(parentRollout({ cwd: CWD }), { includeSubagentActivity: true });
    const result = events
      .flatMap((event) =>
        event.type === 'user' && Array.isArray(event.message.content)
          ? (event.message.content as Array<Record<string, unknown>>)
          : [],
      )
      .find((block) => block.tool_use_id === CALL_SPAWN_FAILED);
    expect(result).toMatchObject({ type: 'tool_result', is_error: true });
    expect(activities(events).some((a) => a.callId === CALL_SPAWN_FAILED)).toBe(false);
  });

  it('omits the report text in metadata-only mode', () => {
    const events = parse(parentRollout({ cwd: CWD }), {
      includeSubagentActivity: true,
      metadataOnly: true,
    });
    const final = activities(events).find((a) => a.kind === 'final-answer');
    expect(final).toEqual({ kind: 'final-answer', agentPath: CHILD_PATH, recipient: '/root' });
  });

  it('keeps tool names for activity across a resume', () => {
    const rows = parentRollout({ cwd: CWD });
    const split = rows.findIndex(
      (row) => (row.payload as Record<string, unknown>).call_id === CALL_FOLLOWUP,
    );
    const first = new CodexRolloutParser({ includeSubagentActivity: true });
    for (const row of rows.slice(0, split + 1))
      first.convertLine(row as unknown as CodexRolloutLine);
    const state = JSON.parse(JSON.stringify(first.exportResumeState()));
    expect(state.collaborationCalls).toEqual(
      expect.arrayContaining([[CALL_FOLLOWUP, 'followup_task']]),
    );
    const second = new CodexRolloutParser({ includeSubagentActivity: true });
    expect(second.importResumeState(state)).toBe(true);
    const rest = rows
      .slice(split + 1)
      .flatMap((row) => second.convertLine(row as unknown as CodexRolloutLine));
    expect(activities(rest)[0]).toMatchObject({ callId: CALL_FOLLOWUP, tool: 'followup_task' });
    // States from earlier versions (no table) still import.
    delete state.collaborationCalls;
    expect(new CodexRolloutParser().importResumeState(state)).toBe(true);
    expect(new CodexRolloutParser().importResumeState({ ...state, collaborationCalls: [1] })).toBe(
      false,
    );
  });

  it('is skipped by message counts, transcripts, context, and the follow-event summary', () => {
    const off = parse(parentRollout({ cwd: CWD }));
    const on = parse(parentRollout({ cwd: CWD }), { includeSubagentActivity: true });

    const counts = (events: SessionEvent[]) => {
      const aggregator = new EventAggregator({ providerId: 'codex' });
      for (const event of events) aggregator.processEvent(event);
      const metrics = aggregator.getMetrics();
      return { messages: metrics.messageCount, events: metrics.eventCount };
    };
    expect(counts(on)).toEqual(counts(off));

    // Positions in the event list differ by the added events; nothing else may.
    const withoutIndexes = (value: unknown) =>
      JSON.parse(JSON.stringify(value, (key, v) => (key === 'eventIndex' ? undefined : v)));
    const transcript = (events: SessionEvent[]) =>
      withoutIndexes(projectSessionTranscript(events).messages);
    expect(transcript(on)).toEqual(transcript(off));

    const context = (events: SessionEvent[]) =>
      withoutIndexes(buildSessionContextSnapshot(events, { providerId: 'codex' }).sources);
    expect(context(on)).toEqual(context(off));

    const started = on.find(isSubagentActivitySystemEvent)!;
    expect(toFollowEvents(started, 'codex')).toEqual([
      expect.objectContaining({ type: 'system', summary: `Subagent ${CHILD_PATH} started` }),
    ]);
    const follow = new EventAggregator({ providerId: 'codex' });
    follow.processFollowEvent(toFollowEvents(started, 'codex')[0]);
    expect(follow.getMetrics().eventCount).toBe(0);
  });
});

describe('subagent activity helpers', () => {
  it('ignores other events and malformed blocks', () => {
    const base = { type: 'system', timestamp: 'x', origin: { kind: 'subagent-activity' } } as const;
    expect(subagentActivityFromEvent({ ...base, message: { role: 'system', content: [] } })).toBe(
      null,
    );
    expect(
      subagentActivityFromEvent({
        ...base,
        message: { role: 'system', content: [{ type: 'subagent_activity', kind: 'weird' }] },
      }),
    ).toBe(null);
    expect(
      subagentActivityFromEvent({
        type: 'system',
        timestamp: 'x',
        message: { role: 'system', content: [{ type: 'subagent_activity', kind: 'started' }] },
      }),
    ).toBe(null);
  });

  it('describes activity without content', () => {
    expect(describeSubagentActivity({ kind: 'completed', agentPath: '/root/a' })).toBe(
      'Subagent /root/a finished a turn',
    );
    expect(
      describeSubagentActivity({ kind: 'interacted', tool: 'send_message', agentPath: '/root/a' }),
    ).toBe('Message sent to subagent /root/a');
  });

  it('parses inter-agent message texts', () => {
    expect(
      parseCodexAgentMessageText(
        'Message Type: FINAL_ANSWER\nTask name: /root\nSender: /root/a\nPayload:\nLine 1\nLine 2',
      ),
    ).toEqual({
      messageType: 'FINAL_ANSWER',
      taskName: '/root',
      sender: '/root/a',
      payload: 'Line 1\nLine 2',
    });
    expect(parseCodexAgentMessageText('Plain text')).toBe(null);
  });
});

describe('CodexRolloutParser forked child rollouts', () => {
  it("skips the parent's history before subagent_history_start_ordinal", () => {
    const parser = new CodexRolloutParser();
    const events = childRollout({ cwd: CWD }).flatMap((row) =>
      parser.convertLine(row as unknown as CodexRolloutLine),
    );
    // Own tool calls only: not the parent's exec call.
    expect(toolUseIds(events)).toEqual(['call_child_exec', 'call_spawn_deep_dive']);
    // Own tokens only (300 + 200), not the inherited 5000.
    expect(totalTokens(events)).toBe(500);
    // The model comes from the child's own turn context.
    expect(parser.getCurrentModel()).toBe('gpt-test');
    // No inherited developer message.
    expect(
      events.some((event) =>
        JSON.stringify(event.message?.content ?? '').includes('newly spawned child'),
      ),
    ).toBe(false);
  });

  it("keeps the rollout's own session_meta, not an embedded ancestor's", () => {
    const parser = new CodexRolloutParser();
    const events = childRollout({ cwd: CWD }).flatMap((row) =>
      parser.convertLine(row as unknown as CodexRolloutLine),
    );
    expect(parser.getSessionMeta()?.id).toBe(CHILD_ID);
    expect(parser.getSessionMeta()?.cwd).toBe(CWD);
    // One session_meta event, with the child's cwd; no parent base instructions.
    const metaEvents = events.filter((event) => event.type === 'system' && event.cwd);
    expect(metaEvents).toHaveLength(1);
    expect(metaEvents[0].cwd).toBe(CWD);
    expect(JSON.stringify(events)).not.toContain('Parent base instructions');
    // Even with no history start, a second session_meta never replaces the first.
    const plain = new CodexRolloutParser();
    plain.convertLine({ timestamp: 'a', type: 'session_meta', payload: { id: 'one', cwd: '/a' } });
    expect(
      plain.convertLine({
        timestamp: 'b',
        type: 'session_meta',
        payload: { id: 'two', cwd: '/b' },
      }),
    ).toEqual([]);
    expect(plain.getSessionMeta()?.id).toBe('one');
  });

  it('keeps every record when the rollout embeds no ancestor session_meta', () => {
    // Shape Codex 0.146 left: the start ordinal is past the child's own records.
    const rows = childRollout({ cwd: CWD }).filter((_row, index) => index !== 1);
    const parser = new CodexRolloutParser();
    const events = rows.flatMap((row) => parser.convertLine(row as unknown as CodexRolloutLine));
    expect(parser.getInheritedHistoryEnd()).toBe(null);
    expect(toolUseIds(events)).toEqual([
      'call_parent_exec',
      'call_child_exec',
      'call_spawn_deep_dive',
    ]);
  });

  it('reports where the inherited history ends', () => {
    const parser = new CodexRolloutParser();
    const rows = childRollout({ cwd: CWD });
    parser.convertLine(rows[0] as unknown as CodexRolloutLine);
    expect(parser.getInheritedHistoryEnd()).toBe(null);
    parser.convertLine(rows[1] as unknown as CodexRolloutLine);
    expect(parser.getInheritedHistoryEnd()).toBe(6);
    expect(parser.exportResumeState().inheritedHistoryEnd).toBe(6);
    expect(new CodexRolloutParser().importResumeState(parser.exportResumeState())).toBe(true);
    expect(
      new CodexRolloutParser().importResumeState({
        ...parser.exportResumeState(),
        inheritedHistoryEnd: -1,
      }),
    ).toBe(false);
  });

  it('skips the prefix after a resume from exported state', () => {
    const rows = childRollout({ cwd: CWD });
    for (const split of [1, 3]) {
      const first = new CodexRolloutParser();
      for (const row of rows.slice(0, split)) first.convertLine(row as unknown as CodexRolloutLine);
      const resumed = new CodexRolloutParser();
      expect(resumed.importResumeState(first.exportResumeState())).toBe(true);
      const events = rows
        .slice(split)
        .flatMap((row) => resumed.convertLine(row as unknown as CodexRolloutLine));
      expect(toolUseIds(events)).toEqual(['call_child_exec', 'call_spawn_deep_dive']);
    }
  });

  it('starts over on reset', () => {
    const parser = new CodexRolloutParser();
    for (const row of childRollout({ cwd: CWD }))
      parser.convertLine(row as unknown as CodexRolloutLine);
    parser.reset();
    const parentEvents = parentRollout({ cwd: CWD }).flatMap((row) =>
      parser.convertLine(row as unknown as CodexRolloutLine),
    );
    expect(parser.getSessionMeta()?.id).toBe(PARENT_ID);
    expect(toolUseIds(parentEvents)).toContain(CALL_SPAWN);
  });
});
