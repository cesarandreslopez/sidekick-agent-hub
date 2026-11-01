/**
 * Recognizes subagent spawns, background-task notifications, and the other
 * records that settle a background agent.
 *
 * Claude Code's subagent tool is `Agent`; `Task` is its earlier name (and the
 * name OpenCode's `task` tool is normalized to). A background agent's spawning
 * tool call gets its result right away ("Async agent launched successfully.")
 * and its completion arrives later as a `<task-notification>` block, delivered
 * either as a user line or as a mid-turn `queued_command` attachment. When no
 * notification comes, a `task_status` attachment, an `agents_killed` system
 * line, or a plain-text "background agents were stopped by the user" notice
 * can still say how it ended.
 *
 * Codex spawns with `spawn_agent` (parsed as `Spawn_agent`); its result
 * (`{"task_name": "/root/x"}`) is always a background launch.
 *
 * Pure: no filesystem access, so it is safe for browser bundles.
 *
 * @module subagentSpawn
 */

import type { SubagentOutcome } from './aggregation/types';
import type { SessionEvent } from './types/sessionEvent';

/**
 * Claude Code / OpenCode tool names that spawn a subagent: `Agent` (current)
 * and `Task` (earlier name). Codex's `spawn_agent` is not in this list;
 * {@link isSubagentSpawnTool} recognizes it as well.
 */
export const SUBAGENT_SPAWN_TOOL_NAMES: readonly string[] = Object.freeze(['Agent', 'Task']);

const SPAWN_TOOLS: ReadonlySet<string> = new Set(SUBAGENT_SPAWN_TOOL_NAMES);

/** Codex's raw spawn tool name, and the name the Codex parser normalizes it to. */
const CODEX_SPAWN_RAW = 'spawn_agent';
const CODEX_SPAWN_TOOLS: ReadonlySet<string> = new Set([CODEX_SPAWN_RAW, 'Spawn_agent']);

/**
 * Whether a tool call is Codex's `spawn_agent`: by name (`Spawn_agent` as
 * parsed, or the raw `spawn_agent`), or by the raw name the Codex parser keeps
 * in the input (`_sidekickRawToolName`).
 */
export function isCodexSubagentSpawnTool(
  name: string | null | undefined,
  input?: unknown,
): boolean {
  if (typeof name === 'string' && CODEX_SPAWN_TOOLS.has(name)) return true;
  return (
    !!input &&
    typeof input === 'object' &&
    (input as { _sidekickRawToolName?: unknown })._sidekickRawToolName === CODEX_SPAWN_RAW
  );
}

/**
 * Whether a tool call spawns a subagent: one of
 * {@link SUBAGENT_SPAWN_TOOL_NAMES} (`Agent`, `Task`), or Codex's
 * `spawn_agent` (see {@link isCodexSubagentSpawnTool}; pass the call's input
 * to also match on its raw name).
 */
export function isSubagentSpawnTool(name: string | null | undefined, input?: unknown): boolean {
  if (typeof name === 'string' && SPAWN_TOOLS.has(name)) return true;
  return isCodexSubagentSpawnTool(name, input);
}

// ── Codex launch ──

/** A Codex `spawn_agent` result: the child was started in the background. */
export interface CodexSpawnLaunch {
  /** The child's agent path (`task_name` in the result), e.g. `/root/review_builder`. */
  agentPath?: string;
}

/**
 * Recognizes a Codex `spawn_agent` result (`{"task_name": "/root/x"}`, as a
 * JSON string or object). `null` for anything else.
 */
