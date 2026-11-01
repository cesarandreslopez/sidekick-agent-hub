/**
 * @fileoverview Tool-input bookkeeping keys added by the session parsers.
 *
 * Raw session events carry `_sidekickRawToolName` / `_sidekickMcpServerName`
 * (and possibly other `_sidekick*` keys) inside a tool call's `input`. They
 * record where the call came from; they are not part of what the model sent.
 * Display and token attribution use the input without them.
 *
 * @module utils/toolInputOrigin
 */

const SIDEKICK_INPUT_KEY_PREFIX = '_sidekick';

export interface ToolInputOrigin {
  /** The input without top-level `_sidekick*` keys (the source object when it had none). */
  input: Record<string, unknown>;
  /** The provider's own tool name before normalization, when recorded. */
  rawToolName?: string;
  /** The MCP server the tool belongs to, when recorded. */
  mcpServerName?: string;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

/** Separates the parser's origin keys from a tool input. Never modifies `input`. */
export function splitToolInput(input: unknown): ToolInputOrigin {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { input: {} };
  const source = input as Record<string, unknown>;
  const keys = Object.keys(source);
  if (!keys.some((key) => key.startsWith(SIDEKICK_INPUT_KEY_PREFIX))) return { input: source };
  const clean: Record<string, unknown> = {};
  for (const key of keys) {
    if (!key.startsWith(SIDEKICK_INPUT_KEY_PREFIX)) clean[key] = source[key];
  }
  const rawToolName = nonEmptyString(source._sidekickRawToolName);
  const mcpServerName = nonEmptyString(source._sidekickMcpServerName);
  return {
    input: clean,
    ...(rawToolName ? { rawToolName } : {}),
    ...(mcpServerName ? { mcpServerName } : {}),
  };
}

/** The tool input as the model sent it, without `_sidekick*` keys. */
export function visibleToolInput(input: unknown): Record<string, unknown> {
  return splitToolInput(input).input;
}
