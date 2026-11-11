/**
 * Settings hooks as `system` session events.
 *
 * Claude Code records every hook it runs as an attachment line
 * (`hook_success`, `hook_non_blocking_error`, `hook_blocking_error`,
 * `hook_additional_context`, `hook_system_message`, …) with the hook event
 * (`PreToolUse`, `PostToolUse`, `SessionStart`, `UserPromptSubmit`, `Stop`,
 * …), the matcher, the tool call it ran for, its exit code and duration —
 * and its full command line, output and any context it added.
 *
 * With `ExtractSessionEventsOptions.includeActivitySignals`, each such line
 * becomes one `system` event with `origin: { kind: 'hook' }` and a single
 * `{ type: 'hook_activity', … }` content block (read it with
 * {@link hookActivityFromEvent}). The block is content-free: the command line,
 * stdout, stderr and added text are never kept; only sizes, the outcome, and
 * the hook program's own name (a script's file name, `session-start` for
 * `bash "$ROOT/hooks/session-start.sh"`).
 *
 * Like turn-lifecycle events these are bookkeeping, not messages:
 * transcripts, context attribution and the aggregator's counts skip them.
 *
 * Pure: no filesystem access. Browser-safe.
 *
 * @module hookActivity
 */

import { commandWord, shellSegments } from './shellCommand';
import type { SessionEvent } from './types/sessionEvent';

/** `origin.kind` of a hook-activity `system` event. */
export const HOOK_ACTIVITY_ORIGIN_KIND = 'hook';

/** `type` of the content block that carries the hook record. */
export const HOOK_ACTIVITY_BLOCK_TYPE = 'hook_activity';

/**
 * - `ok`: ran and allowed whatever it gated.
 * - `error`: failed without blocking.
 * - `blocked`: refused the call or the turn (a blocking error, or a JSON
 *   `permissionDecision: 'deny'` / `decision: 'block'`).
 * - `context`: added context or a message for the model or the person.
 */
export type HookActivityOutcome = 'ok' | 'error' | 'blocked' | 'context';

export interface HookActivity {
  /** The attachment type the record came from (`hook_success`, …). */
  attachment: string;
  /** `PreToolUse`, `PostToolUse`, `SessionStart`, … */
  hookEvent: string;
  outcome: HookActivityOutcome;
  /** The matcher part of the hook name (`Bash` for `PreToolUse:Bash`), when it is an identifier. */
  matcher?: string;
  /** The tool call the hook ran for (tool hooks only). */
  toolUseId?: string;
  exitCode?: number;
  durationMs?: number;
  /** Characters of context or message the hook added; never the text. */
  contentChars?: number;
  /** The hook program's name, when it is an identifier. */
  program?: string;
}

/** Hook events that run for one tool call, so their `toolUseID` names it. */
const TOOL_HOOK_EVENTS: ReadonlySet<string> = new Set([
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
]);

const IDENTIFIER = /^[\w.:@/-]{1,64}$/;
const EVENT_NAME = /^[A-Za-z][A-Za-z0-9_]{0,48}$/;
const RUNNERS: ReadonlySet<string> = new Set([
  'bash',
  'sh',
  'zsh',
  'node',
  'python',
  'python3',
  'deno',
  'bun',
  'ruby',
  'perl',
  'tsx',
  'npx',
  'uv',
]);

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function finiteInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : undefined;
}

/** Characters of text in a string, an array of strings / text blocks, or an object's `content`. */
function textLength(value: unknown, depth = 0): number {
  if (typeof value === 'string') return value.length;
  if (depth > 3) return 0;
  if (Array.isArray(value)) {
    let total = 0;
    for (const item of value) total += textLength(item, depth + 1);
    return total;
  }
  const object = record(value);
  if (!object) return 0;
  if (typeof object.text === 'string') return object.text.length;
  if (object.content !== undefined) return textLength(object.content, depth + 1);
  return 0;
}

/**
 * A hook's own name from its command line: the script a runner runs
 * (`bash "$ROOT/hooks/session-start.sh"` → `session-start`), else the
 * program. Only names that look like identifiers are returned.
 */
export function hookProgramName(command: unknown): string | undefined {
  if (typeof command !== 'string' || !command.trim()) return undefined;
  const first = shellSegments(command.slice(0, 4096))[0];
  if (!first || first.length === 0) return undefined;
  // Skip runners and their flags (`node --no-warnings x.js`, `uv run x.py`).
  let index = 0;
  while (index < first.length - 1) {
    const word = first[index];
    const name = commandWord(word);
    const isUvRun = name === 'run' && index > 0 && commandWord(first[index - 1]) === 'uv';
    if (!RUNNERS.has(name) && !/^-/.test(word) && !isUvRun) break;
    index++;
  }
  const name = commandWord(first[index]).replace(/\.[a-z0-9]{1,5}$/i, '');
  return IDENTIFIER.test(name) && !name.includes('$') ? name : undefined;
}

/**
 * What a hook's JSON stdout decided, read for its structure only:
 * `hookSpecificOutput.permissionDecision: 'deny'` or `decision: 'block'` is a
 * block; `additionalContext` or `systemMessage` is added context.
 */
function stdoutDecision(stdout: unknown): { blocked: boolean; contextChars: number } | null {
  if (typeof stdout !== 'string') return null;
  const trimmed = stdout.trim();
  if (!trimmed.startsWith('{') || trimmed.length > 1_000_000) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  const root = record(parsed);
  if (!root) return null;
  const specific = record(root.hookSpecificOutput);
  const blocked =
    root.decision === 'block' || root.continue === false || specific?.permissionDecision === 'deny';
  const contextChars = textLength(specific?.additionalContext) + textLength(root.systemMessage);
  return { blocked, contextChars };
}

