/**
 * Session snapshot sidecar — persists aggregator state + reader position
 * so that re-attaching to a session skips full replay.
 *
 * Snapshots are stored in `<config dir>/snapshots/{sessionId}.json` (see
 * `getConfigDir()`). They are invalidated when the source file shrank below
 * the snapshot position or, for file-backed sessions that recorded a
 * {@link SessionSnapshot.sourceCheckpoint}, when the file is no longer the
 * same append-only file.
 *
 * @module aggregation/snapshot
 */

import * as fs from 'fs';
import * as path from 'path';
import { getConfigDir } from '../paths';
import { verifyJsonlCheckpoint, type JsonlTailCheckpoint } from '../watchers/jsonlTail';
import { atomicWriteJsonSync } from '../writers/atomic';
import { SNAPSHOT_SCHEMA_VERSION, type SerializedAggregatorState } from './EventAggregator';

/** Current schema version — bump when format changes. */
const SNAPSHOT_VERSION = SNAPSHOT_SCHEMA_VERSION;

/** Newest snapshots kept on disk; older ones are pruned opportunistically. */
export const MAX_SNAPSHOT_FILES = 200;
/** Prune runs once per this many saves, so steady-state writes stay one file each. */
const PRUNE_EVERY_N_SAVES = 25;
let savesSincePrune = 0;

/** Snapshot sidecar file content. */
export interface SessionSnapshot {
  /** Schema version for forward-compatibility checks. */
  version: number;
  /** Session identifier (from provider.getSessionId). */
  sessionId: string;
  /** Provider identifier (claude-code, opencode, codex). */
  providerId: string;
  /** Reader position at snapshot time (byte offset or timestamp). */
  readerPosition: number;
  /** Source file size at snapshot time (for staleness check; 0 for DB-backed). */
  sourceSize: number;
  /**
   * Identity of the source file at `readerPosition`, from
   * `captureJsonlCheckpoint(sourcePath, readerPosition)`: its device and
   * inode plus a digest of its first bytes. Present for file-backed sessions
   * written by 0.29.1 and later; absent for DB-backed sessions and older
   * snapshots. {@link isSnapshotValid} checks it when given the source path.
   */
  sourceCheckpoint?: JsonlTailCheckpoint;
  /**
   * The reader's parse state at `readerPosition`, from
   * `SessionReader.getResumeState()` or `SessionWatcher.getResumeState()`
   * (for Claude Code, which split-line responses were already counted).
   * After seeking to `readerPosition`, pass it to `restoreResumeState()` and
   * replay from the start when that returns false. Absent when the reader
   * keeps none, and in snapshots written before 0.29.1.
   */
  readerState?: unknown;
  /** ISO timestamp when snapshot was written. */
  createdAt: string;
  /** Serialized EventAggregator state. */
  aggregator: SerializedAggregatorState;
  /** Serialized consumer-specific state (SessionMonitor fields, DashboardState fields, etc.). */
  consumer: Record<string, unknown>;
}

/** Returns the directory for snapshot files. */
function getSnapshotsDir(): string {
  return path.join(getConfigDir(), 'snapshots');
}

/** Returns the path to a snapshot file for a given session. */
export function getSnapshotPath(sessionId: string): string {
  // Sanitize sessionId for filesystem safety (remove path separators)
  const safe = sessionId.replace(/[/\\:]/g, '_');
  return path.join(getSnapshotsDir(), `${safe}.json`);
}

/**
 * Saves a session snapshot to disk.
 *
 * Creates the snapshots directory if it doesn't exist. Uses the shared
 * fsynced atomic writer with a per-process temp name, so the CLI dashboard and
 * the extension host snapshotting the same session cannot collide on a shared
 * `.tmp` file. Every {@link PRUNE_EVERY_N_SAVES} saves the directory is
 * trimmed to the newest {@link MAX_SNAPSHOT_FILES}; snapshots are caches, so
 * dropping an old one only costs a replay.
 */
