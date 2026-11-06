/**
 * Where a Codex rollout's own records start, and whether that is proven.
 *
 * A forked subagent's rollout (multi-agent v2, Codex 0.16x) begins with its
 * own `session_meta`, then embeds an ancestor's `session_meta` and history,
 * and records `subagent_history_start_ordinal` (S): records with an ordinal
 * below S are the parent's history, not the child's. Codex 0.146 wrote S
 * without the embedded history, and copied forks (user forks, forked
 * spawns without paginated history) carry the parent's records with no
 * marker at all, so S alone proves nothing.
 *
 * The rule, from the rollout's first records:
 *
 * - `proven`: a valid S ≥ 2 and the record at ordinal 1 is an ancestor's
 *   `session_meta` (its id is the fork parent, spawn parent, or root
 *   session). Records at ordinals 1 … S-1 are inherited.
 * - `unproven`: inherited history is likely but its end cannot be shown: S
 *   without that embedded meta (the 0.146 shape), an invalid S, a
 *   `forked_from_id` or an object `source` without S, a `history_base`
 *   (reported, not yet trusted), or no `session_meta` first.
 * - `none`: nothing is inherited: S = 1, or a plain session.
 * - `pending`: the records seen so far cannot decide yet (S ≥ 2 and the
 *   record at ordinal 1 has not been read).
 *
 * Consumers that must not attribute a parent's history to a child gate on
 * `status` being `proven` or `none`. `CodexRolloutParser` skips the records
 * {@link isCodexInheritedRecord} marks, and the Node helper
 * `readCodexInheritedHistoryBoundary()` reads the boundary from a file.
 *
 * Pure: no filesystem access. Browser-safe.
 *
 * @module parsers/codexInheritedHistory
 */

import { codexRolloutOrigin } from './codexRolloutOrigin';

export type CodexInheritedHistoryStatus = 'none' | 'proven' | 'unproven' | 'pending';

/** What proved the boundary: an ancestor's `session_meta` at ordinal 1. */
export type CodexInheritedHistoryProof = 'embedded-ancestor-meta';

/**
 * Why the boundary is not proven:
 * - `not-inherited` (`none`): no start ordinal, fork, object source, or history base.
 * - `starts-at-own-records` (`none`): S = 1.
 * - `empty` (`none`): a complete rollout with no records.
 * - `awaiting-records` (`pending`): the record at ordinal 1 was not read yet.
 * - `scan-limit` (`pending`): a reader stopped before it could decide.
 * - `no-session-meta`: the first record is not a `session_meta`.
 * - `invalid-start-ordinal`: S is present but not a positive integer.
 * - `no-embedded-meta`: S ≥ 2 but ordinal 1 is not a `session_meta` (Codex 0.146).
 * - `unrelated-embedded-meta`: the `session_meta` at ordinal 1 is not an ancestor's,
 *   or S = 1 with one there.
 * - `history-base`: a `history_base` without a proven S.
 * - `forked`: a `forked_from_id` without S.
 * - `object-source`: a subagent (object) `source` without S.
 */
export type CodexInheritedHistoryReason =
  | 'not-inherited'
  | 'starts-at-own-records'
  | 'empty'
  | 'awaiting-records'
  | 'scan-limit'
  | 'no-session-meta'
  | 'invalid-start-ordinal'
  | 'no-embedded-meta'
  | 'unrelated-embedded-meta'
  | 'history-base'
  | 'forked'
  | 'object-source';

/** `session_meta.history_base`: the prefix of another rollout a thread references. */
export interface CodexHistoryBase {
  threadId?: string;
  /** First ordinal of the prefix file that is not inherited. */
  endOrdinalExclusive?: number;
  /** Byte offset just after the last inherited record of the prefix file. */
  endByteOffset?: number;
}

export interface CodexInheritedHistoryBoundary {
  status: CodexInheritedHistoryStatus;
  /** `proven` only. */
  proof?: CodexInheritedHistoryProof;
  /** Every status but `proven`. */
  reason?: CodexInheritedHistoryReason;
  /** `proven`: ordinal of the first own record (S); ordinals 1 … S-1 are inherited. */
  ownFromOrdinal?: number;
  /** `proven`: ordinal of the embedded ancestor `session_meta` (always 1). */
  embeddedMetaOrdinal?: number;
  /**
   * `proven`, once the record at `ownFromOrdinal` was seen: its event or
   * item type (Codex writes `thread_settings_applied` there).
   */
  startMarker?: string;
  /** The rollout's `session_meta.history_base`, when it has one. */
  historyBase?: CodexHistoryBase;
  /** `session_meta.forked_from_id`. */
  forkedFromId?: string;
  /** The parent session (see `codexRolloutOrigin()`). */
  parentId?: string;
  /** The rollout was written by a subagent (object `source`). */
  isSubagent: boolean;
}

