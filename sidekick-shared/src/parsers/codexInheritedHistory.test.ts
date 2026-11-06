import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as zlib from 'zlib';
import {
  CHILD_ID,
  PARENT_ID,
  childRollout,
  grandchildRollout,
  parentRollout,
  toJsonl,
  type CodexFixtureRow,
} from '../testing/codexSubagentFixtures';
import { readCodexInheritedHistoryBoundary } from '../providers/codexRollouts';
import {
  codexInheritedHistoryBoundary,
  isCodexInheritedRecord,
  parseCodexInheritedHistoryBoundary,
  type CodexInheritedHistoryBoundary,
} from './codexInheritedHistory';

const CWD = '/work/repo';

function meta(payload: Record<string, unknown>, ordinal = 0): CodexFixtureRow {
  return {
    timestamp: '2026-10-31T01:00:00.000Z',
    type: 'session_meta',
    ordinal,
    payload: { id: 'own', cwd: CWD, ...payload },
  };
}

function event(ordinal: number, type = 'task_started'): CodexFixtureRow {
  return { timestamp: '2026-10-31T01:00:01.000Z', type: 'event_msg', ordinal, payload: { type } };
}

const boundaryOf = (records: unknown[], complete = false): CodexInheritedHistoryBoundary =>
  codexInheritedHistoryBoundary(records, { complete });

