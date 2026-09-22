/**
 * One shared definition of "a prompt a person typed" for Claude Code and
 * Codex transcripts. Pure: no filesystem access, so it can classify messages
 * from `readSessionTranscript()` or from `collectPromptHistory()` alike.
 */

import type { CanonicalTranscriptMessage } from './transcript';

export type HumanPromptProvider = 'claude-code' | 'codex';

/**
 * Claude Code `entrypoint` values treated as a person at the keyboard:
 * the interactive CLI, Claude Desktop's Code surface, and `claude -p`.
 * `sdk-ts` / `sdk-py` (Agent SDK programs) are excluded.
 */
export const HUMAN_CLAUDE_ENTRYPOINTS: readonly string[] = Object.freeze([
  'cli',
  'claude-desktop',
  'sdk-cli',
]);

/**
 * Codex `session_meta.source` values whose sessions carry typed prompts.
 * Subagent sessions (`{ subagent: … }`) are excluded; they replay parent
 * history. This is a session-level rule applied by `collectPromptHistory()`.
 */
export const HUMAN_CODEX_SOURCES: readonly string[] = Object.freeze(['cli', 'vscode', 'exec']);

/** Claude user text that is harness output rather than something typed. */
const CLAUDE_INJECTED_PREFIX =
  /^(?:<(?:local-command-stdout|local-command-stderr|local-command-caveat|task-notification|system-reminder|bash-input|bash-stdout|bash-stderr|user-prompt-submit-hook)\b|\[Request interrupted\b|This session is being continued from a previous conversation)/;

const COMMAND_NAME = /<command-name>\s*([\s\S]*?)\s*<\/command-name>/;
const COMMAND_ARGS = /<command-args>\s*([\s\S]*?)\s*<\/command-args>/;

/** Codex user-role blocks injected by the harness (context, instructions, markers). */
const CODEX_INJECTED_PREFIX =
  /^(?:# AGENTS\.md instructions\b|<(?:environment_context|user_instructions|recommended_plugins|turn_aborted|skill|subagent_notification|codex_internal_context|user_shell_command|permissions instructions|collaboration_mode)\b)/;

/** Codex wraps attached images as `<image name=…>` / `</image>` text blocks. */
const CODEX_IMAGE_WRAPPER = /^<\/?image\b[^>]*>$/;

/** Whether a canonical transcript message is a prompt a person typed. */
export function isHumanPrompt(
  message: CanonicalTranscriptMessage,
  provider: HumanPromptProvider,
): boolean {
  return humanPromptText(message, provider) !== null;
}

/**
 * The visible text of a human prompt, or `null` when the message is not one.
 * Claude slash commands are returned as typed (`/review foo`); Codex image
 * wrappers and injected context blocks are dropped. Text is never truncated.
 */
export function humanPromptText(
  message: CanonicalTranscriptMessage,
  provider: HumanPromptProvider,
): string | null {
  if (message.role !== 'user') return null;
  if ((message.source.originalRole ?? 'user') !== 'user') return null;
  return provider === 'claude-code' ? claudePromptText(message) : codexPromptText(message);
}

function claudePromptText(message: CanonicalTranscriptMessage): string | null {
  const source = message.source;
  if (!source.entrypoint || !HUMAN_CLAUDE_ENTRYPOINTS.includes(source.entrypoint)) return null;
  if (source.isMeta === true || source.isSidechain === true) return null;
  if (source.isCompactSummary === true) return null;
  if (source.originKind !== undefined && source.originKind !== 'human') return null;
  if (source.promptSource === 'system') return null;

  const text = textBlocks(message).join('\n');
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (CLAUDE_INJECTED_PREFIX.test(trimmed)) return null;

  const command = trimmed.match(COMMAND_NAME);
  if (command && /^<command-(?:name|message)>/.test(trimmed)) {
    const name = command[1].trim();
    if (!name) return null;
    const args = trimmed.match(COMMAND_ARGS)?.[1].trim() ?? '';
    const visible = name.startsWith('/') ? name : `/${name}`;
    return args ? `${visible} ${args}` : visible;
  }
  return text;
}

function codexPromptText(message: CanonicalTranscriptMessage): string | null {
  const typed = textBlocks(message).filter((text) => {
    const trimmed = text.trim();
    return (
      trimmed.length > 0 &&
      !CODEX_INJECTED_PREFIX.test(trimmed) &&
      !CODEX_IMAGE_WRAPPER.test(trimmed)
    );
  });
  return typed.length > 0 ? typed.join('\n') : null;
}

function textBlocks(message: CanonicalTranscriptMessage): string[] {
  return message.content
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string);
}
