/**
 * One vocabulary for what a tool call does, across Claude Code, Codex, and
 * OpenCode tool names. Browser-safe: no Node imports.
 *
 * @module toolCategory
 */

import { parseMcpToolName } from './parsers/mcpToolName';

export const TOOL_CATEGORIES = [
  'shell',
  'file_read',
  'file_edit',
  'search',
  'web',
  'subagent',
  'planning',
  'mcp',
  'other',
] as const;
export type ToolCategory = (typeof TOOL_CATEGORIES)[number];

/** Lower-cased tool names of every provider, by category. */
const CATEGORY_BY_NAME = new Map<string, ToolCategory>(
  (
    [
      [
        'shell',
        [
          'bash',
          'bashoutput',
          'killbash',
          'killshell',
          'exec_command',
          'shell',
          'local_shell',
          'local_shell_call',
          'container.exec',
          'write_stdin',
        ],
      ],
      ['file_read', ['read', 'notebookread', 'ls', 'list', 'view_image']],
      [
        'file_edit',
        ['edit', 'multiedit', 'write', 'notebookedit', 'apply_patch', 'patch', 'patch_applied'],
      ],
      ['search', ['grep', 'glob', 'codesearch', 'toolsearch']],
      ['web', ['webfetch', 'websearch', 'web_search', 'web_search_call', 'fetch']],
      [
        'subagent',
        [
          'task',
          'agent',
          'spawn_agent',
          'wait_agent',
          'send_message',
          'followup_task',
          'list_agents',
          'wait',
        ],
      ],
      [
        'planning',
        [
          'todowrite',
          'todoread',
          'update_plan',
          'updateplan',
          'enterplanmode',
          'exitplanmode',
          'taskcreate',
          'taskupdate',
          'tasklist',
          'askuserquestion',
          'request_user_input',
        ],
      ],
    ] as Array<[ToolCategory, string[]]>
  ).flatMap(([category, names]) => names.map((name) => [name, category] as const)),
);

export interface ClassifyToolOptions {
  /** The MCP server the call went to, when the log records it separately (Codex). */
  mcpServer?: string;
}

/**
 * Classifies a tool name from any supported provider. `mcp__<server>__<tool>`
 * names and calls with a known `mcpServer` are `mcp`; unknown names are
 * `other`.
 */
export function classifyTool(name: string, options: ClassifyToolOptions = {}): ToolCategory {
  if (options.mcpServer || parseMcpToolName(name)) return 'mcp';
  return CATEGORY_BY_NAME.get(name.trim().toLowerCase()) ?? 'other';
}
