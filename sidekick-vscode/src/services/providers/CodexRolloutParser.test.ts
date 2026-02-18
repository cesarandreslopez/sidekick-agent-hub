/**
 * @fileoverview Tests for CodexRolloutParser.
 * @module services/providers/CodexRolloutParser.test
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { CodexRolloutParser, extractPatchFilePaths } from './CodexRolloutParser';
import type { CodexRolloutLine } from '../../types/codex';

describe('CodexRolloutParser', () => {
  let parser: CodexRolloutParser;

  beforeEach(() => {
    parser = new CodexRolloutParser();
  });

  // --- session_meta ---

  describe('session_meta', () => {
    it('should store metadata and emit no events', () => {
      const line: CodexRolloutLine = {
        timestamp: '2025-01-15T10:00:00Z',
        type: 'session_meta',
        payload: {
          id: 'sess-123',
          cwd: '/home/user/project',
          model_provider: 'openai',
          cli_version: '0.1.0',
        },
      };

      const events = parser.convertLine(line);
      expect(events).toHaveLength(0);
      expect(parser.getSessionMeta()).toEqual(expect.objectContaining({
        id: 'sess-123',
        cwd: '/home/user/project',
      }));
    });
  });

  // --- response_item/message ---

  describe('response_item/message', () => {
    it('should convert user message with string content', () => {
      const line: CodexRolloutLine = {
        timestamp: '2025-01-15T10:01:00Z',
        type: 'response_item',
        payload: {
          type: 'message',
          id: 'msg-1',
          role: 'user',
          content: 'Hello, world!',
        },
      };

      const events = parser.convertLine(line);
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('user');
      expect(events[0].message.role).toBe('user');
      expect(events[0].message.id).toBe('msg-1');
      const content = events[0].message.content as Array<{ type: string; text: string }>;
      expect(content[0].text).toBe('Hello, world!');
    });

    it('should convert user message with content parts array', () => {
      const line: CodexRolloutLine = {
        timestamp: '2025-01-15T10:01:00Z',
        type: 'response_item',
        payload: {
          type: 'message',
          id: 'msg-2',
          role: 'user',
          content: [
            { type: 'input_text', text: 'Part 1' },
            { type: 'input_text', text: 'Part 2' },
          ],
        },
      };

      const events = parser.convertLine(line);
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('user');
      const content = events[0].message.content as Array<{ type: string; text: string }>;
      expect(content[0].text).toBe('Part 1\nPart 2');
    });

    it('should convert assistant message', () => {
      // Set model first
      parser.convertLine({
        timestamp: '2025-01-15T10:00:00Z',
        type: 'turn_context',
        payload: { model: 'gpt-4.1' },
      });

      const line: CodexRolloutLine = {
        timestamp: '2025-01-15T10:01:00Z',
        type: 'response_item',
        payload: {
          type: 'message',
          id: 'msg-3',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Hello from assistant' }],
        },
      };

      const events = parser.convertLine(line);
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('assistant');
      expect(events[0].message.model).toBe('gpt-4.1');
      const content = events[0].message.content as Array<{ type: string; text: string }>;
      expect(content[0].text).toBe('Hello from assistant');
    });

    it('should emit no events for empty content', () => {
      const line: CodexRolloutLine = {
        timestamp: '2025-01-15T10:01:00Z',
        type: 'response_item',
        payload: {
          type: 'message',
          id: 'msg-4',
          role: 'user',
          content: '',
        },
      };

      const events = parser.convertLine(line);
      expect(events).toHaveLength(0);
    });

    it('should emit no events for system messages', () => {
      const line: CodexRolloutLine = {
        timestamp: '2025-01-15T10:01:00Z',
        type: 'response_item',
        payload: {
          type: 'message',
          id: 'msg-sys',
          role: 'system',
          content: 'System prompt',
        },
      };

      const events = parser.convertLine(line);
      expect(events).toHaveLength(0);
    });
  });

  // --- response_item/reasoning ---

  describe('response_item/reasoning', () => {
    it('should convert reasoning to thinking block', () => {
      const line: CodexRolloutLine = {
        timestamp: '2025-01-15T10:02:00Z',
        type: 'response_item',
        payload: {
          type: 'reasoning',
          id: 'reason-1',
          summary: [
            { type: 'summary_text', text: 'I need to think about this...' },
            { type: 'summary_text', text: 'Let me reason step by step.' },
          ],
        },
      };

      const events = parser.convertLine(line);
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('assistant');
      const content = events[0].message.content as Array<{ type: string; thinking: string }>;
      expect(content[0].type).toBe('thinking');
      expect(content[0].thinking).toContain('I need to think about this...');
      expect(content[0].thinking).toContain('Let me reason step by step.');
    });

    it('should emit no events for empty reasoning', () => {
      const line: CodexRolloutLine = {
        timestamp: '2025-01-15T10:02:00Z',
        type: 'response_item',
        payload: {
          type: 'reasoning',
          id: 'reason-empty',
          summary: [],
        },
      };

      const events = parser.convertLine(line);
      expect(events).toHaveLength(0);
    });
  });

  // --- response_item/function_call ---

  describe('response_item/function_call', () => {
    it('should convert function_call to tool_use', () => {
      const line: CodexRolloutLine = {
        timestamp: '2025-01-15T10:03:00Z',
        type: 'response_item',
        payload: {
          type: 'function_call',
          id: 'fc-1',
          call_id: 'call-abc',
          name: 'read',
          arguments: '{"file_path":"/tmp/test.txt"}',
        },
      };

      const events = parser.convertLine(line);
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('assistant');
      const content = events[0].message.content as Array<{ type: string; id: string; name: string; input: Record<string, unknown> }>;
      expect(content[0].type).toBe('tool_use');
      expect(content[0].id).toBe('call-abc');
      expect(content[0].name).toBe('Read');
      expect(content[0].input).toEqual({
        file_path: '/tmp/test.txt',
        _sidekickRawToolName: 'read',
      });
    });

    it('should handle malformed JSON arguments gracefully', () => {
      const line: CodexRolloutLine = {
        timestamp: '2025-01-15T10:03:00Z',
        type: 'response_item',
        payload: {
          type: 'function_call',
          id: 'fc-bad',
          call_id: 'call-bad',
          name: 'bash',
          arguments: 'not json',
        },
      };

      const events = parser.convertLine(line);
      expect(events).toHaveLength(1);
      const content = events[0].message.content as Array<{ type: string; input: Record<string, unknown> }>;
      expect(content[0].input).toEqual({ raw: 'not json', _sidekickRawToolName: 'bash' });
    });

    it('should normalize Exec_command to Bash with command field', () => {
      const line: CodexRolloutLine = {
        timestamp: '2025-01-15T10:03:00Z',
        type: 'response_item',
        payload: {
          type: 'function_call',
          id: 'fc-exec',
          call_id: 'call-exec',
          name: 'Exec_command',
          arguments: '{"cmd":"ls -la src"}',
        },
      };

      const events = parser.convertLine(line);
      expect(events).toHaveLength(1);
      const content = events[0].message.content as Array<{ name: string; input: Record<string, unknown> }>;
      expect(content[0].name).toBe('Bash');
      expect(content[0].input.cmd).toBe('ls -la src');
      expect(content[0].input.command).toBe('ls -la src');
      expect(content[0].input._sidekickRawToolName).toBe('Exec_command');
    });
  });

  // --- response_item/function_call_output ---

  describe('response_item/function_call_output', () => {
    it('should convert function_call_output to tool_result', () => {
      const line: CodexRolloutLine = {
        timestamp: '2025-01-15T10:04:00Z',
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          call_id: 'call-abc',
          output: 'file contents here',
        },
      };

      const events = parser.convertLine(line);
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('user');
      const content = events[0].message.content as Array<{ type: string; tool_use_id: string; content: string }>;
      expect(content[0].type).toBe('tool_result');
      expect(content[0].tool_use_id).toBe('call-abc');
      expect(content[0].content).toBe('file contents here');
    });

    it('should infer error from plain-text non-zero exit code', () => {
      const line: CodexRolloutLine = {
        timestamp: '2025-01-15T10:04:00Z',
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          call_id: 'call-abc',
          output: 'Process exited with code 42',
        },
      };

      const events = parser.convertLine(line);
      const content = events[0].message.content as Array<{ is_error?: boolean }>;
      expect(content[0].is_error).toBe(true);
    });
  });

  // --- response_item/local_shell_call ---

  describe('response_item/local_shell_call', () => {
    it('should convert local_shell_call to Bash tool_use', () => {
      const line: CodexRolloutLine = {
        timestamp: '2025-01-15T10:05:00Z',
        type: 'response_item',
        payload: {
          type: 'local_shell_call',
          id: 'shell-1',
          call_id: 'call-shell',
          action: {
            type: 'exec',
            command: ['ls', '-la', '/tmp'],
            workdir: '/home/user',
          },
        },
      };

      const events = parser.convertLine(line);
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('assistant');
      const content = events[0].message.content as Array<{ type: string; name: string; input: Record<string, unknown> }>;
      expect(content[0].name).toBe('Bash');
      expect(content[0].input.command).toBe('ls -la /tmp');
      expect(content[0].input.workdir).toBe('/home/user');
      expect(content[0].input._sidekickRawToolName).toBe('local_shell_call');
    });
  });

  // --- compacted ---

  describe('compacted', () => {
    it('should convert compacted to summary event', () => {
      const line: CodexRolloutLine = {
        timestamp: '2025-01-15T10:06:00Z',
        type: 'compacted',
        payload: { summary: 'Previous context was summarized.' },
      };

      const events = parser.convertLine(line);
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('summary');
      expect(events[0].message.content).toBe('Previous context was summarized.');
    });

    it('should handle compacted without summary', () => {
      const line: CodexRolloutLine = {
        timestamp: '2025-01-15T10:06:00Z',
        type: 'compacted',
        payload: {},
      };

      const events = parser.convertLine(line);
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('summary');
      expect(events[0].message.content).toBe('Context compacted');
    });
  });

  // --- turn_context ---

  describe('turn_context', () => {
    it('should update current model', () => {
      const line: CodexRolloutLine = {
        timestamp: '2025-01-15T10:07:00Z',
        type: 'turn_context',
        payload: {
          model: 'o3',
          cwd: '/home/user',
          approval_policy: 'auto-edit',
        },
      };

      const events = parser.convertLine(line);
      expect(events).toHaveLength(0);
      expect(parser.getCurrentModel()).toBe('o3');
    });
  });

  // --- event_msg/token_count ---

  describe('event_msg/token_count', () => {
    it('should convert token_count to assistant event with usage', () => {
      const line: CodexRolloutLine = {
        timestamp: '2025-01-15T10:08:00Z',
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            last_token_usage: {
              input_tokens: 1000,
              cached_input_tokens: 500,
              output_tokens: 200,
              reasoning_output_tokens: 50,
              total_tokens: 1200,
            },
          },
        },
      };

      const events = parser.convertLine(line);
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('assistant');
      expect(events[0].message.usage).toEqual({
        input_tokens: 1000,
        output_tokens: 200,
        cache_read_input_tokens: 500,
        cache_creation_input_tokens: 0,
        reasoning_tokens: 50,
      });
    });

    it('should track last token usage', () => {
      const line: CodexRolloutLine = {
        timestamp: '2025-01-15T10:08:00Z',
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            last_token_usage: {
              input_tokens: 1000,
              output_tokens: 200,
            },
          },
        },
      };

      parser.convertLine(line);
      const lastUsage = parser.getLastTokenUsage();
      expect(lastUsage).toBeDefined();
      expect(lastUsage!.input_tokens).toBe(1000);
    });
  });

  // --- event_msg/agent_message (suppressed — duplicates response_item/message) ---

  describe('event_msg/agent_message', () => {
    it('should suppress agent_message (duplicates response_item/message)', () => {
      const line: CodexRolloutLine = {
        timestamp: '2025-01-15T10:09:00Z',
        type: 'event_msg',
        payload: {
          type: 'agent_message',
          message: 'I will help you with that.',
        },
      };

      const events = parser.convertLine(line);
      expect(events).toHaveLength(0);
    });
  });

  // --- event_msg/user_message (suppressed — duplicates response_item/message) ---

  describe('event_msg/user_message', () => {
    it('should suppress user_message (duplicates response_item/message)', () => {
      const line: CodexRolloutLine = {
        timestamp: '2025-01-15T10:10:00Z',
        type: 'event_msg',
        payload: {
          type: 'user_message',
          message: 'Please fix the bug.',
        },
      };

      const events = parser.convertLine(line);
      expect(events).toHaveLength(0);
    });
  });

  // --- event_msg/exec_command_begin + end pairing ---

  describe('event_msg/exec_command_begin + end', () => {
    it('should pair begin/end into tool_use + tool_result', () => {
      const beginLine: CodexRolloutLine = {
        timestamp: '2025-01-15T10:11:00Z',
        type: 'event_msg',
        payload: {
          type: 'exec_command_begin',
          call_id: 'exec-1',
          command: ['npm', 'test'],
          workdir: '/project',
        },
      };

      const endLine: CodexRolloutLine = {
        timestamp: '2025-01-15T10:11:05Z',
        type: 'event_msg',
        payload: {
          type: 'exec_command_end',
          call_id: 'exec-1',
          exit_code: 0,
          stdout: 'All tests passed',
          duration_ms: 5000,
        },
      };

      // Begin emits nothing
      const beginEvents = parser.convertLine(beginLine);
      expect(beginEvents).toHaveLength(0);

      // End emits tool_use + tool_result
      const endEvents = parser.convertLine(endLine);
      expect(endEvents).toHaveLength(2);

      // First: tool_use (Bash)
      expect(endEvents[0].type).toBe('assistant');
      const toolUse = (endEvents[0].message.content as Array<{ type: string; name: string; input: Record<string, unknown> }>)[0];
      expect(toolUse.name).toBe('Bash');
      expect(toolUse.input.command).toBe('npm test');

      // Second: tool_result
      expect(endEvents[1].type).toBe('user');
      const toolResult = (endEvents[1].message.content as Array<{ type: string; tool_use_id: string; content: string; is_error: boolean }>)[0];
      expect(toolResult.type).toBe('tool_result');
      expect(toolResult.tool_use_id).toBe('exec-1');
      expect(toolResult.content).toBe('All tests passed');
      expect(toolResult.is_error).toBe(false);
    });

    it('should mark failed commands as errors', () => {
      parser.convertLine({
        timestamp: '2025-01-15T10:11:00Z',
        type: 'event_msg',
        payload: {
          type: 'exec_command_begin',
          call_id: 'exec-fail',
          command: ['false'],
        },
      });

      const events = parser.convertLine({
        timestamp: '2025-01-15T10:11:01Z',
        type: 'event_msg',
        payload: {
          type: 'exec_command_end',
          call_id: 'exec-fail',
          exit_code: 1,
          stderr: 'command failed',
        },
      });

      const toolResult = (events[1].message.content as Array<{ is_error: boolean; content: string }>)[0];
      expect(toolResult.is_error).toBe(true);
      expect(toolResult.content).toBe('command failed');
    });

    it('should handle end without begin gracefully', () => {
      const events = parser.convertLine({
        timestamp: '2025-01-15T10:11:05Z',
        type: 'event_msg',
        payload: {
          type: 'exec_command_end',
          call_id: 'orphan',
          exit_code: 0,
          stdout: 'output',
        },
      });

      // Should still emit events (with empty command)
      expect(events).toHaveLength(2);
      const toolUse = (events[0].message.content as Array<{ input: Record<string, unknown> }>)[0];
      expect(toolUse.input.command).toBe('');
    });
  });

  // --- event_msg/mcp_tool_call_begin + end ---

  describe('event_msg/mcp_tool_call_begin + end', () => {
    it('should pair MCP begin/end into tool_use + tool_result', () => {
      parser.convertLine({
        timestamp: '2025-01-15T10:12:00Z',
        type: 'event_msg',
        payload: {
          type: 'mcp_tool_call_begin',
          call_id: 'mcp-1',
          server_name: 'fs-server',
          tool_name: 'read_file',
          arguments: { path: '/tmp/test.txt' },
        },
      });

      const events = parser.convertLine({
        timestamp: '2025-01-15T10:12:01Z',
        type: 'event_msg',
        payload: {
          type: 'mcp_tool_call_end',
          call_id: 'mcp-1',
          result: 'file content',
          is_error: false,
          duration_ms: 100,
        },
      });

      expect(events).toHaveLength(2);

      const toolUse = (events[0].message.content as Array<{ name: string; input: Record<string, unknown> }>)[0];
      expect(toolUse.name).toBe('Read_file');

      const toolResult = (events[1].message.content as Array<{ content: string; is_error: boolean }>)[0];
      expect(toolResult.content).toBe('file content');
      expect(toolResult.is_error).toBe(false);
    });

    it('should handle MCP errors', () => {
      parser.convertLine({
        timestamp: '2025-01-15T10:12:00Z',
        type: 'event_msg',
        payload: {
          type: 'mcp_tool_call_begin',
          call_id: 'mcp-err',
          tool_name: 'read_file',
        },
      });

      const events = parser.convertLine({
        timestamp: '2025-01-15T10:12:01Z',
        type: 'event_msg',
        payload: {
          type: 'mcp_tool_call_end',
          call_id: 'mcp-err',
          result: 'file not found',
          is_error: true,
        },
      });

      const toolResult = (events[1].message.content as Array<{ is_error: boolean }>)[0];
      expect(toolResult.is_error).toBe(true);
    });
  });

  // --- event_msg/error ---

  describe('event_msg/error', () => {
    it('should convert error to assistant text event', () => {
      const line: CodexRolloutLine = {
        timestamp: '2025-01-15T10:13:00Z',
        type: 'event_msg',
        payload: {
          type: 'error',
          message: 'Rate limit exceeded',
          code: '429',
        },
      };

      const events = parser.convertLine(line);
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('assistant');
      const content = events[0].message.content as Array<{ text: string }>;
      expect(content[0].text).toContain('[Error (429)]');
      expect(content[0].text).toContain('Rate limit exceeded');
    });

    it('should handle error without code', () => {
      const events = parser.convertLine({
        timestamp: '2025-01-15T10:13:00Z',
        type: 'event_msg',
        payload: {
          type: 'error',
          message: 'Something went wrong',
        },
      });

      const content = events[0].message.content as Array<{ text: string }>;
      expect(content[0].text).toBe('[Error] Something went wrong');
    });
  });

  // --- event_msg/context_compacted ---

  describe('event_msg/context_compacted', () => {
    it('should convert context_compacted to summary event', () => {
      const line: CodexRolloutLine = {
        timestamp: '2025-01-15T10:14:00Z',
        type: 'event_msg',
        payload: {
          type: 'context_compacted',
          summary: 'Context was trimmed',
          tokens_before: 100000,
          tokens_after: 50000,
        },
      };

      const events = parser.convertLine(line);
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('summary');
      expect(events[0].message.content).toBe('Context was trimmed');
    });
  });

  // --- event_msg/task_started + task_complete (plan mode) ---

  describe('event_msg/task_started + task_complete', () => {
    it('should emit EnterPlanMode/ExitPlanMode for plan collaboration mode', () => {
      const enter = parser.convertLine({
        timestamp: '2025-01-15T10:14:10Z',
        type: 'event_msg',
        payload: {
          type: 'task_started',
          collaboration_mode_kind: 'plan',
        },
      });

      expect(enter).toHaveLength(1);
      const enterContent = enter[0].message.content as Array<{ name: string }>;
      expect(enterContent[0].name).toBe('EnterPlanMode');

      const exit = parser.convertLine({
        timestamp: '2025-01-15T10:14:20Z',
        type: 'event_msg',
        payload: {
          type: 'task_complete',
        },
      });

      expect(exit).toHaveLength(1);
      const exitContent = exit[0].message.content as Array<{ name: string }>;
      expect(exitContent[0].name).toBe('ExitPlanMode');
    });

    it('should ignore non-plan task_started events', () => {
      const events = parser.convertLine({
        timestamp: '2025-01-15T10:14:10Z',
        type: 'event_msg',
        payload: {
          type: 'task_started',
          collaboration_mode_kind: 'default',
        },
      });
      expect(events).toHaveLength(0);
    });
  });

  // --- event_msg/patch_applied ---

  describe('event_msg/patch_applied', () => {
    it('should convert patch_applied to Edit tool_use event', () => {
      parser.convertLine({
        timestamp: '2025-01-15T10:00:00Z',
        type: 'turn_context',
        payload: { model: 'o4-mini' },
      });

      const events = parser.convertLine({
        timestamp: '2025-01-15T10:14:30Z',
        type: 'event_msg',
        payload: {
          type: 'patch_applied',
          file_path: '/home/user/project/src/index.ts',
          additions: 5,
          deletions: 2,
        },
      });

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('assistant');
      expect(events[0].message.model).toBe('o4-mini');
      const content = events[0].message.content as Array<{
        type: string; id: string; name: string; input: Record<string, unknown>;
      }>;
      expect(content[0].type).toBe('tool_use');
      expect(content[0].name).toBe('Edit');
      expect(content[0].input.file_path).toBe('/home/user/project/src/index.ts');
      expect(content[0].input.additions).toBe(5);
      expect(content[0].input.deletions).toBe(2);
    });

    it('should emit no events for patch_applied without file_path', () => {
      const events = parser.convertLine({
        timestamp: '2025-01-15T10:14:30Z',
        type: 'event_msg',
        payload: { type: 'patch_applied' },
      });
      expect(events).toHaveLength(0);
    });
  });

  // --- event_msg/token_count model_context_window ---

  describe('event_msg/token_count model_context_window', () => {
    it('should store model_context_window from token_count events', () => {
      expect(parser.getModelContextWindow()).toBeNull();

      parser.convertLine({
        timestamp: '2025-01-15T10:08:00Z',
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            model_context_window: 1_048_576,
            last_token_usage: {
              input_tokens: 1000,
              output_tokens: 200,
            },
          },
        },
      });

      expect(parser.getModelContextWindow()).toBe(1_048_576);
    });

    it('should not overwrite with missing model_context_window', () => {
      parser.convertLine({
        timestamp: '2025-01-15T10:08:00Z',
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            model_context_window: 200_000,
            last_token_usage: { input_tokens: 100, output_tokens: 50 },
          },
        },
      });

      parser.convertLine({
        timestamp: '2025-01-15T10:09:00Z',
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            last_token_usage: { input_tokens: 200, output_tokens: 100 },
          },
        },
      });

      // Should keep the previous value since new event didn't include it
      expect(parser.getModelContextWindow()).toBe(200_000);
    });
  });

  // --- Silent event types ---

  describe('silent event types', () => {
    it('should emit no events for turn_started', () => {
      const events = parser.convertLine({
        timestamp: '2025-01-15T10:15:00Z',
        type: 'event_msg',
        payload: { type: 'turn_started' },
      });
      expect(events).toHaveLength(0);
    });

    it('should emit no events for turn_complete', () => {
      const events = parser.convertLine({
        timestamp: '2025-01-15T10:15:00Z',
        type: 'event_msg',
        payload: { type: 'turn_complete' },
      });
      expect(events).toHaveLength(0);
    });

    it('should emit no events for agent_message', () => {
      const events = parser.convertLine({
        timestamp: '2025-01-15T10:15:00Z',
        type: 'event_msg',
        payload: { type: 'agent_message', message: 'hello' },
      });
      expect(events).toHaveLength(0);
    });

    it('should emit no events for user_message', () => {
      const events = parser.convertLine({
        timestamp: '2025-01-15T10:15:00Z',
        type: 'event_msg',
        payload: { type: 'user_message', message: 'hello' },
      });
      expect(events).toHaveLength(0);
    });

    it('should emit no events for background', () => {
      const events = parser.convertLine({
        timestamp: '2025-01-15T10:15:00Z',
        type: 'event_msg',
        payload: { type: 'background', message: 'indexing...' },
      });
      expect(events).toHaveLength(0);
    });
  });

  // --- response_item/custom_tool_call ---

  describe('response_item/custom_tool_call', () => {
    it('should convert apply_patch to Edit tool_use events with extracted file paths', () => {
      parser.convertLine({
        timestamp: '2025-01-15T10:00:00Z',
        type: 'turn_context',
        payload: { model: 'o4-mini' },
      });

      const events = parser.convertLine({
        timestamp: '2025-01-15T10:05:00Z',
        type: 'response_item',
        payload: {
          type: 'custom_tool_call',
          call_id: 'call_abc123',
          name: 'apply_patch',
          input: '*** Begin Patch\n*** Add File: src/math.ts\n+export function add(a: number, b: number) { return a + b; }\n',
          status: 'completed',
        },
      } as unknown as CodexRolloutLine);

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('assistant');
      expect(events[0].message.model).toBe('o4-mini');
      const content = events[0].message.content as Array<{ type: string; id: string; name: string; input: Record<string, unknown> }>;
      expect(content[0].type).toBe('tool_use');
      expect(content[0].name).toBe('Edit');
      expect(content[0].input.file_path).toBe('src/math.ts');
    });

    it('should produce one Edit per file for multi-file apply_patch', () => {
      const events = parser.convertLine({
        timestamp: '2025-01-15T10:05:00Z',
        type: 'response_item',
        payload: {
          type: 'custom_tool_call',
          call_id: 'call_multi',
          name: 'apply_patch',
          input: [
            '*** Begin Patch',
            '*** Update File: src/index.ts',
            '@@',
            '-old line',
            '+new line',
            '*** Add File: src/utils.ts',
            '+export const foo = 1;',
            '*** Delete File: src/old.ts',
          ].join('\n'),
          status: 'completed',
        },
      } as unknown as CodexRolloutLine);

      expect(events).toHaveLength(3);
      const names = events.map(e => {
        const c = e.message.content as Array<{ name: string; input: Record<string, unknown> }>;
        return { name: c[0].name, file: c[0].input.file_path };
      });
      expect(names).toEqual([
        { name: 'Edit', file: 'src/index.ts' },
        { name: 'Edit', file: 'src/utils.ts' },
        { name: 'Edit', file: 'src/old.ts' },
      ]);
    });

    it('should emit no events for apply_patch with no file paths', () => {
      const events = parser.convertLine({
        timestamp: '2025-01-15T10:05:00Z',
        type: 'response_item',
        payload: {
          type: 'custom_tool_call',
          call_id: 'call_empty',
          name: 'apply_patch',
          input: '*** Begin Patch\n',
          status: 'completed',
        },
      } as unknown as CodexRolloutLine);

      expect(events).toHaveLength(0);
    });

    it('should convert non-patch custom_tool_call to generic tool_use', () => {
      const events = parser.convertLine({
        timestamp: '2025-01-15T10:05:00Z',
        type: 'response_item',
        payload: {
          type: 'custom_tool_call',
          call_id: 'call_custom',
          name: 'web_search',
          input: '{"query":"vitest testing"}',
          status: 'completed',
        },
      } as unknown as CodexRolloutLine);

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('assistant');
      const content = events[0].message.content as Array<{ type: string; name: string; input: Record<string, unknown> }>;
      expect(content[0].type).toBe('tool_use');
      expect(content[0].name).toBe('WebSearch');
      expect(content[0].input).toEqual({ query: 'vitest testing', _sidekickRawToolName: 'web_search' });
    });

    it('should wrap non-JSON input as { raw: ... } for generic custom tool', () => {
      const events = parser.convertLine({
        timestamp: '2025-01-15T10:05:00Z',
        type: 'response_item',
        payload: {
          type: 'custom_tool_call',
          call_id: 'call_raw',
          name: 'some_tool',
          input: 'not json at all',
        },
      } as unknown as CodexRolloutLine);

      expect(events).toHaveLength(1);
      const content = events[0].message.content as Array<{ input: Record<string, unknown> }>;
      expect(content[0].input).toEqual({
        raw: 'not json at all',
        _sidekickRawToolName: 'some_tool',
      });
    });
  });

  // --- response_item/custom_tool_call_output ---

  describe('response_item/custom_tool_call_output', () => {
    it('should convert custom_tool_call_output to tool_result', () => {
      const events = parser.convertLine({
        timestamp: '2025-01-15T10:06:00Z',
        type: 'response_item',
        payload: {
          type: 'custom_tool_call_output',
          call_id: 'call_abc123',
          output: '{"output":"Success. Updated the following files:\\nA src/math.ts\\n","metadata":{"exit_code":0}}',
        },
      } as unknown as CodexRolloutLine);

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('user');
      const content = events[0].message.content as Array<{ type: string; tool_use_id: string; content: string; is_error: boolean }>;
      expect(content[0].type).toBe('tool_result');
      expect(content[0].tool_use_id).toBe('call_abc123');
      expect(content[0].is_error).toBe(false);
    });

    it('should mark is_error=true for non-zero exit code', () => {
      const events = parser.convertLine({
        timestamp: '2025-01-15T10:06:00Z',
        type: 'response_item',
        payload: {
          type: 'custom_tool_call_output',
          call_id: 'call_fail',
          output: '{"output":"Error applying patch","metadata":{"exit_code":1}}',
        },
      } as unknown as CodexRolloutLine);

      expect(events).toHaveLength(1);
      const content = events[0].message.content as Array<{ is_error: boolean }>;
      expect(content[0].is_error).toBe(true);
    });

    it('should extract duration from metadata.duration_seconds', () => {
      const events = parser.convertLine({
        timestamp: '2025-01-15T10:06:00Z',
        type: 'response_item',
        payload: {
          type: 'custom_tool_call_output',
          call_id: 'call_dur',
          output: '{"output":"ok","metadata":{"exit_code":0,"duration_seconds":1.234}}',
        },
      } as unknown as CodexRolloutLine);

      expect(events).toHaveLength(1);
      const content = events[0].message.content as Array<{ duration?: number }>;
      expect(content[0].duration).toBe(1234);
    });

    it('should handle non-JSON output gracefully', () => {
      const events = parser.convertLine({
        timestamp: '2025-01-15T10:06:00Z',
        type: 'response_item',
        payload: {
          type: 'custom_tool_call_output',
          call_id: 'call_plain',
          output: 'plain text output',
        },
      } as unknown as CodexRolloutLine);

      expect(events).toHaveLength(1);
      const content = events[0].message.content as Array<{ content: string; is_error: boolean }>;
      expect(content[0].content).toBe('plain text output');
      expect(content[0].is_error).toBe(false);
    });
  });

  // --- extractPatchFilePaths ---

  describe('extractPatchFilePaths', () => {
    it('should extract Add File paths', () => {
      expect(extractPatchFilePaths('*** Add File: src/new.ts\n+code')).toEqual(['src/new.ts']);
    });

    it('should extract Update File paths', () => {
      expect(extractPatchFilePaths('*** Update File: src/existing.ts\n@@\n-old\n+new')).toEqual(['src/existing.ts']);
    });

    it('should extract Delete File paths', () => {
      expect(extractPatchFilePaths('*** Delete File: src/old.ts')).toEqual(['src/old.ts']);
    });

    it('should extract multiple file paths', () => {
      const input = '*** Begin Patch\n*** Add File: a.ts\n+x\n*** Update File: b.ts\n@@\n-y\n+z\n*** Delete File: c.ts';
      expect(extractPatchFilePaths(input)).toEqual(['a.ts', 'b.ts', 'c.ts']);
    });

    it('should return empty array for no file paths', () => {
      expect(extractPatchFilePaths('*** Begin Patch\nno files here')).toEqual([]);
    });
  });

  // --- Unknown types ---

  describe('unknown types', () => {
    it('should handle unknown top-level type gracefully', () => {
      const line = {
        timestamp: '2025-01-15T10:16:00Z',
        type: 'unknown_type' as CodexRolloutLine['type'],
        payload: {},
      };

      const events = parser.convertLine(line);
      expect(events).toHaveLength(0);
    });

    it('should handle unknown event_msg type gracefully', () => {
      const events = parser.convertLine({
        timestamp: '2025-01-15T10:16:00Z',
        type: 'event_msg',
        payload: { type: 'future_event_type' },
      });
      expect(events).toHaveLength(0);
    });

    it('should handle unknown response_item type gracefully', () => {
      const line = {
        timestamp: '2025-01-15T10:16:00Z',
        type: 'response_item',
        payload: {
          type: 'web_search_call', id: 'ws-1',
        },
      } as unknown as CodexRolloutLine;

      const events = parser.convertLine(line);
      expect(events).toHaveLength(0);
    });
  });

  // --- reset ---

  describe('reset', () => {
    it('should clear all state', () => {
      // Add some state
      parser.convertLine({
        timestamp: '2025-01-15T10:00:00Z',
        type: 'session_meta',
        payload: { id: 'sess-1', cwd: '/tmp' },
      });
      parser.convertLine({
        timestamp: '2025-01-15T10:00:01Z',
        type: 'turn_context',
        payload: { model: 'gpt-4.1' },
      });
      parser.convertLine({
        timestamp: '2025-01-15T10:00:02Z',
        type: 'event_msg',
        payload: {
          type: 'exec_command_begin',
          call_id: 'exec-orphan',
          command: ['ls'],
        },
      });

      parser.convertLine({
        timestamp: '2025-01-15T10:00:03Z',
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            model_context_window: 200_000,
            last_token_usage: { input_tokens: 100, output_tokens: 50 },
          },
        },
      });

      expect(parser.getSessionMeta()).not.toBeNull();
      expect(parser.getCurrentModel()).toBe('gpt-4.1');
      expect(parser.getModelContextWindow()).toBe(200_000);

      parser.reset();

      expect(parser.getSessionMeta()).toBeNull();
      expect(parser.getCurrentModel()).toBeNull();
      expect(parser.getLastTokenUsage()).toBeNull();
      expect(parser.getModelContextWindow()).toBeNull();
    });
  });

  // --- event_msg/token_count rate_limits ---

  describe('event_msg/token_count rate_limits', () => {
    it('should store rate_limits from token_count events', () => {
      expect(parser.getLastRateLimits()).toBeNull();

      parser.convertLine({
        timestamp: '2025-01-15T10:08:00Z',
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            last_token_usage: { input_tokens: 1000, output_tokens: 200 },
          },
          rate_limits: {
            limit_id: 'codex',
            primary: { used_percent: 16.0, window_minutes: 300, resets_at: 1771331406 },
            secondary: { used_percent: 94.0, window_minutes: 10080, resets_at: 1771407310 },
          },
        },
      });

      const limits = parser.getLastRateLimits();
      expect(limits).not.toBeNull();
      expect(limits!.limit_id).toBe('codex');
      expect(limits!.primary!.used_percent).toBe(16.0);
      expect(limits!.secondary!.used_percent).toBe(94.0);
    });

    it('should persist rate_limits when subsequent token_count lacks them', () => {
      parser.convertLine({
        timestamp: '2025-01-15T10:08:00Z',
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            last_token_usage: { input_tokens: 1000, output_tokens: 200 },
          },
          rate_limits: {
            limit_id: 'codex',
            primary: { used_percent: 20.0, window_minutes: 300, resets_at: 1771331406 },
            secondary: { used_percent: 50.0, window_minutes: 10080, resets_at: 1771407310 },
          },
        },
      });

      // Second token_count without rate_limits
      parser.convertLine({
        timestamp: '2025-01-15T10:09:00Z',
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            last_token_usage: { input_tokens: 2000, output_tokens: 400 },
          },
        },
      });

      const limits = parser.getLastRateLimits();
      expect(limits).not.toBeNull();
      expect(limits!.primary!.used_percent).toBe(20.0);
    });

    it('should clear rate_limits on reset', () => {
      parser.convertLine({
        timestamp: '2025-01-15T10:08:00Z',
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            last_token_usage: { input_tokens: 1000, output_tokens: 200 },
          },
          rate_limits: {
            limit_id: 'codex',
            primary: { used_percent: 16.0, window_minutes: 300, resets_at: 1771331406 },
            secondary: { used_percent: 94.0, window_minutes: 10080, resets_at: 1771407310 },
          },
        },
      });

      expect(parser.getLastRateLimits()).not.toBeNull();
      parser.reset();
      expect(parser.getLastRateLimits()).toBeNull();
    });
  });

  // --- Tool name normalization ---

  describe('tool name normalization', () => {
    it('should normalize local_shell_call to Bash', () => {
      const events = parser.convertLine({
        timestamp: '2025-01-15T10:17:00Z',
        type: 'response_item',
        payload: {
          type: 'local_shell_call',
          call_id: 'shell-norm',
          action: { type: 'exec', command: ['echo', 'hi'] },
        },
      });

      const content = events[0].message.content as Array<{ name: string }>;
      expect(content[0].name).toBe('Bash');
    });

    it('should normalize known tool names to PascalCase', () => {
      const events = parser.convertLine({
        timestamp: '2025-01-15T10:17:00Z',
        type: 'response_item',
        payload: {
          type: 'function_call',
          call_id: 'fc-norm',
          name: 'bash',
          arguments: '{}',
        },
      });

      const content = events[0].message.content as Array<{ name: string }>;
      expect(content[0].name).toBe('Bash');
    });
  });

  // --- Model tracking across events ---

  describe('model tracking', () => {
    it('should use model from turn_context in subsequent events', () => {
      parser.convertLine({
        timestamp: '2025-01-15T10:00:00Z',
        type: 'turn_context',
        payload: { model: 'o4-mini' },
      });

      const events = parser.convertLine({
        timestamp: '2025-01-15T10:01:00Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: 'Response with o4-mini',
        },
      });

      expect(events[0].message.model).toBe('o4-mini');
    });

    it('should update model when turn_context changes', () => {
      parser.convertLine({
        timestamp: '2025-01-15T10:00:00Z',
        type: 'turn_context',
        payload: { model: 'gpt-4o' },
      });

      let events = parser.convertLine({
        timestamp: '2025-01-15T10:01:00Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: 'First response',
        },
      });
      expect(events[0].message.model).toBe('gpt-4o');

      parser.convertLine({
        timestamp: '2025-01-15T10:02:00Z',
        type: 'turn_context',
        payload: { model: 'o3' },
      });

      events = parser.convertLine({
        timestamp: '2025-01-15T10:03:00Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: 'Second response',
        },
      });
      expect(events[0].message.model).toBe('o3');
    });
  });
});
