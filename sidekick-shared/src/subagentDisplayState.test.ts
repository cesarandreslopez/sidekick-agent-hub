import { describe, expect, it } from 'vitest';
import {
  SUBAGENT_PARENT_IDLE_ENDED_MS,
  SUBAGENT_UNREPORTED_QUIET_MS,
  resolveSubagentDisplayState,
  subagentDisplayLabel,
  type SubagentDisplayStateName,
} from './subagentDisplayState';

const NOW = Date.parse('2026-11-01T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW - ms);
const running = { status: 'running' as const };

describe('resolveSubagentDisplayState', () => {
  it('exports the thresholds', () => {
    expect(SUBAGENT_UNREPORTED_QUIET_MS).toBe(120_000);
    expect(SUBAGENT_PARENT_IDLE_ENDED_MS).toBe(6 * 3_600_000);
  });

  it('maps settled lifecycles to their outcome', () => {
    for (const outcome of ['completed', 'failed', 'stopped', 'killed'] as const) {
      expect(
        resolveSubagentDisplayState({ status: 'completed', outcome }, null, { now: NOW }),
      ).toEqual({ state: outcome, reason: 'settled' });
    }
    expect(resolveSubagentDisplayState({ status: 'completed' }, null, { now: NOW })).toEqual({
      state: 'completed',
      reason: 'settled',
    });
  });

  it('keeps a running agent running without evidence', () => {
    expect(resolveSubagentDisplayState(running, undefined, { now: NOW })).toEqual({
      state: 'running',
    });
    // Quiet for an hour but not ended cleanly: idle alone is not enough.
    expect(
      resolveSubagentDisplayState(
        running,
        { endedCleanly: false, lastActivityAt: ago(3_600_000) },
        { now: NOW, parentLastActivity: ago(3_600_000) },
      ),
    ).toEqual({ state: 'running' });
  });

  it('reads a clean end quiet for 2 minutes as finished without a report', () => {
    const trace = { endedCleanly: true, lastActivityAt: ago(SUBAGENT_UNREPORTED_QUIET_MS) };
    expect(resolveSubagentDisplayState(running, trace, { now: NOW })).toEqual({
      state: 'finished-unreported',
      reason: 'clean-end',
    });
    expect(
      resolveSubagentDisplayState(
        running,
        { ...trace, lastActivityAt: ago(SUBAGENT_UNREPORTED_QUIET_MS - 1) },
        { now: NOW },
      ),
    ).toEqual({ state: 'running' });
  });

  it('returns to running when the agent resumes (recomputed from new data)', () => {
    const before = { endedCleanly: true, lastActivityAt: ago(10 * 60_000).toISOString() };
    expect(resolveSubagentDisplayState(running, before, { now: NOW }).state).toBe(
      'finished-unreported',
    );
    const resumed = { endedCleanly: false, lastActivityAt: ago(5_000).toISOString() };
    expect(resolveSubagentDisplayState(running, resumed, { now: NOW }).state).toBe('running');
  });

  it('reads an agent as ended once the parent and transcript are idle over 6 hours', () => {
    const killedMidWork = { endedCleanly: false, lastActivityAt: ago(9 * 3_600_000) };
    expect(
      resolveSubagentDisplayState(running, killedMidWork, {
        now: NOW,
        parentLastActivity: ago(SUBAGENT_PARENT_IDLE_ENDED_MS + 1),
      }),
    ).toEqual({ state: 'ended', reason: 'parent-idle' });
    expect(
      resolveSubagentDisplayState(running, killedMidWork, {
        now: NOW,
        parentLastActivity: ago(SUBAGENT_PARENT_IDLE_ENDED_MS),
      }).state,
    ).toBe('running');
    // A transcript still active keeps it running even when the parent is idle.
    expect(
      resolveSubagentDisplayState(
        running,
        { lastActivityAt: ago(60_000) },
        { now: NOW, parentLastActivity: ago(10 * 3_600_000) },
      ).state,
    ).toBe('running');
    // No transcript at all: the parent alone decides.
    expect(
      resolveSubagentDisplayState(running, null, {
        now: new Date(NOW),
        parentLastActivity: ago(7 * 3_600_000).toISOString(),
      }).state,
    ).toBe('ended');
  });

  it('honors meta flags on a running lifecycle', () => {
    expect(resolveSubagentDisplayState(running, { stoppedByUser: true }, { now: NOW })).toEqual({
      state: 'stopped',
      reason: 'meta',
    });
    expect(resolveSubagentDisplayState(running, { finished: true }, { now: NOW })).toEqual({
      state: 'completed',
      reason: 'meta',
    });
  });

  it('labels every state', () => {
    const labels: Record<SubagentDisplayStateName, string> = {
      running: 'running',
      'finished-unreported': 'finished (no report)',
      ended: 'ended',
      completed: 'completed',
      failed: 'failed',
      stopped: 'stopped',
      killed: 'killed',
    };
    for (const [state, label] of Object.entries(labels)) {
      expect(subagentDisplayLabel(state as SubagentDisplayStateName)).toBe(label);
    }
  });
});