export interface CodexInheritedHistoryOptions {
  /**
   * `records` holds the whole rollout, so nothing more will be written: a
   * boundary that is still undecided becomes final (`none` for no records,
   * `unproven` for a missing ordinal 1).
   */
  complete: boolean;
}

const STATUSES: ReadonlySet<string> = new Set(['none', 'proven', 'unproven', 'pending']);
const REASONS: ReadonlySet<string> = new Set<CodexInheritedHistoryReason>([
  'not-inherited',
  'starts-at-own-records',
  'empty',
  'awaiting-records',
  'scan-limit',
  'no-session-meta',
  'invalid-start-ordinal',
  'no-embedded-meta',
  'unrelated-embedded-meta',
  'history-base',
  'forked',
  'object-source',
]);

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** A record's `ordinal` when it is a non-negative integer. */
function ordinalOf(row: unknown): number | undefined {
  const value = record(row)?.ordinal;
  return isCount(value) ? value : undefined;
}

function historyBaseOf(value: unknown): CodexHistoryBase | undefined {
  const raw = record(value);
  if (!raw) return undefined;
  const base: CodexHistoryBase = {};
  const threadId = nonEmpty(raw.thread_id);
  if (threadId) base.threadId = threadId;
  if (isCount(raw.end_ordinal_exclusive)) base.endOrdinalExclusive = raw.end_ordinal_exclusive;
  if (isCount(raw.end_byte_offset)) base.endByteOffset = raw.end_byte_offset;
  return base;
}

/** The type a record reports: its payload's for events and items, else its own. */
function markerOf(row: unknown): string | undefined {
  const parsed = record(row);
  if (!parsed) return undefined;
  const payload = record(parsed.payload);
  const payloadType = nonEmpty(payload?.type);
  if ((parsed.type === 'event_msg' || parsed.type === 'response_item') && payloadType) {
    return payloadType;
  }
  return nonEmpty(parsed.type);
}

/**
 * The inherited-history boundary of a Codex rollout from its records in
 * file order (parsed lines; at least the first two decide it). See the
 * module docs for the rule.
 */
export function codexInheritedHistoryBoundary(
  records: readonly unknown[],
  options: CodexInheritedHistoryOptions,
): CodexInheritedHistoryBoundary {
  const first = record(records[0]);
  if (!first) {
    return options.complete
      ? { status: 'none', reason: 'empty', isSubagent: false }
      : { status: 'pending', reason: 'awaiting-records', isSubagent: false };
  }
  const meta = first.type === 'session_meta' ? record(first.payload) : undefined;
  if (!meta) return { status: 'unproven', reason: 'no-session-meta', isSubagent: false };

  const origin = codexRolloutOrigin(meta);
  const historyBase = historyBaseOf(meta.history_base);
  const base: CodexInheritedHistoryBoundary = {
    status: 'pending',
    isSubagent: origin.isSubagent,
    ...(origin.forkedFromId ? { forkedFromId: origin.forkedFromId } : {}),
    ...(origin.parentId ? { parentId: origin.parentId } : {}),
    ...(historyBase ? { historyBase } : {}),
  };
  const decided = (
    status: CodexInheritedHistoryStatus,
    reason: CodexInheritedHistoryReason,
  ): CodexInheritedHistoryBoundary => ({ ...base, status, reason });

  const start = meta.subagent_history_start_ordinal;
  if (start === undefined || start === null) {
    if (historyBase) return decided('unproven', 'history-base');
    if (origin.forkedFromId) return decided('unproven', 'forked');
    if (isObjectSource(meta.source)) return decided('unproven', 'object-source');
    return decided('none', 'not-inherited');
  }
  if (!(typeof start === 'number' && Number.isSafeInteger(start) && start >= 1)) {
    return decided('unproven', 'invalid-start-ordinal');
  }

  const second = records[1];
  if (second === undefined) {
    if (!options.complete) return decided('pending', 'awaiting-records');
    return start === 1
      ? decided('none', 'starts-at-own-records')
      : decided('unproven', 'no-embedded-meta');
  }
  const secondRow = record(second);
  const embedded =
    secondRow?.type === 'session_meta' && ordinalOf(secondRow) === 1
      ? record(secondRow.payload)
      : undefined;
  if (start === 1) {
    return embedded
      ? decided('unproven', 'unrelated-embedded-meta')
      : decided('none', 'starts-at-own-records');
  }
  if (!embedded) return decided('unproven', 'no-embedded-meta');
  if (!isAncestorMeta(embedded, meta)) return decided('unproven', 'unrelated-embedded-meta');

  const proven: CodexInheritedHistoryBoundary = {
    ...base,
    status: 'proven',
    proof: 'embedded-ancestor-meta',
    ownFromOrdinal: start,
    embeddedMetaOrdinal: 1,
  };
  for (let index = 2; index < records.length; index++) {
    if (ordinalOf(records[index]) === start) {
      const marker = markerOf(records[index]);
      if (marker) proven.startMarker = marker;
      break;
    }
  }
  return proven;
}