describe('codexInheritedHistoryBoundary', () => {
  it('proves a forked child from the ancestor session_meta at ordinal 1', () => {
    const rows = childRollout({ cwd: CWD });
    expect(boundaryOf(rows, true)).toEqual({
      status: 'proven',
      proof: 'embedded-ancestor-meta',
      ownFromOrdinal: 6,
      embeddedMetaOrdinal: 1,
      startMarker: 'thread_settings_applied',
      forkedFromId: PARENT_ID,
      parentId: PARENT_ID,
      isSubagent: true,
    });
    // The first two records already decide it; the marker needs the record at S.
    expect(boundaryOf(rows.slice(0, 2))).toMatchObject({ status: 'proven', ownFromOrdinal: 6 });
    expect(boundaryOf(rows.slice(0, 2)).startMarker).toBeUndefined();
    // Without Codex's start marker the first own record names itself.
    expect(boundaryOf(childRollout({ cwd: CWD, withoutStartMarker: true }))).toMatchObject({
      status: 'proven',
      startMarker: 'task_started',
    });
    // A grandchild embeds the child's meta: its own fork parent.
    expect(boundaryOf(grandchildRollout({ cwd: CWD }))).toMatchObject({
      status: 'proven',
      ownFromOrdinal: 3,
      forkedFromId: CHILD_ID,
    });
  });

  it('is pending until the record at ordinal 1 is read', () => {
    const [own] = childRollout({ cwd: CWD });
    expect(boundaryOf([own])).toMatchObject({
      status: 'pending',
      reason: 'awaiting-records',
      isSubagent: true,
    });
    expect(boundaryOf([own], true)).toMatchObject({
      status: 'unproven',
      reason: 'no-embedded-meta',
    });
    expect(boundaryOf([])).toEqual({
      status: 'pending',
      reason: 'awaiting-records',
      isSubagent: false,
    });
    expect(boundaryOf([], true)).toEqual({ status: 'none', reason: 'empty', isSubagent: false });
  });

  it('does not prove a start ordinal without the embedded ancestor meta', () => {
    const rows = childRollout({ cwd: CWD });
    // Codex 0.146: the start ordinal was written, the history was not.
    expect(boundaryOf(rows.filter((_row, index) => index !== 1))).toMatchObject({
      status: 'unproven',
      reason: 'no-embedded-meta',
    });
    // The ancestor meta only counts at ordinal 1.
    const late = [rows[0], event(1, 'turn_context'), { ...rows[1], ordinal: 2 }];
    expect(boundaryOf(late)).toMatchObject({ status: 'unproven', reason: 'no-embedded-meta' });
    // A session_meta at ordinal 1 that is not an ancestor's proves nothing.
    const stranger = { ...rows[1], payload: { id: 'someone-else', cwd: '/x' } };
    expect(boundaryOf([rows[0], stranger])).toMatchObject({
      status: 'unproven',
      reason: 'unrelated-embedded-meta',
    });
    const own = { ...rows[1], payload: { id: CHILD_ID, cwd: CWD } };
    expect(boundaryOf([rows[0], own])).toMatchObject({ reason: 'unrelated-embedded-meta' });
  });

  it('reports the start ordinal cases that inherit nothing or cannot be trusted', () => {
    expect(boundaryOf([meta({ subagent_history_start_ordinal: 1 }), event(1)])).toMatchObject({
      status: 'none',
      reason: 'starts-at-own-records',
    });
    expect(boundaryOf([meta({ subagent_history_start_ordinal: 1 })], true)).toMatchObject({
      status: 'none',
    });
    for (const start of [0, -2, 2.5, '3', {}]) {
      expect(
        boundaryOf([meta({ subagent_history_start_ordinal: start }), event(1)]),
        String(start),
      ).toMatchObject({ status: 'unproven', reason: 'invalid-start-ordinal' });
    }
  });

  it('flags forks, object sources, and history bases without a start ordinal', () => {
    expect(boundaryOf([meta({ forked_from_id: PARENT_ID, source: 'cli' })])).toMatchObject({
      status: 'unproven',
      reason: 'forked',
      forkedFromId: PARENT_ID,
      parentId: PARENT_ID,
      isSubagent: false,
    });
    const spawned = { subagent: { thread_spawn: { parent_thread_id: PARENT_ID, depth: 1 } } };
    expect(boundaryOf([meta({ source: spawned }), event(1)])).toMatchObject({
      status: 'unproven',
      reason: 'object-source',
      parentId: PARENT_ID,
      isSubagent: true,
    });
    expect(boundaryOf([meta({ source: JSON.stringify(spawned) })])).toMatchObject({
      reason: 'object-source',
    });
    const historyBase = { thread_id: PARENT_ID, end_ordinal_exclusive: 40, end_byte_offset: 9000 };
    expect(boundaryOf([meta({ source: 'cli', history_base: historyBase })])).toMatchObject({
      status: 'unproven',
      reason: 'history-base',
      historyBase: { threadId: PARENT_ID, endOrdinalExclusive: 40, endByteOffset: 9000 },
    });
    // Reported alongside a proven start ordinal, without changing it.
    const rows = childRollout({ cwd: CWD });
    const based = [
      { ...rows[0], payload: { ...(rows[0].payload as object), history_base: historyBase } },
      rows[1],
    ];
    expect(boundaryOf(based)).toMatchObject({
      status: 'proven',
      historyBase: { threadId: PARENT_ID },
    });
  });

  it('says a plain session inherits nothing', () => {
    expect(boundaryOf(parentRollout({ cwd: CWD }))).toEqual({
      status: 'none',
      reason: 'not-inherited',
      isSubagent: false,
    });
    expect(boundaryOf([event(0)])).toEqual({
      status: 'unproven',
      reason: 'no-session-meta',
      isSubagent: false,
    });
    expect(boundaryOf([null])).toMatchObject({ status: 'pending' });
  });
});

describe('isCodexInheritedRecord', () => {
  it('marks only ordinals 1 … S-1 of a proven fork', () => {
    const rows = childRollout({ cwd: CWD });
    const boundary = boundaryOf(rows);
    expect(rows.map((row) => isCodexInheritedRecord(boundary, row))).toEqual(
      rows.map((row) => (row.ordinal as number) >= 1 && (row.ordinal as number) < 6),
    );
    expect(isCodexInheritedRecord(boundary, { type: 'event_msg', payload: {} })).toBe(false);
    const unproven = boundaryOf(rows.filter((_row, index) => index !== 1));
    expect(rows.some((row) => isCodexInheritedRecord(unproven, row))).toBe(false);
  });

  it('round-trips through JSON and rejects malformed boundaries', () => {
    const boundary = boundaryOf(childRollout({ cwd: CWD }));
    expect(parseCodexInheritedHistoryBoundary(JSON.parse(JSON.stringify(boundary)))).toEqual(
      boundary,
    );
    for (const bad of [
      null,
      'proven',
      { status: 'proven', isSubagent: true },
      { status: 'proven', isSubagent: true, proof: 'embedded-ancestor-meta', ownFromOrdinal: 1 },
      { status: 'none', isSubagent: false },
      { status: 'none', isSubagent: false, reason: 'because' },
      { status: 'maybe', isSubagent: false, reason: 'empty' },
      { status: 'none', reason: 'empty' },
    ]) {
      expect(parseCodexInheritedHistoryBoundary(bad), JSON.stringify(bad)).toBeUndefined();
    }
  });
});