export function saveSnapshot(snapshot: SessionSnapshot): void {
  try {
    const dir = getSnapshotsDir();
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    atomicWriteJsonSync(getSnapshotPath(snapshot.sessionId), snapshot);
    savesSincePrune += 1;
    if (savesSincePrune >= PRUNE_EVERY_N_SAVES) {
      savesSincePrune = 0;
      pruneSnapshots(MAX_SNAPSHOT_FILES);
    }
  } catch {
    // Non-critical — snapshot failure should never break session monitoring
  }
}

/**
 * Deletes all but the newest `keep` snapshot files (by modification time).
 * Returns how many files were removed. Best-effort; never throws.
 */
export function pruneSnapshots(keep: number = MAX_SNAPSHOT_FILES): number {
  try {
    const dir = getSnapshotsDir();
    const entries = fs
      .readdirSync(dir)
      .filter((name) => name.endsWith('.json'))
      .map((name) => {
        const filePath = path.join(dir, name);
        try {
          return { filePath, mtimeMs: fs.statSync(filePath).mtimeMs };
        } catch {
          return null;
        }
      })
      .filter((entry): entry is { filePath: string; mtimeMs: number } => entry !== null)
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    let removed = 0;
    for (const entry of entries.slice(Math.max(0, keep))) {
      try {
        fs.unlinkSync(entry.filePath);
        removed += 1;
      } catch {
        // Already gone or locked; skip.
      }
    }
    return removed;
  } catch {
    return 0;
  }
}

/**
 * Loads a session snapshot from disk if it exists and is valid.
 *
 * Returns null if:
 * - No snapshot file exists
 * - Schema version doesn't match
 * - JSON parse fails
 *
 * The caller is responsible for staleness checks against the actual file:
 * `isSnapshotValid(snapshot, currentSize, sourcePath)`.
 */
export function loadSnapshot(sessionId: string): SessionSnapshot | null {
  try {
    const filePath = getSnapshotPath(sessionId);
    if (!fs.existsSync(filePath)) {
      return null;
    }

    const raw = fs.readFileSync(filePath, 'utf-8');
    const snapshot = JSON.parse(raw) as SessionSnapshot;

    // Version check
    if (snapshot.version !== SNAPSHOT_VERSION) {
      deleteSnapshot(sessionId);
      return null;
    }

    return snapshot;
  } catch {
    // Corrupt or unreadable — delete and move on
    deleteSnapshot(sessionId);
    return null;
  }
}

/**
 * Deletes a session snapshot file.
 */
export function deleteSnapshot(sessionId: string): void {
  try {
    const filePath = getSnapshotPath(sessionId);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch {
    // Best-effort cleanup
  }
}

/**
 * Validates whether a snapshot is still usable for a given source file.
 *
 * For DB-backed providers: sourceSize is 0, so we always consider valid
 * (the DB reader's timestamp-based cursor handles staleness naturally).
 *
 * For JSONL providers: the file must not have shrunk below the snapshot
 * position. With `sourcePath` the check is also content-aware: the snapshot
 * must carry a {@link SessionSnapshot.sourceCheckpoint} for exactly
 * `readerPosition`, and that checkpoint must still match the file at
 * `sourcePath` (same device and inode, same first bytes, position just after
 * a newline), so a file replaced by another one or rewritten to the same or
 * a larger size is not resumed mid-content. A snapshot without a checkpoint
 * (written before 0.29.1) is invalid when `sourcePath` is given, which costs
 * one full replay. Without `sourcePath` only the size check applies, as it
 * did before.
 */
export function isSnapshotValid(
  snapshot: SessionSnapshot,
  currentSourceSize: number,
  sourcePath?: string,
): boolean {
  // DB-backed providers store sourceSize=0 — always valid (cursor is a timestamp)
  if (snapshot.sourceSize === 0) {
    return true;
  }

  // File was truncated or rewritten (smaller than when we snapshotted)
  if (currentSourceSize < snapshot.readerPosition) {
    return false;
  }

  if (typeof sourcePath !== 'string') {
    return true;
  }

  // Snapshot content comes from disk: guard the shape before trusting it.
  const checkpoint: unknown = snapshot.sourceCheckpoint;
  if (
    !checkpoint ||
    typeof checkpoint !== 'object' ||
    (checkpoint as { offset?: unknown }).offset !== snapshot.readerPosition
  ) {
    return false;
  }
  return verifyJsonlCheckpoint(sourcePath, checkpoint);
}
