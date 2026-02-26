/**
 * Rich tool summary formatters.
 *
 * Registry of per-tool formatters that produce contextual one-liner summaries.
 * Replaces the generic field-fallback `summarizeToolInput()` with tool-specific
 * formatting inspired by tail-claude's 19+ tool formatters.
 *
 * @module formatters/toolSummary
 */

// ── Types ──

type ToolInput = Record<string, unknown>;
type ToolFormatter = (input: ToolInput) => string;

// ── Helpers ──

function truncate(text: string, maxLen: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > maxLen ? clean.substring(0, maxLen - 3) + '...' : clean;
}

function basename(filePath: string): string {
  const parts = filePath.replace(/\\/g, '/').split('/');
  return parts[parts.length - 1] || filePath;
}

function hostname(url: string): string {
  try {
    const u = new URL(url);
    return u.hostname + (u.pathname !== '/' ? u.pathname : '');
  } catch {
    return truncate(url, 60);
  }
}

function countLines(content: unknown): number | null {
  if (typeof content !== 'string') return null;
  const lines = content.split('\n').length;
  return lines;
}

// ── Per-Tool Formatters ──

const formatRead: ToolFormatter = (input) => {
  const filePath = input.file_path as string | undefined;
  if (!filePath) return '';
  const name = basename(filePath);
  const offset = input.offset as number | undefined;
  const limit = input.limit as number | undefined;
  if (offset && limit) return `${name}:${offset}-${offset + limit}`;
  if (offset) return `${name}:${offset}+`;
  if (limit) return `${name} (${limit} lines)`;
  return name;
};

const formatWrite: ToolFormatter = (input) => {
  const filePath = input.file_path as string | undefined;
  if (!filePath) return '';
  const name = basename(filePath);
  const lines = countLines(input.content);
  if (lines !== null) return `${name} — ${lines} lines`;
  return name;
};

const formatEdit: ToolFormatter = (input) => {
  const filePath = input.file_path as string | undefined;
  if (!filePath) return '';
  const name = basename(filePath);
  const oldStr = input.old_string as string | undefined;
  const newStr = input.new_string as string | undefined;
  const oldLines = oldStr ? oldStr.split('\n').length : 0;
  const newLines = newStr ? newStr.split('\n').length : 0;
  if (oldLines || newLines) return `${name} — ${oldLines}→${newLines} lines`;
  return name;
};

const formatBash: ToolFormatter = (input) => {
  // Prefer description field (Claude Code provides human-readable descriptions)
  if (typeof input.description === 'string' && input.description.length > 0) {
    return truncate(input.description, 80);
  }
  if (typeof input.command === 'string') {
    // Take just the first line of multi-line commands
    const firstLine = input.command.split('\n')[0];
    return truncate(firstLine, 80);
  }
  return '';
};

const formatGrep: ToolFormatter = (input) => {
  const pattern = input.pattern as string | undefined;
  if (!pattern) return '';
  const glob = input.glob as string | undefined;
  const path = input.path as string | undefined;
  const type = input.type as string | undefined;
  const parts = [truncate(pattern, 40)];
  if (glob) parts.push(`in ${glob}`);
  else if (type) parts.push(`in *.${type}`);
  else if (path) parts.push(`in ${basename(path)}`);
  return parts.join(' ');
};

const formatGlob: ToolFormatter = (input) => {
  const pattern = input.pattern as string | undefined;
  if (!pattern) return '';
  const path = input.path as string | undefined;
  if (path) return `${pattern} in ${basename(path)}`;
  return pattern;
};

const formatTask: ToolFormatter = (input) => {
  const subagentType = input.subagent_type as string | undefined;
  const description = input.description as string | undefined;
  const prompt = input.prompt as string | undefined;
  const parts: string[] = [];
  if (subagentType) parts.push(`[${subagentType}]`);
  if (description) parts.push(truncate(description, 60));
  else if (prompt) parts.push(truncate(prompt, 60));
  return parts.join(' ') || '';
};

const formatWebFetch: ToolFormatter = (input) => {
  const url = input.url as string | undefined;
  if (!url) return '';
  return hostname(url);
};

const formatWebSearch: ToolFormatter = (input) => {
  const query = input.query as string | undefined;
  if (!query) return '';
  return truncate(query, 80);
};

const formatToolSearch: ToolFormatter = (input) => {
  const query = input.query as string | undefined;
  if (!query) return '';
  return truncate(query, 80);
};

const formatNotebookEdit: ToolFormatter = (input) => {
  const filePath = input.file_path as string | undefined;
  const cellNumber = input.cell_number as number | undefined;
  if (!filePath) return '';
  const name = basename(filePath);
  if (cellNumber !== undefined) return `${name} cell ${cellNumber}`;
  return name;
};

const formatTaskCreate: ToolFormatter = (input) => {
  const subject = input.subject as string | undefined;
  if (subject) return truncate(subject, 80);
  return '';
};

const formatTaskUpdate: ToolFormatter = (input) => {
  const taskId = input.task_id as string | undefined;
  const status = input.status as string | undefined;
  if (taskId && status) return `${taskId} → ${status}`;
  if (taskId) return taskId;
  return '';
};

// ── Registry ──

const TOOL_FORMATTERS: Record<string, ToolFormatter> = {
  Read: formatRead,
  Write: formatWrite,
  Edit: formatEdit,
  Bash: formatBash,
  Grep: formatGrep,
  Glob: formatGlob,
  Task: formatTask,
  WebFetch: formatWebFetch,
  WebSearch: formatWebSearch,
  ToolSearch: formatToolSearch,
  NotebookEdit: formatNotebookEdit,
  TaskCreate: formatTaskCreate,
  TaskUpdate: formatTaskUpdate,
};

// ── Generic fallback ──

function genericFallback(input: ToolInput): string {
  if (typeof input.command === 'string') return truncate(input.command, 80);
  if (typeof input.file_path === 'string') return truncate(input.file_path, 80);
  if (typeof input.pattern === 'string') return truncate(input.pattern, 80);
  if (typeof input.query === 'string') return truncate(input.query, 80);
  if (typeof input.path === 'string') return truncate(input.path, 80);
  if (typeof input.url === 'string') return truncate(input.url, 80);
  for (const val of Object.values(input)) {
    if (typeof val === 'string' && val.length > 0) return truncate(val, 80);
  }
  return '';
}

// ── Public API ──

/**
 * Produces a contextual one-liner summary for a tool call.
 *
 * Uses a registry of per-tool formatters for known tools (Read, Write, Edit,
 * Bash, Grep, Glob, Task, WebFetch, WebSearch, etc.) and falls back to
 * generic field extraction for unknown tools.
 *
 * @param toolName - The canonical tool name (e.g., "Read", "Bash")
 * @param input - The tool's input parameters
 * @returns A human-readable one-liner summary (may be empty string)
 */
export function formatToolSummary(toolName: string, input: Record<string, unknown>): string {
  // Strip MCP prefixes: "mcp__server__tool" → use "tool" for matching
  const baseName = toolName.includes('__')
    ? toolName.split('__').pop() ?? toolName
    : toolName;

  const formatter = TOOL_FORMATTERS[toolName] ?? TOOL_FORMATTERS[baseName];
  if (formatter) {
    const result = formatter(input);
    if (result) return result;
  }
  return genericFallback(input);
}

// Re-export truncate for use by other formatters
export { truncate };
