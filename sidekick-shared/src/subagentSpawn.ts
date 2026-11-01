/**
 * Recognizes Claude Code subagent spawns and background-task notifications.
 *
 * Claude Code's subagent tool is `Agent`; `Task` is its earlier name (and the
 * name OpenCode's `task` tool is normalized to). A background agent's spawning
 * tool call gets its result right away ("Async agent launched successfully.")
 * and its completion arrives later as a `<task-notification>` block, delivered
 * either as a user line or as a mid-turn `queued_command` attachment.
 *
 * Pure: no filesystem access, so it is safe for browser bundles.
 *
 * @module subagentSpawn
 */

import type { SubagentOutcome } from './aggregation/types';
import type { SessionEvent } from './types/sessionEvent';

/** Tool names that spawn a subagent: `Agent` (current) and `Task` (earlier name). */
export const SUBAGENT_SPAWN_TOOL_NAMES: readonly string[] = Object.freeze(['Agent', 'Task']);

const SPAWN_TOOLS: ReadonlySet<string> = new Set(SUBAGENT_SPAWN_TOOL_NAMES);

/** Whether a tool name spawns a subagent (`Agent` or `Task`). */
export function isSubagentSpawnTool(name: string | null | undefined): boolean {
  return typeof name === 'string' && SPAWN_TOOLS.has(name);
}

// ── Async launch ──

/** A spawning tool result that launched the agent in the background. */
export interface AsyncAgentLaunch {
  /** The agent id Claude Code reported (`agentId: <id>`), when present. */
  agentId?: string;
}

const ASYNC_LAUNCH_PREFIX = /^\s*Async agent launched successfully\b/;
const AGENT_ID_LINE = /(?:^|\n)[ \t]*agentId:[ \t]*([A-Za-z0-9][\w.@-]*)/;

/**
 * Plain text of tool-result or message content: a string as-is, or the text
 * blocks of a content array joined by newlines.
 */
export function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const typed = block as { type?: unknown; text?: unknown };
    if (typed.type === 'text' && typeof typed.text === 'string') parts.push(typed.text);
  }
  return parts.join('\n');
}

/**
 * Recognizes the immediate result of a background spawn
 * (`Async agent launched successfully.` … `agentId: <id> …`). Accepts the
 * result text or the raw tool-result content. Returns `null` for anything
 * else, including a finished foreground agent's result.
 */
export function parseAsyncAgentLaunch(result: unknown): AsyncAgentLaunch | null {
  const text = contentText(result);
  if (!ASYNC_LAUNCH_PREFIX.test(text)) return null;
  const match = AGENT_ID_LINE.exec(text);
  return match ? { agentId: match[1] } : {};
}

// ── Task notifications ──

/** Fields of a `<task-notification>` block. */
export interface TaskNotification {
  /** `<task-id>`: the background agent's id (or a background shell task's id). */
  taskId: string;
  /** `<tool-use-id>`: the tool call that started the background work. */
  toolUseId?: string;
  /** `<status>` as written, e.g. `completed`, `failed`, `killed`, `stopped`. */
  status?: string;
  /** `<summary>`, e.g. `Agent "Explore auth" finished`. */
  summary?: string;
  /**
   * The agent stopped while background work of its own is still running; it
   * may resume, and the same task id notifies again.
   */
  interim: boolean;
}

const NOTIFICATION_OPEN = '<task-notification>';
const NOTIFICATION_CLOSE = '</task-notification>';
const NOTIFICATION_PREFIX = /^\s*<task-notification>/;
const TAG_PATTERNS = {
  taskId: /<task-id>\s*([\s\S]*?)\s*<\/task-id>/,
  toolUseId: /<tool-use-id>\s*([\s\S]*?)\s*<\/tool-use-id>/,
  status: /<status>\s*([\s\S]*?)\s*<\/status>/,
  summary: /<summary>\s*([\s\S]*?)\s*<\/summary>/,
  note: /<note>\s*([\s\S]*?)\s*<\/note>/,
} as const;
const INTERIM_TEXT = /waiting on its own background work|background work of its own still running/i;