export function parseCodexSpawnLaunch(result: unknown): CodexSpawnLaunch | null {
  let value: unknown = result;
  if (typeof value !== 'string') {
    const text = contentText(value);
    value = text || value;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed.startsWith('{')) return null;
    try {
      value = JSON.parse(trimmed);
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const taskName = (value as { task_name?: unknown }).task_name;
  if (typeof taskName !== 'string') return null;
  return taskName ? { agentPath: taskName } : {};
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

// ── Stop notices ──

/** A plain-text notice that the user stopped background agents. */
export interface AgentsStoppedNotice {
  /** The stopped agents' descriptions, as the notice quotes them. */
  descriptions: string[];
}

const STOPPED_PLURAL =
  /^\s*(\d+)\s+background agents? (?:were|was) stopped by the user:\s*([\s\S]*?)\s*$/i;
const STOPPED_SINGULAR = /^\s*Background agent "([\s\S]*)" was stopped by the user\.?\s*$/i;

/**
 * Parses Claude Code's plain-text notice that the user stopped background
 * agents: `2 background agents were stopped by the user: "A", "B".` (a
 * `queued_command` attachment's prompt) or `Background agent "A" was stopped
 * by the user.` (a queue-operation line). `null` for any other text.
 */
export function parseAgentsStoppedNotice(text: unknown): AgentsStoppedNotice | null {
  if (typeof text !== 'string') return null;
  const singular = STOPPED_SINGULAR.exec(text);
  if (singular) return { descriptions: [singular[1].trim()].filter(Boolean) };
  const plural = STOPPED_PLURAL.exec(text);
  if (!plural) return null;
  let list = plural[2].trim();
  if (list.endsWith('.')) list = list.slice(0, -1).trimEnd();
  if (!list.startsWith('"') || !list.endsWith('"') || list.length < 2) return null;
  const descriptions = list
    .slice(1, -1)
    .split(/",\s*"/)
    .map((description) => description.trim())
    .filter(Boolean);
  return descriptions.length > 0 ? { descriptions } : null;
}

/**
 * The stop notice a task-notification event carries (a `queued_command`
 * prompt that is plain text, not a `<task-notification>` block). `null`
 * otherwise.
 */
export function agentsStoppedNoticeFromEvent(event: SessionEvent): AgentsStoppedNotice | null {
  if (!isTaskNotificationSystemEvent(event)) return null;
  return parseAgentsStoppedNotice(contentText(event.message?.content));
}

/** Claude Code's `agents_killed` system line: the user killed every running background agent. */
export const AGENTS_KILLED_SUBTYPE = 'agents_killed';

/**
 * Whether an event, or a raw Claude Code JSONL line, is an `agents_killed`
 * system line (`{ type: 'system', subtype: 'agents_killed' }`).
 */
export function isAgentsKilledSystemEvent(event: unknown): boolean {
  if (!event || typeof event !== 'object') return false;
  const line = event as { type?: unknown; subtype?: unknown };
  return line.type === 'system' && line.subtype === AGENTS_KILLED_SUBTYPE;
}

// ── task_status attachments ──

/** A background agent's status from a Claude Code `task_status` attachment. */
export interface SubagentTaskStatus {
  /** The background agent's id. */
  taskId: string;
  /** `local_agent` for background agents. */
  taskType: string;
  /** As written: `running`, `completed`, `failed`, `killed`, `stopped`, … */
  status: string;
  description?: string;
}

/** `origin.kind` of the opt-in `system` event made from a `task_status` attachment. */
export const TASK_STATUS_ORIGIN_KIND = 'task-status';
/** `type` of the content block that carries the status. */
export const TASK_STATUS_BLOCK_TYPE = 'task_status';

const AGENT_TASK_TYPE = 'local_agent';

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/**
 * The background agent's status a raw Claude Code `task_status` attachment
 * line reports (`{ type: 'attachment', attachment: { type: 'task_status',
 * taskId, taskType: 'local_agent', status, description } }`). `null` for any
 * other value, including background shell tasks (`local_bash`).
 */
export function taskStatusFromAttachment(raw: unknown): SubagentTaskStatus | null {
  if (!raw || typeof raw !== 'object') return null;
  const line = raw as { type?: unknown; attachment?: unknown };
  if (line.type !== 'attachment' || !line.attachment || typeof line.attachment !== 'object') {
    return null;
  }
  const attachment = line.attachment as Record<string, unknown>;
  if (attachment.type !== 'task_status' || attachment.taskType !== AGENT_TASK_TYPE) return null;
  const taskId = nonEmpty(attachment.taskId);
  const status = nonEmpty(attachment.status);
  if (!taskId || !status) return null;
  const description = nonEmpty(attachment.description);
  return { taskId, taskType: AGENT_TASK_TYPE, status, ...(description ? { description } : {}) };
}

/** Whether a task status is final (anything but `running` / `pending`). */
export function isFinalTaskStatus(status: string | undefined): boolean {
  if (!status) return false;
  const lower = status.toLowerCase();
  return lower !== 'running' && lower !== 'pending';
}

/**
 * The synthetic `system` event `extractSessionEvents(raw, {
 * includeTaskNotifications: true })` makes from a background agent's
 * `task_status` attachment. It is bookkeeping, not a message or a prompt.
 */
export function isTaskStatusSystemEvent(event: SessionEvent): boolean {
  return event.type === 'system' && event.origin?.kind === TASK_STATUS_ORIGIN_KIND;
}

/** The status an opt-in task-status `system` event carries; `null` for any other event. */
export function taskStatusFromEvent(event: SessionEvent): SubagentTaskStatus | null {
  if (!isTaskStatusSystemEvent(event)) return null;
  const content = event.message?.content;
  if (!Array.isArray(content)) return null;
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const raw = block as Record<string, unknown>;
    if (raw.type !== TASK_STATUS_BLOCK_TYPE) continue;
    const taskId = nonEmpty(raw.taskId);
    const status = nonEmpty(raw.status);
    if (!taskId || !status) return null;
    const description = nonEmpty(raw.description);
    return {
      taskId,
      taskType: nonEmpty(raw.taskType) ?? AGENT_TASK_TYPE,
      status,
      ...(description ? { description } : {}),
    };
  }
  return null;
}

/**
 * A one-line description of a stop: `Background agents stopped by the user (2)`,
 * or, for an `agents_killed` line (`null`), `Background agents stopped by the user`.
 */
export function describeAgentsStopped(notice: AgentsStoppedNotice | null): string {
  const count = notice?.descriptions.length;
  return count
    ? `Background agents stopped by the user (${count})`
    : 'Background agents stopped by the user';
}

/** A one-line description of a task status, e.g. `Background agent "Explore auth" completed`. */
export function describeTaskStatus(status: SubagentTaskStatus): string {
  const name = status.description ? `Background agent "${status.description}"` : 'Background agent';
  return `${name} ${status.status}`;
}
