/**
 * Every name the activity pipeline reads from a session file — a shell
 * program, a tool name, an MCP server, a model id, a subagent id, a tool-use
 * id — is fed every `Object.prototype` member. None may throw, every call
 * must land on a real station, and nothing may leak onto `Object.prototype`.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { SessionEvent } from '../types/sessionEvent';
import { classifyActivityShell, classifyActivityTool } from './classify';
import { createActivityRecorder } from './recorder';
import {
  applyActivityRecord,
  applyActivityRecords,
  createActivityState,
  snapshotActivity,
} from './state';
import { isActivityStationId } from './stations';
import type { ActivityClassifyOptions } from './types';

const NAMES = Object.getOwnPropertyNames(Object.prototype);
const PROTOTYPE_KEYS = Object.getOwnPropertyNames(Object.prototype).sort();
const OVERRIDES: ActivityClassifyOptions = {
  stationOverrides: { servers: { docs: 'files' }, tools: { Read: 'files' } },
};

function assistant(model: string, content: unknown[]): SessionEvent {
  return {
    type: 'assistant',
    timestamp: '2026-11-01T10:00:00.000Z',
    message: { role: 'assistant', id: `m-${model}`, model, content },
  } as SessionEvent;
}

function results(ids: string[]): SessionEvent {
  return {
    type: 'user',
    timestamp: '2026-11-01T10:00:05.000Z',
    message: {
      role: 'user',
      content: ids.map((id) => ({ type: 'tool_result', tool_use_id: id, content: 'ok' })),
    },
  } as SessionEvent;
}

afterEach(() => {
  // A failure here means a session file could change every object in the process.
  expect(Object.getOwnPropertyNames(Object.prototype).sort()).toEqual(PROTOTYPE_KEYS);
});

describe('activity input named after Object.prototype members', () => {
  it.each(NAMES)('classifies the shell program %s', (name) => {
    for (const command of [
      name,
      `${name} x`,
      `sudo ${name}`,
      `uv run ${name}`,
      `echo hi | ${name}`,
      `echo $(${name})`,
      `cat <<EOF\n${name}\nEOF`,
      `grep "a\\|${name}(" f.ts`,
    ]) {
      const result = classifyActivityShell(command, OVERRIDES);
      expect(isActivityStationId(result.station)).toBe(true);
    }
  });

  it.each(NAMES)('classifies the tool, MCP server and override named %s', (name) => {
    for (const tool of [name, `mcp__${name}__search`, `mcp__docs__${name}`]) {
      const result = classifyActivityTool(tool, { command: name }, OVERRIDES);
      expect(isActivityStationId(result.station)).toBe(true);
    }
  });

  it.each(NAMES)('records model, subagent and call ids named %s', (name) => {
    const recorder = createActivityRecorder({ providerId: 'claude-code' });
    const records = recorder.observeMany([
      assistant(name, [
        { type: 'tool_use', id: name, name: 'Bash', input: { command: name } },
        { type: 'tool_use', id: `agent-${name}`, name: 'Agent', input: { subagent_type: name } },
      ]),
      results([name, `agent-${name}`]),
    ]);
    const seqs = records.map((record) => record.seq);
    expect(seqs).toEqual(seqs.map((_, index) => seqs[0] + index));

    const state = createActivityState();
    applyActivityRecords(state, records);
    const snapshot = snapshotActivity(state);
    for (const station of snapshot.stations) {
      expect(isActivityStationId(station.id)).toBe(true);
    }
    // Both calls were recorded and both ended: none was silently dropped.
    expect(records.filter((record) => record.kind === 'toolStart')).toHaveLength(2);
    expect(snapshot.stations.reduce((sum, station) => sum + station.running, 0)).toBe(0);
    expect(({} as Record<string, unknown>).steps).toBeUndefined();
    expect(({} as Record<string, unknown>).lastAt).toBeUndefined();
  });

  it.each(NAMES)('starts and ends a subagent whose id is %s', (name) => {
    const state = createActivityState();
    applyActivityRecord(state, {
      kind: 'subagentStart',
      seq: 0,
      at: 1000,
      agentId: name,
      label: 'helper',
    });
    const started = snapshotActivity(state).agents;
    // `__proto__` cannot be a key of the agents map; every other name is recorded.
    if (name === '__proto__') {
      expect(started).toEqual([]);
    } else {
      expect(started.map((agent) => agent.agentId)).toEqual([name]);
    }
    applyActivityRecord(state, {
      kind: 'subagentEnd',
      seq: 1,
      at: 2000,
      agentId: name,
      outcome: 'ok',
    });
    expect(snapshotActivity(state).agents).toEqual([]);
    // Ending an agent that never started must not delete anything inherited.
    applyActivityRecord(state, {
      kind: 'subagentEnd',
      seq: 2,
      at: 3000,
      agentId: name,
      outcome: 'ok',
    });
    expect(typeof ({} as Record<string, unknown>).toString).toBe('function');
  });
});
