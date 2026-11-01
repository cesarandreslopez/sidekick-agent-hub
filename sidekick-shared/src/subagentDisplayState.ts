/**
 * How to show a subagent: its lifecycle's outcome once something settled
 * it, otherwise `running`, unless its transcript or its parent says it has
 * stopped in all but name.
 *
 * Some background agents never get a final notification (they stopped after
 * an interim "may resume" notice, the user stopped them from the UI, or a
 * restart killed them). Their lifecycles stay `running`. This rule reads
 * them as:
 *
 * - `finished-unreported`: the transcript ended cleanly (last assistant turn
 *   `end_turn` / `stop_sequence`, no tool call unanswered) and has been quiet
 *   for {@link SUBAGENT_UNREPORTED_QUIET_MS}.
 * - `ended`: neither the parent session nor the transcript has been active for
 *   {@link SUBAGENT_PARENT_IDLE_ENDED_MS}.
 *
 * Neither is stored: the state is recomputed from the latest data on every
 * call, so an agent that resumes (its transcript grows, or a later
 * notification reopens its lifecycle) reads as `running` again. Silence alone
 * is never enough for `finished-unreported`: live agents can be quiet for
 * hours.
 *
 * Pure: no filesystem access. Browser-safe.
 *
 * @module subagentDisplayState
 */

import type { SubagentLifecycle } from './aggregation/types';

/** Quiet time after a clean end before a running agent reads as finished without a report (2 min). */
export const SUBAGENT_UNREPORTED_QUIET_MS = 2 * 60_000;

/** Parent and transcript idle time after which a running agent reads as ended (6 h). */
export const SUBAGENT_PARENT_IDLE_ENDED_MS = 6 * 60 * 60_000;

/** How a subagent is shown. The last four are lifecycle outcomes. */
export type SubagentDisplayStateName =
  | 'running'
  | 'finished-unreported'
  | 'ended'
  | 'completed'
  | 'failed'
  | 'stopped'
  | 'killed';

/** Why a subagent reads as it does. */
export type SubagentDisplayReason =
  /** Its lifecycle is settled; the state is the outcome. */
  | 'settled'
  /** Claude Code's meta flags (`finished`, `stoppedByUser`) on a running lifecycle. */
  | 'meta'
  /** The transcript ended cleanly and has been quiet. */
  | 'clean-end'
  /** The parent session (and the transcript) has been idle. */
  | 'parent-idle';

export interface SubagentDisplayState {
  state: SubagentDisplayStateName;
  /** Absent for a plain `running`. */
  reason?: SubagentDisplayReason;
}

/** The lifecycle fields the rule reads. */
export type SubagentDisplayLifecycle = Pick<SubagentLifecycle, 'status' | 'outcome'>;

/**
 * Transcript facts the rule reads; a `SubagentTrace`, or a `SubagentStats`
 * mapped with `lastActivityAt: stats.endTime`.
 */
export interface SubagentDisplayTrace {
  /** The transcript ended cleanly (see `SubagentTrace.endedCleanly`). */
  endedCleanly?: boolean;
  /** Time of the transcript's last record. */
  lastActivityAt?: Date | string | number;
  /** Claude Code meta `finished`. */
  finished?: boolean;
  /** Claude Code meta `stoppedByUser`. */
  stoppedByUser?: boolean;
}

export interface SubagentDisplayOptions {
  /** The current time (epoch ms or a Date). */
  now: number | Date;
  /** Time of the parent session's last event, when known. */
  parentLastActivity?: Date | string | number | null;
}

function toMs(value: Date | string | number | null | undefined): number | undefined {
  if (value === null || value === undefined) return undefined;
  const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(ms) ? ms : undefined;
}

/**
 * Resolves how to show a subagent (see the module docs). Settled lifecycles
 * map to their outcome (`completed` when none is recorded). A running one is
 * `stopped` / `completed` when its meta flags say so, `finished-unreported`
 * after a clean end and {@link SUBAGENT_UNREPORTED_QUIET_MS} of quiet,
 * `ended` when the parent and transcript have both been idle for longer than
 * {@link SUBAGENT_PARENT_IDLE_ENDED_MS}, and `running` otherwise.
 */
export function resolveSubagentDisplayState(
  lifecycle: SubagentDisplayLifecycle,
  trace: SubagentDisplayTrace | null | undefined,
  options: SubagentDisplayOptions,
): SubagentDisplayState {
  if (lifecycle.status !== 'running') {
    return { state: lifecycle.outcome ?? 'completed', reason: 'settled' };
  }
  if (trace?.stoppedByUser) return { state: 'stopped', reason: 'meta' };
  if (trace?.finished) return { state: 'completed', reason: 'meta' };

  const now = toMs(options.now) ?? Date.now();
  const lastActivity = toMs(trace?.lastActivityAt);
  if (
    trace?.endedCleanly &&
    lastActivity !== undefined &&
    now - lastActivity >= SUBAGENT_UNREPORTED_QUIET_MS
  ) {
    return { state: 'finished-unreported', reason: 'clean-end' };
  }

  const parentLast = toMs(options.parentLastActivity);
  if (parentLast !== undefined) {
    const latest = Math.max(parentLast, lastActivity ?? -Infinity);
    if (now - latest > SUBAGENT_PARENT_IDLE_ENDED_MS) {
      return { state: 'ended', reason: 'parent-idle' };
    }
  }
  return { state: 'running' };
}

const LABELS: Record<SubagentDisplayStateName, string> = {
  running: 'running',
  'finished-unreported': 'finished (no report)',
  ended: 'ended',
  completed: 'completed',
  failed: 'failed',
  stopped: 'stopped',
  killed: 'killed',
};

/** A short label: `running`, `finished (no report)`, `ended`, `completed`, `failed`, `stopped`, `killed`. */
export function subagentDisplayLabel(state: SubagentDisplayStateName): string {
  return LABELS[state] ?? state;
}
