/**
 * Codex turn boundaries as `system` session events.
 *
 * Codex records when each turn starts and ends: `task_started`,
 * `task_complete` (also when the turn ended with an error), and
 * `turn_aborted` (interrupted, replaced, …). With
 * `CodexRolloutParserOptions.includeTurnLifecycle`, the parser turns each
 * into one `system` event with that `subtype`, `origin: { kind:
 * 'turn-lifecycle' }`, and a single `{ type: 'turn_lifecycle', … }` content
 * block (read it with {@link turnLifecycleFromEvent}). Without them a Codex
 * turn never visibly ends.
 *
 * Those events are bookkeeping, not messages: transcripts, context
 * attribution, and the aggregator's counts skip them.
 *
 * Pure: no filesystem access. Browser-safe.
 *
 * @module turnLifecycle
 */

import type { SessionEvent } from './types/sessionEvent';

/** `origin.kind` of a turn-lifecycle `system` event. */
export const TURN_LIFECYCLE_ORIGIN_KIND = 'turn-lifecycle';

/** `type` of the content block that carries the lifecycle record. */
export const TURN_LIFECYCLE_BLOCK_TYPE = 'turn_lifecycle';

/** The `subtype` of a turn-lifecycle event: the Codex event it came from. */
export type TurnLifecycleKind = 'task_started' | 'task_complete' | 'turn_aborted';

export interface TurnLifecycle {
  kind: TurnLifecycleKind;
  /** The Codex turn id, when recorded. */
  turnId?: string;
  /** `turn_aborted`: why (`interrupted`, `replaced`, `review_ended`, `budget_limited`). */
  reason?: string;
  /** `task_complete`: the turn ended with an error. */
  failed?: true;
}

const KINDS: ReadonlySet<string> = new Set<TurnLifecycleKind>([
  'task_started',
  'task_complete',
  'turn_aborted',
]);

/** Whether an event is a turn-lifecycle `system` event (see the module docs). */
export function isTurnLifecycleSystemEvent(event: SessionEvent): boolean {
  return event.type === 'system' && event.origin?.kind === TURN_LIFECYCLE_ORIGIN_KIND;
}

/**
 * The lifecycle record a turn-lifecycle `system` event carries, copied with
 * only its known fields; `null` for any other event or a malformed block.
 */
export function turnLifecycleFromEvent(event: SessionEvent): TurnLifecycle | null {
  if (!isTurnLifecycleSystemEvent(event)) return null;
  const content = event.message?.content;
  if (!Array.isArray(content)) return null;
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const raw = block as Record<string, unknown>;
    if (raw.type !== TURN_LIFECYCLE_BLOCK_TYPE) continue;
    if (typeof raw.kind !== 'string' || !KINDS.has(raw.kind)) return null;
    const lifecycle: TurnLifecycle = { kind: raw.kind as TurnLifecycleKind };
    if (typeof raw.turnId === 'string' && raw.turnId) lifecycle.turnId = raw.turnId;
    if (typeof raw.reason === 'string' && raw.reason) lifecycle.reason = raw.reason;
    if (raw.failed === true) lifecycle.failed = true;
    return lifecycle;
  }
  return null;
}

/** A one-line, content-free description, e.g. `Turn aborted (interrupted)`. */
export function describeTurnLifecycle(lifecycle: TurnLifecycle): string {
  switch (lifecycle.kind) {
    case 'task_started':
      return 'Turn started';
    case 'task_complete':
      return lifecycle.failed ? 'Turn ended with an error' : 'Turn complete';
    case 'turn_aborted':
      return lifecycle.reason ? `Turn aborted (${lifecycle.reason})` : 'Turn aborted';
  }
}
