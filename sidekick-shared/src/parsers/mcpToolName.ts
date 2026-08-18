/**
 * Claude Code exposes MCP tools under composite identifiers of the form
 * `mcp__<server>__<tool>`. Splitting them correctly is subtle enough that
 * consumers keep re-implementing it by hand (usually with a plain
 * `split('__')`, which mangles server names containing single underscores).
 * This module is the canonical splitter. Browser-safe: no Node imports.
 *
 * @module mcpToolName
 */

export interface McpToolNameParts {
  serverName: string;
  toolName: string;
}

const MCP_TOOL_NAME_PATTERN = /^mcp__([^_]+(?:_[^_]+)*)__(.+)$/;

/**
 * Splits a Claude Code MCP tool identifier `mcp__<server>__<tool>` into parts.
 *
 * The server name ends at the first double underscore after the prefix, so
 * single underscores stay inside it (`mcp__plugin_context7_context7__query-docs`
 * → server `plugin_context7_context7`) and the tool keeps any further double
 * underscores (`mcp__a__b__c` → tool `b__c`).
 *
 * Returns `null` for anything that is not a well-formed MCP tool id: a
 * non-`mcp__` name, a missing or empty server or tool part, or a
 * case-mismatched prefix. No trimming is applied.
 */
export function parseMcpToolName(name: string): McpToolNameParts | null {
  const match = MCP_TOOL_NAME_PATTERN.exec(name);
  if (!match) return null;
  return { serverName: match[1], toolName: match[2] };
}
