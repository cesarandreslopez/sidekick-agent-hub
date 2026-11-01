import {
  appendFileSync,
  mkdtempSync,
  renameSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setConfigDir } from '../paths';
import { captureJsonlCheckpoint } from '../watchers/jsonlTail';
import { SNAPSHOT_SCHEMA_VERSION, type SerializedAggregatorState } from './EventAggregator';
import { isSnapshotValid, loadSnapshot, saveSnapshot, type SessionSnapshot } from './snapshot';

const LINES = ['{"type":"user","n":1}\n', '{"type":"assistant","n":2}\n'];
const CONTENT = LINES.join('');

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'sidekick-snapshot-'));
  setConfigDir(path.join(dir, 'config'));
  file = path.join(dir, 'session.jsonl');
  writeFileSync(file, CONTENT);
});

afterEach(() => {
  setConfigDir(undefined);
  rmSync(dir, { recursive: true, force: true });
});

/** A snapshot of `file` read up to `readerPosition`, as both dashboards persist it. */
function snapshotOf(
  readerPosition = Buffer.byteLength(CONTENT),
  overrides: Partial<SessionSnapshot> = {},
): SessionSnapshot {
  const checkpoint = captureJsonlCheckpoint(file, readerPosition);
  return {
    version: SNAPSHOT_SCHEMA_VERSION,
    sessionId: 'session',
    providerId: 'claude-code',
    readerPosition,
    sourceSize: statSync(file).size,
    createdAt: new Date(0).toISOString(),
    aggregator: { version: SNAPSHOT_SCHEMA_VERSION } as unknown as SerializedAggregatorState,
    consumer: {},
    ...(checkpoint ? { sourceCheckpoint: checkpoint } : {}),
    ...overrides,
  };
}

const size = () => statSync(file).size;

describe('isSnapshotValid', () => {
  it('accepts a snapshot of a file that only grew, after a JSON round trip', () => {
    saveSnapshot(snapshotOf());
    appendFileSync(file, '{"type":"assistant","n":3}\n{"type":"assist');
    const loaded = loadSnapshot('session');
    expect(loaded?.sourceCheckpoint).toMatchObject({ offset: Buffer.byteLength(CONTENT) });
    expect(isSnapshotValid(loaded!, size(), file)).toBe(true);
  });

  it('accepts a snapshot taken mid-file at a line boundary', () => {
    const snapshot = snapshotOf(Buffer.byteLength(LINES[0]));
    expect(isSnapshotValid(snapshot, size(), file)).toBe(true);
  });

  it('rejects a same-size rewrite with different first bytes', () => {
    const snapshot = snapshotOf();
    writeFileSync(file, CONTENT.replace('user', 'USER'));
    expect(size()).toBe(snapshot.sourceSize);
    expect(isSnapshotValid(snapshot, size(), file)).toBe(false);
    // The size-only check cannot tell.
    expect(isSnapshotValid(snapshot, size())).toBe(true);
  });

  it('rejects a file replaced by rename with identical content length', () => {
    const snapshot = snapshotOf();
    const replacement = `${file}.next`;
    writeFileSync(replacement, CONTENT);
    renameSync(replacement, file);
    expect(isSnapshotValid(snapshot, size(), file)).toBe(false);
  });

  it('rejects a snapshot whose position no longer follows a newline', () => {
    const pad = `${JSON.stringify({ type: 'pad', pad: 'x'.repeat(5000) })}\n`;
    writeFileSync(file, `${pad}${LINES[0]}`);
    const snapshot = snapshotOf(Buffer.byteLength(`${pad}${LINES[0]}`));
    expect(snapshot.sourceCheckpoint).toBeDefined();
    // Same inode and first 4 KiB, longer: the last line was rewritten in place.
    writeFileSync(file, `${pad}${LINES[0].replace('\n', ',')}${LINES[1]}`);
    expect(isSnapshotValid(snapshot, size(), file)).toBe(false);
  });

  it('rejects a checkpoint recorded for a different position', () => {
    const snapshot = snapshotOf();
    const atFirstLine = captureJsonlCheckpoint(file, Buffer.byteLength(LINES[0]))!;
    expect(isSnapshotValid({ ...snapshot, sourceCheckpoint: atFirstLine }, size(), file)).toBe(
      false,
    );
  });

  it('rejects a snapshot shrunk below its position, with or without the path', () => {
    const snapshot = snapshotOf();
    truncateSync(file, Buffer.byteLength(LINES[0]));
    expect(isSnapshotValid(snapshot, size(), file)).toBe(false);
    expect(isSnapshotValid(snapshot, size())).toBe(false);
  });

  it('rejects a legacy snapshot without a checkpoint when given the path', () => {
    const { sourceCheckpoint: _omitted, ...legacy } = snapshotOf();
    expect(isSnapshotValid(legacy, size(), file)).toBe(false);
    for (const malformed of [null, 'checkpoint', { offset: legacy.readerPosition }]) {
      const snapshot = { ...legacy, sourceCheckpoint: malformed } as unknown as SessionSnapshot;
      expect(isSnapshotValid(snapshot, size(), file)).toBe(false);
    }
  });

  it('rejects when the source file is gone', () => {
    const snapshot = snapshotOf();
    rmSync(file);
    expect(isSnapshotValid(snapshot, Buffer.byteLength(CONTENT), file)).toBe(false);
  });

  it('keeps the size-only behavior without a path', () => {
    const { sourceCheckpoint: _omitted, ...legacy } = snapshotOf();
    expect(isSnapshotValid(legacy, size())).toBe(true);
    expect(isSnapshotValid(legacy, size() + 100)).toBe(true);
    expect(isSnapshotValid(legacy, size() - 1)).toBe(false);
  });

  it('treats DB-backed snapshots (sourceSize 0) as valid', () => {
    const db = snapshotOf(Buffer.byteLength(CONTENT), {
      providerId: 'opencode',
      readerPosition: 1_760_000_000_000,
      sourceSize: 0,
      sourceCheckpoint: undefined,
    });
    expect(isSnapshotValid(db, 0)).toBe(true);
    expect(isSnapshotValid(db, 0, path.join(dir, 'opencode.db'))).toBe(true);
  });
});