/**
 * The content-free hook record for a Claude Code `hook_*` attachment line
 * (`{ type: 'attachment', attachment: { type: 'hook_success', … } }`), or
 * `null` for any other value.
 */
export function hookActivityFromAttachment(raw: unknown): HookActivity | null {
  const line = record(raw);
  if (!line || line.type !== 'attachment') return null;
  const attachment = record(line.attachment);
  if (!attachment || typeof attachment.type !== 'string') return null;
  const kind = attachment.type;
  if (!kind.startsWith('hook_')) return null;

  const hookName = typeof attachment.hookName === 'string' ? attachment.hookName : '';
  const hookEvent =
    typeof attachment.hookEvent === 'string' && EVENT_NAME.test(attachment.hookEvent)
      ? attachment.hookEvent
      : hookName.split(':')[0];
  if (!hookEvent || !EVENT_NAME.test(hookEvent)) return null;

  const exitCode = finiteInt(attachment.exitCode);
  let outcome: HookActivityOutcome;
  let contentChars = 0;
  switch (kind) {
    case 'hook_success': {
      const decision = stdoutDecision(attachment.stdout);
      contentChars = textLength(attachment.content) + (decision?.contextChars ?? 0);
      if (decision?.blocked) outcome = 'blocked';
      else if (exitCode !== undefined && exitCode !== 0) outcome = 'error';
      else outcome = contentChars > 0 ? 'context' : 'ok';
      break;
    }
    case 'hook_additional_context':
    case 'hook_system_message':
      contentChars = textLength(attachment.content);
      outcome = 'context';
      break;
    case 'hook_non_blocking_error':
    case 'hook_cancelled':
      outcome = 'error';
      break;
    default:
      // hook_blocking_error, hook_denied, hook_permission_decision, …
      outcome = /block|deni|deny|stop/i.test(kind) ? 'blocked' : 'error';
      contentChars = textLength(attachment.content);
      break;
  }

  const activity: HookActivity = { attachment: kind, hookEvent, outcome };
  const matcher = hookName.includes(':') ? hookName.slice(hookName.indexOf(':') + 1) : '';
  if (matcher && IDENTIFIER.test(matcher)) activity.matcher = matcher;
  if (TOOL_HOOK_EVENTS.has(hookEvent) && typeof attachment.toolUseID === 'string') {
    const id = attachment.toolUseID;
    if (id && id.length <= 128) activity.toolUseId = id;
  }
  if (exitCode !== undefined) activity.exitCode = exitCode;
  const durationMs = finiteInt(attachment.durationMs);
  if (durationMs !== undefined && durationMs >= 0) activity.durationMs = durationMs;
  if (contentChars > 0) activity.contentChars = contentChars;
  const program = hookProgramName(attachment.command);
  if (program) activity.program = program;
  return activity;
}

/** Whether an event is a hook-activity `system` event (see the module docs). */
export function isHookActivitySystemEvent(event: SessionEvent): boolean {
  return event.type === 'system' && event.origin?.kind === HOOK_ACTIVITY_ORIGIN_KIND;
}

const OUTCOMES: ReadonlySet<string> = new Set<HookActivityOutcome>([
  'ok',
  'error',
  'blocked',
  'context',
]);

/**
 * The hook record a hook-activity `system` event carries, copied with only
 * its known fields; `null` for any other event or a malformed block.
 */
export function hookActivityFromEvent(event: SessionEvent): HookActivity | null {
  if (!isHookActivitySystemEvent(event)) return null;
  const content = event.message?.content;
  if (!Array.isArray(content)) return null;
  for (const block of content) {
    const raw = record(block);
    if (!raw || raw.type !== HOOK_ACTIVITY_BLOCK_TYPE) continue;
    if (typeof raw.hookEvent !== 'string' || !EVENT_NAME.test(raw.hookEvent)) return null;
    if (typeof raw.outcome !== 'string' || !OUTCOMES.has(raw.outcome)) return null;
    const activity: HookActivity = {
      attachment: typeof raw.attachment === 'string' ? raw.attachment : 'hook',
      hookEvent: raw.hookEvent,
      outcome: raw.outcome as HookActivityOutcome,
    };
    if (typeof raw.matcher === 'string' && IDENTIFIER.test(raw.matcher)) {
      activity.matcher = raw.matcher;
    }
    if (typeof raw.toolUseId === 'string' && raw.toolUseId) activity.toolUseId = raw.toolUseId;
    const exitCode = finiteInt(raw.exitCode);
    if (exitCode !== undefined) activity.exitCode = exitCode;
    const durationMs = finiteInt(raw.durationMs);
    if (durationMs !== undefined && durationMs >= 0) activity.durationMs = durationMs;
    const contentChars = finiteInt(raw.contentChars);
    if (contentChars !== undefined && contentChars > 0) activity.contentChars = contentChars;
    if (typeof raw.program === 'string' && IDENTIFIER.test(raw.program)) {
      activity.program = raw.program;
    }
    return activity;
  }
  return null;
}

/** A one-line, content-free description, e.g. `PreToolUse hook (Bash) blocked the call`. */
export function describeHookActivity(activity: HookActivity): string {
  const name = activity.matcher
    ? `${activity.hookEvent} hook (${activity.matcher})`
    : `${activity.hookEvent} hook`;
  switch (activity.outcome) {
    case 'blocked':
      return `${name} blocked the call`;
    case 'error':
      return `${name} failed`;
    case 'context':
      return `${name} added context`;
    default:
      return `${name} ran`;
  }
}
