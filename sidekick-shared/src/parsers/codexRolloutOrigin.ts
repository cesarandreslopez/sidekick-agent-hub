/**
 * Where a Codex rollout came from, read from its `session_meta` record:
 * a session a person started, a fork of another session, or a subagent.
 *
 * Codex writes `session_meta.source` as a plain string for sessions started
 * from a surface (`cli`, `vscode`, `exec`, …) and as an object for subagents:
 * `{ subagent: { thread_spawn: { parent_thread_id, … } } }` for a spawned
 * agent, `{ subagent: { other: 'guardian' } }` for internal reviewers, or
 * `{ subagent: 'review' }`. The same JSON appears as a string in the state
 * database's `threads.source`. A forked rollout records `forked_from_id`, and
 * embeds its parent's `session_meta` after its own, so only the first counts.
 *
 * Pure: no filesystem access. Browser-safe.
 *
 * @module parsers/codexRolloutOrigin
 */

export interface CodexRolloutOrigin {
  /** `session_meta.forked_from_id`: the session this rollout was forked from. */
  forkedFromId?: string;
  /**
   * `session_meta.source` when it is a string (`cli`, `vscode`, `exec`, …),
   * or `'subagent'` when it is a subagent object.
   */
  source?: string;
  /** The rollout was written by a subagent (`source: { subagent: … }`), not a person. */
  isSubagent: boolean;
  /**
   * The parent session: `forkedFromId`, else the spawn's `parent_thread_id`,
   * else (subagents only) the top-level `parent_thread_id`.
   */
  parentId?: string;
  /**
   * Subagent variant: `thread_spawn`, `review`, `compact`, or the name of an
   * `other` subagent (for example `guardian`).
   */
  subagentKind?: string;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** A `source` value as an object: rollouts store it parsed, the database as JSON text. */
function sourceObject(source: unknown): Record<string, unknown> | undefined {
  if (typeof source !== 'string') return record(source);
  if (!source.startsWith('{')) return undefined;
  try {
    return record(JSON.parse(source));
  } catch {
    return undefined;
  }
}

/**
 * Parent thread id of a spawned subagent's `source` (object, or JSON text as
 * stored in `threads.source`): `subagent.thread_spawn.parent_thread_id`.
 */
export function codexSpawnParentFromSource(source: unknown): string | undefined {
  const spawn = record(record(sourceObject(source)?.subagent)?.thread_spawn);
  const parent = spawn?.parent_thread_id;
  return typeof parent === 'string' ? parent : undefined;
}

function subagentKindOf(subagent: unknown): string | undefined {
  if (typeof subagent === 'string') return nonEmpty(subagent);
  const variant = record(subagent);
  if (!variant) return undefined;
  const other = nonEmpty(variant.other);
  if (other) return other;
  return Object.keys(variant)[0];
}

/** The `session_meta` payload of a record, of a bare payload, or of the first in a list. */
function metaPayload(input: unknown): Record<string, unknown> | undefined {
  if (Array.isArray(input)) {
    for (const item of input) {
      const row = record(item);
      if (row?.type === 'session_meta') return record(row.payload);
    }
    return undefined;
  }
  const row = record(input);
  if (!row) return undefined;
  if (row.type === 'session_meta') return record(row.payload);
  // A payload on its own, as `readSessionMeta()` returns it.
  if (row.type === undefined && row.payload === undefined) return row;
  return undefined;
}

/**
 * Origin of a Codex rollout from its `session_meta`. Accepts the parsed
 * `session_meta` record, its payload, or the rollout's records in order (the
 * first `session_meta` wins: a fork embeds its parent's after its own).
 * Anything else yields `{ isSubagent: false }`.
 */
export function codexRolloutOrigin(input: unknown | readonly unknown[]): CodexRolloutOrigin {
  const payload = metaPayload(input);
  if (!payload) return { isSubagent: false };

  const forkedFromId = nonEmpty(payload.forked_from_id);
  const object = sourceObject(payload.source);
  const isSubagent = object !== undefined && 'subagent' in object;
  const source =
    typeof payload.source === 'string' && object === undefined
      ? nonEmpty(payload.source)
      : isSubagent
        ? 'subagent'
        : undefined;
  const parentId =
    forkedFromId ??
    nonEmpty(codexSpawnParentFromSource(object)) ??
    (isSubagent ? nonEmpty(payload.parent_thread_id) : undefined);
  const subagentKind = isSubagent ? subagentKindOf(object?.subagent) : undefined;

  return {
    ...(forkedFromId ? { forkedFromId } : {}),
    ...(source ? { source } : {}),
    isSubagent,
    ...(parentId ? { parentId } : {}),
    ...(subagentKind ? { subagentKind } : {}),
  };
}