describe('readCodexInheritedHistoryBoundary', () => {
  let dir: string;
  const zstdCompressSync = (zlib as unknown as { zstdCompressSync?: (input: Buffer) => Buffer })
    .zstdCompressSync;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-inherited-history-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  function write(name: string, text: string): string {
    const file = path.join(dir, name);
    fs.writeFileSync(file, text);
    return file;
  }

  it('reads a forked child rollout, with a first line of any size', async () => {
    const rows = childRollout({ cwd: CWD });
    const huge = {
      ...rows[0],
      payload: { ...(rows[0].payload as object), base_instructions: { text: 'i'.repeat(300_000) } },
    };
    const file = write('child.jsonl', toJsonl([huge, ...rows.slice(1)]));
    expect(await readCodexInheritedHistoryBoundary(file)).toEqual({
      status: 'proven',
      proof: 'embedded-ancestor-meta',
      ownFromOrdinal: 6,
      embeddedMetaOrdinal: 1,
      forkedFromId: PARENT_ID,
      parentId: PARENT_ID,
      isSubagent: true,
    });
    const located = await readCodexInheritedHistoryBoundary(file, { locateOwnStart: true });
    expect(located).toMatchObject({ status: 'proven', startMarker: 'thread_settings_applied' });
    const text = fs.readFileSync(file, 'utf8');
    const lineAt = text.slice(located.ownStartOffset).split('\n', 1)[0];
    expect(JSON.parse(lineAt)).toMatchObject({ ordinal: 6 });
  });

  it('stays pending while a live rollout has only its first line', async () => {
    const rows = childRollout({ cwd: CWD });
    const partial = write('fresh.jsonl', `${JSON.stringify(rows[0])}\n{"timestamp":`);
    expect(await readCodexInheritedHistoryBoundary(partial)).toMatchObject({
      status: 'pending',
      reason: 'awaiting-records',
    });
    const stopped = await readCodexInheritedHistoryBoundary(write('stopped.jsonl', toJsonl(rows)), {
      maxScanBytes: 10,
    });
    expect(stopped).toMatchObject({ status: 'pending', reason: 'scan-limit' });
    expect(await readCodexInheritedHistoryBoundary(path.join(dir, 'missing.jsonl'))).toMatchObject({
      status: 'pending',
    });
  });

  it('reads plain and non-forked rollouts from their first records', async () => {
    const parent = write('parent.jsonl', toJsonl(parentRollout({ cwd: CWD })));
    expect(await readCodexInheritedHistoryBoundary(parent)).toMatchObject({
      status: 'none',
      reason: 'not-inherited',
    });
    const grandchild = write('grandchild.jsonl', toJsonl(grandchildRollout({ cwd: CWD })));
    expect(
      await readCodexInheritedHistoryBoundary(grandchild, { locateOwnStart: true }),
    ).toMatchObject({ status: 'proven', ownFromOrdinal: 3, forkedFromId: CHILD_ID });
  });

  it.skipIf(typeof zstdCompressSync !== 'function')(
    'reads a compressed rollout, which is complete',
    async () => {
      const rows = childRollout({ cwd: CWD });
      const compressed = path.join(dir, 'child.jsonl.zst');
      fs.writeFileSync(compressed, zstdCompressSync!(Buffer.from(toJsonl(rows))));
      expect(
        await readCodexInheritedHistoryBoundary(compressed, { locateOwnStart: true }),
      ).toMatchObject({ status: 'proven', startMarker: 'thread_settings_applied' });
      // Complete: a lone first line is final, and its last line needs no newline.
      const lone = path.join(dir, 'lone.jsonl.zst');
      fs.writeFileSync(lone, zstdCompressSync!(Buffer.from(JSON.stringify(rows[0]))));
      expect(await readCodexInheritedHistoryBoundary(lone)).toMatchObject({
        status: 'unproven',
        reason: 'no-embedded-meta',
      });
    },
  );
});
