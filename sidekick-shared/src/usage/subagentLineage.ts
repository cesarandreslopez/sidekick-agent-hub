/**
 * Which prompt of the root session a subagent was started under.
 *
 * A Claude Code subagent's transcript lives under its session, which is the
 * root; it started at its transcript's first record. A Codex subagent is a
 * rollout of its own: its root is `session_meta.session_id` when recorded,
 * else the end of its `parentSessionId` chain (at most 16 links, cycles
 * refused), and it started at `session_meta.payload.timestamp`. The prompt
 * in effect is the highest ordinal among the root's prompts timestamped at
 * or before that start.
 *
 * Node-only: reads rollout heads.
 *
 * @internal
 * @module usage/subagentLineage
 */

import * as fs from 'fs';
import { codexRolloutOrigin } from '../parsers/codexRolloutOrigin';
import type { PromptOrdinalMark } from '../promptHistory';
import { readFirstLineAsync } from '../providers/codexRollouts';

/** Links followed from a Codex subagent to its root. */
export const MAX_LINEAGE_DEPTH = 16;

export type SubagentKind = 'subagent' | 'fork';

/** What a Codex rollout's first line says about where it came from. */
export interface CodexRolloutHead {
  sessionId: string;
  /** The session it was spawned or forked from. */
  parentId?: string;
  /** `session_meta.session_id`, when it names another session (the root). */
  recordedRootId?: string;
  /** Spawned by an agent (`subagent`) or forked by a person (`fork`); absent for a root. */
  kind?: SubagentKind;
  /** `session_meta.payload.timestamp`, ms since epoch. */
  startMs: number | null;
  cwd: string | null;
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** The head of a rollout from its parsed first record. */
export function codexRolloutHead(sessionId: string, first: unknown): CodexRolloutHead {
  const origin = codexRolloutOrigin(first);
  const row = recordOf(first);
  const payload = row?.type === 'session_meta' ? recordOf(row.payload) : undefined;
  const recorded = typeof payload?.session_id === 'string' ? payload.session_id : undefined;
  const started = typeof payload?.timestamp === 'string' ? Date.parse(payload.timestamp) : NaN;
  const parentId = origin.parentId && origin.parentId !== sessionId ? origin.parentId : undefined;
  const kind: SubagentKind | undefined = parentId
    ? origin.isSubagent
      ? 'subagent'
      : origin.forkedFromId
        ? 'fork'
        : undefined
    : undefined;
  return {
    sessionId,
    ...(parentId && kind ? { parentId, kind } : {}),
    ...(recorded && recorded !== sessionId ? { recordedRootId: recorded } : {}),
    startMs: Number.isFinite(started) ? started : null,
    cwd: typeof payload?.cwd === 'string' && payload.cwd ? payload.cwd : null,
  };
}

/** Read and parse a rollout's first line; null when unreadable. */
export async function readCodexRolloutHead(
  sessionId: string,
  filePath: string,
): Promise<CodexRolloutHead | null> {
  try {
    const { line } = await readFirstLineAsync(filePath);
    if (!line) return null;
    return codexRolloutHead(sessionId, JSON.parse(line));
  } catch {
    return null;
  }
}

export interface ResolvedRoot {
  /** The root session's id, when it could be determined. */
  rootSessionId?: string;
  /** The root's head, when its rollout was found. */
  root: CodexRolloutHead | null;
}

/**
 * The root of a Codex subagent or fork: `session_meta.session_id` when the
 * rollout recorded one, else the end of its parent chain. `find` looks a
 * session up by id (null when its rollout is not found).
 */
export async function resolveCodexRoot(
  head: CodexRolloutHead,
  find: (sessionId: string) => Promise<CodexRolloutHead | null>,
): Promise<ResolvedRoot> {
  if (head.recordedRootId) {
    return { rootSessionId: head.recordedRootId, root: await find(head.recordedRootId) };
  }
  let current = head;
  const seen = new Set([head.sessionId]);
  for (let depth = 0; depth < MAX_LINEAGE_DEPTH; depth++) {
    if (!current.parentId) {
      return current === head
        ? { root: null }
        : { rootSessionId: current.sessionId, root: current };
    }
    if (seen.has(current.parentId)) return { root: null };
    seen.add(current.parentId);
    const parent = await find(current.parentId);
    if (!parent) return { root: null };
    current = parent;
  }
  return { root: null };
}

/** Highest ordinal among prompts timestamped at or before `ms`; null when none. */
export function ordinalAtOrBefore(
  marks: readonly PromptOrdinalMark[],
  ms: number | null | undefined,
): number | null {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return null;
  let best: number | null = null;
  for (const mark of marks) {
    if (Number.isFinite(mark.timestampMs) && mark.timestampMs <= ms) {
      if (best === null || mark.ordinal > best) best = mark.ordinal;
    }
  }
  return best;
}

/**
 * The first record timestamp of a transcript (a Claude Code subagent's
 * start), reading at most `maxBytes` from the start. Null when none parses.
 */
export async function readFirstRecordTimestamp(
  filePath: string,
  maxBytes = 256 * 1024,
): Promise<number | null> {
  let handle: fs.promises.FileHandle | null = null;
  try {
    handle = await fs.promises.open(filePath, 'r');
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
    const lines = buffer.toString('utf8', 0, bytesRead).split('\n');
    if (bytesRead === maxBytes) lines.pop();
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const timestamp = (JSON.parse(trimmed) as { timestamp?: unknown }).timestamp;
        const ms = typeof timestamp === 'string' ? Date.parse(timestamp) : NaN;
        if (Number.isFinite(ms)) return ms;
      } catch {
        // Partial or malformed line; keep looking.
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}
