import { describe, expect, it } from 'vitest';
import { spawnParentFromSource } from '../providers/codexDatabase';
import { codexRolloutOrigin, codexSpawnParentFromSource } from './codexRolloutOrigin';

const PARENT = '019d86b0-0000-7000-8000-00000000000a';
const CHILD = '019d86b0-0000-7000-8000-00000000000b';

function meta(payload: Record<string, unknown>) {
  return { timestamp: '2026-09-01T10:00:00.000Z', type: 'session_meta', payload };
}

const plain = meta({ id: CHILD, cwd: '/work/repo', source: 'cli' });
const fork = meta({ id: CHILD, cwd: '/work/repo', source: 'vscode', forked_from_id: PARENT });
const spawned = meta({
  id: CHILD,
  session_id: PARENT,
  cwd: '/work/repo',
  source: {
    subagent: {
      thread_spawn: {
        parent_thread_id: PARENT,
        depth: 1,
        agent_path: 'agents/scout',
        agent_nickname: 'Scout',
        agent_role: null,
      },
    },
  },
  forked_from_id: PARENT,
  parent_thread_id: PARENT,
});
const guardian = meta({
  id: CHILD,
  cwd: '/work/repo',
  source: { subagent: { other: 'guardian' } },
  parent_thread_id: PARENT,
});

describe('codexRolloutOrigin', () => {
  it('reads a plain interactive session', () => {
    expect(codexRolloutOrigin(plain)).toEqual({ source: 'cli', isSubagent: false });
  });

  it('reads a fork of another session', () => {
    expect(codexRolloutOrigin(fork)).toEqual({
      forkedFromId: PARENT,
      source: 'vscode',
      isSubagent: false,
      parentId: PARENT,
    });
  });

  it('reads a spawned subagent', () => {
    expect(codexRolloutOrigin(spawned)).toEqual({
      forkedFromId: PARENT,
      source: 'subagent',
      isSubagent: true,
      parentId: PARENT,
      subagentKind: 'thread_spawn',
    });
    // Without forked_from_id the parent still comes from the spawn record.
    const { forked_from_id: _fork, ...rest } = spawned.payload;
    expect(codexRolloutOrigin(meta(rest))).toMatchObject({
      isSubagent: true,
      parentId: PARENT,
    });
    expect(codexRolloutOrigin(meta(rest)).forkedFromId).toBeUndefined();
  });

  it('reads internal subagents with no spawn record', () => {
    expect(codexRolloutOrigin(guardian)).toEqual({
      source: 'subagent',
      isSubagent: true,
      parentId: PARENT,
      subagentKind: 'guardian',
    });
    expect(codexRolloutOrigin(meta({ id: CHILD, source: { subagent: 'review' } }))).toEqual({
      source: 'subagent',
      isSubagent: true,
      subagentKind: 'review',
    });
  });

  it('accepts the payload alone, JSON source text, and the records in order', () => {
    expect(codexRolloutOrigin(spawned.payload)).toEqual(codexRolloutOrigin(spawned));
    expect(
      codexRolloutOrigin(
        meta({ ...spawned.payload, source: JSON.stringify(spawned.payload.source) }),
      ),
    ).toEqual(codexRolloutOrigin(spawned));
    // A fork embeds its parent's session_meta after its own: the first wins.
    const records = [
      fork,
      meta({ id: PARENT, cwd: '/work/repo', source: 'cli' }),
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [] } },
    ];
    expect(codexRolloutOrigin(records)).toEqual(codexRolloutOrigin(fork));
    expect(codexRolloutOrigin([{ type: 'turn_context', payload: {} }, plain])).toEqual(
      codexRolloutOrigin(plain),
    );
  });

  it('returns a non-subagent origin for anything that is not session metadata', () => {
    for (const input of [
      undefined,
      null,
      'cli',
      42,
      [],
      [{ type: 'event_msg', payload: {} }],
      { type: 'event_msg', payload: { source: { subagent: 'review' } } },
      meta({ id: CHILD, source: { unknown: true } }),
      meta({ id: CHILD, source: '{not json' }),
    ]) {
      expect(codexRolloutOrigin(input)).toMatchObject({ isSubagent: false });
      expect(codexRolloutOrigin(input).parentId).toBeUndefined();
    }
  });

  it('applies the same spawn-parent rule as the state database', () => {
    for (const source of [
      spawned.payload.source,
      JSON.stringify(spawned.payload.source),
      guardian.payload.source,
      JSON.stringify(guardian.payload.source),
      'cli',
      '{broken',
      null,
      { subagent: { thread_spawn: { parent_thread_id: 7 } } },
    ]) {
      expect(codexSpawnParentFromSource(source)).toBe(spawnParentFromSource(source));
    }
  });
});