function tagValue(body: string, pattern: RegExp): string | undefined {
  const value = pattern.exec(body)?.[1]?.trim();
  return value ? value : undefined;
}

/**
 * Parses the first `<task-notification>` block in `text`. Whitespace and
 * newlines between tags, missing fields, and unknown extra fields are
 * tolerated; the block needs a `<task-id>`. Fields are read before the
 * agent's own `<result>` output, which may quote anything.
 */
export function parseTaskNotification(text: unknown): TaskNotification | null {
  if (typeof text !== 'string') return null;
  const start = text.indexOf(NOTIFICATION_OPEN);
  if (start < 0) return null;
  let body = text.slice(start + NOTIFICATION_OPEN.length);
  const resultAt = body.indexOf('<result>');
  let header = resultAt >= 0 ? body.slice(0, resultAt) : body;
  if (resultAt < 0) {
    const end = body.indexOf(NOTIFICATION_CLOSE);
    if (end >= 0) header = body = body.slice(0, end);
  }
  if (!TAG_PATTERNS.taskId.test(header)) header = body;

  const taskId = tagValue(header, TAG_PATTERNS.taskId);
  if (!taskId) return null;
  const toolUseId = tagValue(header, TAG_PATTERNS.toolUseId);
  const status = tagValue(header, TAG_PATTERNS.status);
  const summary = tagValue(header, TAG_PATTERNS.summary);
  const note = tagValue(header, TAG_PATTERNS.note);
  return {
    taskId,
    ...(toolUseId ? { toolUseId } : {}),
    ...(status ? { status } : {}),
    ...(summary ? { summary } : {}),
    interim: INTERIM_TEXT.test(summary ?? '') || INTERIM_TEXT.test(note ?? ''),
  };
}

/**
 * The `<task-notification>` prompt of a raw Claude Code attachment line
 * (`{ type: 'attachment', attachment: { type: 'queued_command', commandMode:
 * 'task-notification', prompt } }`), which is how a notification that lands
 * mid-turn is recorded. `null` for any other value.
 */
export function taskNotificationPromptFromAttachment(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object') return null;
  const line = raw as { type?: unknown; attachment?: unknown };
  if (line.type !== 'attachment' || !line.attachment || typeof line.attachment !== 'object') {
    return null;
  }
  const attachment = line.attachment as { type?: unknown; commandMode?: unknown; prompt?: unknown };
  return attachment.type === 'queued_command' &&
    attachment.commandMode === 'task-notification' &&
    typeof attachment.prompt === 'string'
    ? attachment.prompt
    : null;
}

/**
 * The synthetic `system` event `extractSessionEvents(raw, {
 * includeTaskNotifications: true })` makes from a mid-turn task-notification
 * attachment. It is bookkeeping, not a message or a prompt.
 */
export function isTaskNotificationSystemEvent(event: SessionEvent): boolean {
  return event.type === 'system' && event.origin?.kind === 'task-notification';
}

/**
 * The task notification an event carries: a user line with
 * `origin.kind === 'task-notification'` or whose text starts with
 * `<task-notification>`, or the opt-in synthetic system event. `null` otherwise.
 */
export function taskNotificationFromEvent(event: SessionEvent): TaskNotification | null {
  if (event.type !== 'user' && event.type !== 'system') return null;
  const flagged = event.origin?.kind === 'task-notification';
  if (event.type === 'system' && !flagged) return null;
  const text = contentText(event.message?.content);
  if (!flagged && !NOTIFICATION_PREFIX.test(text)) return null;
  return parseTaskNotification(text);
}

/** Maps a notification `<status>` to an outcome; unknown or missing statuses read as `completed`. */
export function taskNotificationOutcome(status: string | undefined): SubagentOutcome {
  switch (status?.toLowerCase()) {
    case 'failed':
      return 'failed';
    case 'killed':
      return 'killed';
    case 'stopped':
      return 'stopped';
    default:
      return 'completed';
  }
}
