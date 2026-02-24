/**
 * Session snapshot sidecar — persists aggregator state + reader position
 * so that re-attaching to a session skips full replay.
 *
 * Snapshots are stored in ~/.config/sidekick/snapshots/{sessionId}.json.
 * They are invalidated when the source file changes beyond the snapshot position.
 *
 * @module aggregation/snapshot
 */

import * as fs from 'fs';
import * as path from 'path';
import { getConfigDir } from '../paths';
import type { SerializedAggregatorState } from './EventAggregator';

/** Current schema version — bump when format changes. */
const SNAPSHOT_VERSION = 1;

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
 * Creates the snapshots directory if it doesn't exist.
 * Writes atomically via rename to avoid partial reads.
 */
export function saveSnapshot(snapshot: SessionSnapshot): void {
  try {
    const dir = getSnapshotsDir();
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const filePath = getSnapshotPath(snapshot.sessionId);
    const tmpPath = filePath + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(snapshot), 'utf-8');
    fs.renameSync(tmpPath, filePath);
  } catch {
    // Non-critical — snapshot failure should never break session monitoring
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
 * The caller is responsible for staleness checks (comparing sourceSize
 * and readerPosition against the actual file).
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
 * For JSONL providers: checks that the file hasn't been truncated
 * (current size >= snapshot position) and that the size matches or has grown.
 *
 * For DB-backed providers: sourceSize is 0, so we always consider valid
 * (the DB reader's timestamp-based cursor handles staleness naturally).
 */
export function isSnapshotValid(
  snapshot: SessionSnapshot,
  currentSourceSize: number,
): boolean {
  // DB-backed providers store sourceSize=0 — always valid (cursor is a timestamp)
  if (snapshot.sourceSize === 0) {
    return true;
  }

  // File was truncated or rewritten (smaller than when we snapshotted)
  if (currentSourceSize < snapshot.readerPosition) {
    return false;
  }

  return true;
}
