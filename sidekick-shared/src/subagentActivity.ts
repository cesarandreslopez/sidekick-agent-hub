/**
 * Subagent lifecycle records as `system` session events.
 *
 * Codex records its multi-agent lifecycle in the parent's rollout:
 * `item_completed` → `SubAgentActivity` items link a `spawn_agent` call to the
 * child thread it started (`started`), mark each finished child turn
 * (`completed`, Codex 0.150+), and note `followup_task` / `send_message`
 * calls (`interacted`) and `interrupt_agent` calls (`interrupted`); a child's
 * report arrives as an `agent_message` whose text starts
 * `Message Type: FINAL_ANSWER`. With
 * `CodexRolloutParserOptions.includeSubagentActivity`, the parser turns each
 * into one `system` event with `origin: { kind: 'subagent-activity' }` whose
 * `message.content` is a single `{ type: 'subagent_activity', ... }` block.
 *
 * Those events are bookkeeping, not messages: transcripts, context
 * attribution, and message counts skip them, as they do task notifications.
 *
 * Pure: no filesystem access. Browser-safe.
 *
 * @module subagentActivity
 */

import type { SessionEvent } from './types/sessionEvent';

/** `origin.kind` of a subagent-activity `system` event. */
export const SUBAGENT_ACTIVITY_ORIGIN_KIND = 'subagent-activity';

/** `type` of the content block that carries the activity. */
export const SUBAGENT_ACTIVITY_BLOCK_TYPE = 'subagent_activity';

/**
 * - `started`: a spawn call started the child thread (`callId` = the spawn
 *   call's id, `agentThreadId` = the child's rollout id).
 * - `completed`: one child turn finished (`turnId` = that child turn).
 * - `interacted`: the parent sent the child work or a message (`callId` =
 *   the `followup_task` or `send_message` call; `tool` says which, when the
 *   call was seen). After `followup_task` the child runs again.
 * - `interrupted`: the parent interrupted the child (`interrupt_agent`).
 * - `final-answer`: the child's final report reached the parent
 *   (`agentPath` = its author, `text` = the report).
 */
export type SubagentActivityKind =
  | 'started'
  | 'completed'
  | 'interacted'
  | 'interrupted'
  | 'final-answer';

export interface SubagentActivity {
  kind: SubagentActivityKind;
  /**
   * The parent's tool call the record refers to: the spawn call for
   * `started`, the `followup_task` / `send_message` call for `interacted`,
   * the `interrupt_agent` call for `interrupted`.
   */
  callId?: string;
  /**
   * Raw name of the `callId` tool call (`spawn_agent`, `followup_task`,
   * `send_message`, `interrupt_agent`) when the parser saw that call.
   */
  tool?: string;
  /** `completed`: the child turn that finished. */
  turnId?: string;
  /** The child's thread id, which is its rollout's session id. */
  agentThreadId?: string;
  /** The child's agent path, e.g. `/root/review_builder` (`final-answer`: the author). */
  agentPath?: string;
  /** `final-answer`: the agent path the report went to, e.g. `/root`. */
  recipient?: string;
  /** `started`: the child's model and reasoning effort, when recorded. */
  model?: string;
  reasoningEffort?: string;
  /** The thread and turn that recorded the activity (the parent's). */
  parentThreadId?: string;
  parentTurnId?: string;
  /** `final-answer`: the report text (empty in metadata-only parsing). */
  text?: string;
}

const KINDS: ReadonlySet<string> = new Set<SubagentActivityKind>([
  'started',
  'completed',
  'interacted',
  'interrupted',
  'final-answer',
]);

const STRING_FIELDS = [
  'callId',
  'tool',
  'turnId',
  'agentThreadId',
  'agentPath',
  'recipient',
  'model',
  'reasoningEffort',
  'parentThreadId',
  'parentTurnId',
  'text',
] as const;

/** Whether an event is a subagent-activity `system` event (see the module docs). */
export function isSubagentActivitySystemEvent(event: SessionEvent): boolean {
  return event.type === 'system' && event.origin?.kind === SUBAGENT_ACTIVITY_ORIGIN_KIND;
}

/**
 * The activity a subagent-activity `system` event carries, copied with only
 * its known string fields; `null` for any other event or a malformed block.
 */
export function subagentActivityFromEvent(event: SessionEvent): SubagentActivity | null {
  if (!isSubagentActivitySystemEvent(event)) return null;
  const content = event.message?.content;
  if (!Array.isArray(content)) return null;
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const raw = block as Record<string, unknown>;
    if (raw.type !== SUBAGENT_ACTIVITY_BLOCK_TYPE) continue;
    if (typeof raw.kind !== 'string' || !KINDS.has(raw.kind)) return null;
    const activity: SubagentActivity = { kind: raw.kind as SubagentActivityKind };
    for (const field of STRING_FIELDS) {
      const value = raw[field];
      if (typeof value === 'string' && value.length > 0) activity[field] = value;
    }
    return activity;
  }
  return null;
}

/** A one-line, content-free description, e.g. `Subagent /root/review started`. */
export function describeSubagentActivity(activity: SubagentActivity): string {
  const who = activity.agentPath ?? activity.agentThreadId ?? 'subagent';
  const name = `Subagent ${who}`;
  switch (activity.kind) {
    case 'started':
      return `${name} started`;
    case 'completed':
      return `${name} finished a turn`;
    case 'interacted':
      return activity.tool === 'send_message'
        ? `Message sent to subagent ${who}`
        : `${name} given a follow-up task`;
    case 'interrupted':
      return `${name} interrupted`;
    case 'final-answer':
      return `${name} reported its final answer`;
  }
}

/** Fields of a Codex inter-agent message text (`Message Type: … Payload:\n…`). */
export interface CodexAgentMessageText {
  /** `MESSAGE`, `NEW_TASK`, `FINAL_ANSWER`, … */
  messageType: string;
  taskName?: string;
  sender?: string;
  /** Everything after the `Payload:` line. */
  payload: string;
}

const MESSAGE_HEADER = /^Message Type:[ \t]*([A-Z_]+)[ \t]*(?:\r?\n|$)/;

/**
 * Parses a Codex inter-agent message text. Returns `null` unless it starts
 * with a `Message Type:` line.
 */
export function parseCodexAgentMessageText(text: unknown): CodexAgentMessageText | null {
  if (typeof text !== 'string') return null;
  const header = MESSAGE_HEADER.exec(text);
  if (!header) return null;
  const rest = text.slice(header[0].length);
  const payloadAt = /(?:^|\n)Payload:[ \t]*(?:\r?\n|$)/.exec(rest);
  const head = payloadAt ? rest.slice(0, payloadAt.index) : rest;
  const payload = payloadAt ? rest.slice(payloadAt.index + payloadAt[0].length) : '';
  const field = (name: string): string | undefined => {
    const match = new RegExp(`(?:^|\\n)${name}:[ \\t]*([^\\n]*)`).exec(head);
    const value = match?.[1]?.trim();
    return value ? value : undefined;
  };
  const taskName = field('Task name');
  const sender = field('Sender');
  return {
    messageType: header[1],
    ...(taskName ? { taskName } : {}),
    ...(sender ? { sender } : {}),
    payload,
  };
}
