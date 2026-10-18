import { describe, expect, it } from 'vitest';
import { classifyTool, TOOL_CATEGORIES } from './toolCategory';

describe('classifyTool', () => {
  it.each([
    ['Bash', 'shell'],
    ['exec_command', 'shell'],
    ['local_shell', 'shell'],
    ['Read', 'file_read'],
    ['Edit', 'file_edit'],
    ['MultiEdit', 'file_edit'],
    ['Write', 'file_edit'],
    ['apply_patch', 'file_edit'],
    ['Grep', 'search'],
    ['Glob', 'search'],
    ['WebFetch', 'web'],
    ['web_search', 'web'],
    ['Task', 'subagent'],
    ['spawn_agent', 'subagent'],
    ['TodoWrite', 'planning'],
    ['update_plan', 'planning'],
    ['mcp__plugin_context7_context7__query-docs', 'mcp'],
    ['SomethingNew', 'other'],
  ])('%s is %s', (name, category) => {
    expect(classifyTool(name)).toBe(category);
    expect(TOOL_CATEGORIES).toContain(category);
  });

  it('treats a bare Codex tool name with a known server as MCP', () => {
    expect(classifyTool('lookup')).toBe('other');
    expect(classifyTool('lookup', { mcpServer: 's' })).toBe('mcp');
  });
});