/** An object (or JSON-object text) `source`: a subagent, reviewer, or copied fork. */
function isObjectSource(source: unknown): boolean {
  if (record(source)) return true;
  return typeof source === 'string' && source.trimStart().startsWith('{');
}

/** The embedded meta belongs to the thread this one was forked or spawned from, or its root. */
function isAncestorMeta(embedded: Record<string, unknown>, own: Record<string, unknown>): boolean {
  const id = nonEmpty(embedded.id);
  if (!id || id === nonEmpty(own.id)) return false;
  const origin = codexRolloutOrigin(own);
  const ancestors = [
    origin.forkedFromId,
    origin.parentId,
    nonEmpty(own.parent_thread_id),
    nonEmpty(own.session_id),
  ];
  return ancestors.includes(id);
}

/**
 * Whether a record (a parsed rollout line) is inherited parent history
 * under `boundary`: only for a `proven` boundary, a record whose ordinal is
 * 1 … `ownFromOrdinal` - 1. The rollout's own `session_meta` (ordinal 0) and
 * records without an ordinal are never inherited.
 */
export function isCodexInheritedRecord(
  boundary: CodexInheritedHistoryBoundary,
  row: unknown,
): boolean {
  if (boundary.status !== 'proven' || boundary.ownFromOrdinal === undefined) return false;
  const ordinal = ordinalOf(row);
  return ordinal !== undefined && ordinal >= 1 && ordinal < boundary.ownFromOrdinal;
}

/**
 * The boundary with `startMarker` set from `row` when it is the first own
 * record of a proven boundary that has no marker yet; otherwise `boundary`.
 * @internal
 */
export function withCodexStartMarker(
  boundary: CodexInheritedHistoryBoundary,
  row: unknown,
): CodexInheritedHistoryBoundary {
  if (
    boundary.status !== 'proven' ||
    boundary.startMarker !== undefined ||
    ordinalOf(row) !== boundary.ownFromOrdinal
  ) {
    return boundary;
  }
  const marker = markerOf(row);
  return marker ? { ...boundary, startMarker: marker } : boundary;
}

/**
 * A boundary from untrusted JSON (a persisted resume state), copied with
 * only its known fields, or `undefined` when it is not one.
 * @internal
 */
export function parseCodexInheritedHistoryBoundary(
  value: unknown,
): CodexInheritedHistoryBoundary | undefined {
  const raw = record(value);
  if (!raw || typeof raw.status !== 'string' || !STATUSES.has(raw.status)) return undefined;
  if (typeof raw.isSubagent !== 'boolean') return undefined;
  const status = raw.status as CodexInheritedHistoryStatus;
  const boundary: CodexInheritedHistoryBoundary = { status, isSubagent: raw.isSubagent };
  if (status === 'proven') {
    if (raw.proof !== 'embedded-ancestor-meta') return undefined;
    if (!(isCount(raw.ownFromOrdinal) && raw.ownFromOrdinal >= 2)) return undefined;
    boundary.proof = 'embedded-ancestor-meta';
    boundary.ownFromOrdinal = raw.ownFromOrdinal;
    boundary.embeddedMetaOrdinal = 1;
  } else if (typeof raw.reason === 'string' && REASONS.has(raw.reason)) {
    boundary.reason = raw.reason as CodexInheritedHistoryReason;
  } else {
    return undefined;
  }
  const marker = nonEmpty(raw.startMarker);
  if (marker && status === 'proven') boundary.startMarker = marker;
  const forkedFromId = nonEmpty(raw.forkedFromId);
  if (forkedFromId) boundary.forkedFromId = forkedFromId;
  const parentId = nonEmpty(raw.parentId);
  if (parentId) boundary.parentId = parentId;
  const historyBase = record(raw.historyBase);
  if (historyBase) {
    const copy: CodexHistoryBase = {};
    const threadId = nonEmpty(historyBase.threadId);
    if (threadId) copy.threadId = threadId;
    if (isCount(historyBase.endOrdinalExclusive)) {
      copy.endOrdinalExclusive = historyBase.endOrdinalExclusive;
    }
    if (isCount(historyBase.endByteOffset)) copy.endByteOffset = historyBase.endByteOffset;
    boundary.historyBase = copy;
  }
  return boundary;
}
