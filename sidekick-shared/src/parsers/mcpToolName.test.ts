import { describe, expect, it } from 'vitest';
import { parseMcpToolName } from './mcpToolName';

describe('parseMcpToolName', () => {
  it('splits a simple MCP tool identifier', () => {
    expect(parseMcpToolName('mcp__stitch__apply_design_system')).toEqual({
      serverName: 'stitch',
      toolName: 'apply_design_system',
    });
  });

  it('keeps single underscores inside the server name', () => {
    expect(parseMcpToolName('mcp__plugin_context7_context7__query-docs')).toEqual({
      serverName: 'plugin_context7_context7',
      toolName: 'query-docs',
    });
  });

  it('ends the server at the first double underscore, keeping later ones in the tool', () => {
    expect(parseMcpToolName('mcp__a__b__c')).toEqual({ serverName: 'a', toolName: 'b__c' });
  });

  it.each([
    ['empty string', ''],
    ['plain tool name', 'Bash'],
    ['double-underscore name without the prefix', 'foo__bar'],
    ['prefix only', 'mcp__'],
    ['missing tool part', 'mcp__server'],
    ['empty tool part', 'mcp__server__'],
    ['empty server part', 'mcp____tool'],
    ['case-mismatched prefix', 'MCP__server__tool'],
  ])('returns null for a malformed name (%s)', (_label, name) => {
    expect(parseMcpToolName(name)).toBeNull();
  });

  it('applies no trimming', () => {
    expect(parseMcpToolName(' mcp__server__tool')).toBeNull();
  });
});
