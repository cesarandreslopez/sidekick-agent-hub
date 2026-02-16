import { describe, it, expect } from 'vitest';
import { convertOpenCodeMessage, parseDbMessageData, parseDbPartData, normalizeToolName, normalizeToolInput } from './OpenCodeMessageParser';
import type { OpenCodeMessage, OpenCodePart, DbMessage, DbPart } from '../../types/opencode';

describe('OpenCodeMessageParser', () => {
  describe('convertOpenCodeMessage', () => {
    it('should convert a user text message', () => {
      const message: OpenCodeMessage = {
        id: 'msg-1',
        sessionID: 'sess-1',
        role: 'user',
        tokens: { input: 0, output: 0 },
        time: { created: '2025-01-15T10:00:00Z' }
      };
      const parts: OpenCodePart[] = [
        { id: 'part-1', messageID: 'msg-1', type: 'text', text: 'Hello, please help me.' }
      ];

      const events = convertOpenCodeMessage(message, parts);

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('user');
      expect(events[0].message.role).toBe('user');
      expect(events[0].message.content).toEqual([
        { type: 'text', text: 'Hello, please help me.' }
      ]);
      expect(events[0].timestamp).toBe('2025-01-15T10:00:00Z');
    });

    it('should convert an assistant text response with usage', () => {
      const message: OpenCodeMessage = {
        id: 'msg-2',
        sessionID: 'sess-1',
        role: 'assistant',
        modelID: 'claude-sonnet-4-20250514',
        tokens: { input: 1000, output: 500, cacheRead: 200, cacheWrite: 100 },
        time: { created: '2025-01-15T10:00:01Z', completed: '2025-01-15T10:00:05Z' }
      };
      const parts: OpenCodePart[] = [
        { id: 'part-1', messageID: 'msg-2', type: 'text', text: 'Sure, I can help!' }
      ];

      const events = convertOpenCodeMessage(message, parts);

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('assistant');
      expect(events[0].message.role).toBe('assistant');
      expect(events[0].message.model).toBe('claude-sonnet-4-20250514');
      expect(events[0].message.usage).toEqual({
        input_tokens: 1000,
        output_tokens: 500,
        cache_creation_input_tokens: 100,
        cache_read_input_tokens: 200,
        reasoning_tokens: 0,
      });
      expect(events[0].message.content).toEqual([
        { type: 'text', text: 'Sure, I can help!' }
      ]);
      expect(events[0].timestamp).toBe('2025-01-15T10:00:05Z');
    });

    it('should include reasoning tokens in usage when present', () => {
      const message: OpenCodeMessage = {
        id: 'msg-reason',
        sessionID: 'sess-1',
        role: 'assistant',
        modelID: 'claude-sonnet-4-20250514',
        tokens: { input: 1000, output: 500, cacheRead: 200, cacheWrite: 100, reasoning: 300 },
        time: { created: '2025-01-15T10:00:01Z', completed: '2025-01-15T10:00:05Z' }
      };
      const parts: OpenCodePart[] = [
        { id: 'part-1', messageID: 'msg-reason', type: 'text', text: 'Answer with reasoning' }
      ];

      const events = convertOpenCodeMessage(message, parts);

      expect(events[0].message.usage).toEqual({
        input_tokens: 1000,
        output_tokens: 500,
        cache_creation_input_tokens: 100,
        cache_read_input_tokens: 200,
        reasoning_tokens: 300,
      });
    });

    it('should convert thinking/reasoning parts', () => {
      const message: OpenCodeMessage = {
        id: 'msg-3',
        sessionID: 'sess-1',
        role: 'assistant',
        tokens: { input: 500, output: 200 },
        time: { created: '2025-01-15T10:00:01Z' }
      };
      const parts: OpenCodePart[] = [
        { id: 'part-1', messageID: 'msg-3', type: 'reasoning', text: 'Let me think about this...' },
        { id: 'part-2', messageID: 'msg-3', type: 'text', text: 'Here is my answer.' }
      ];

      const events = convertOpenCodeMessage(message, parts);

      expect(events).toHaveLength(1);
      const content = events[0].message.content as unknown[];
      expect(content).toHaveLength(2);
      expect(content[0]).toEqual({ type: 'thinking', thinking: 'Let me think about this...' });
      expect(content[1]).toEqual({ type: 'text', text: 'Here is my answer.' });
    });

    it('should convert tool invocations to tool_use blocks', () => {
      const message: OpenCodeMessage = {
        id: 'msg-4',
        sessionID: 'sess-1',
        role: 'assistant',
        tokens: { input: 500, output: 300 },
        time: { created: '2025-01-15T10:00:01Z', completed: '2025-01-15T10:00:03Z' }
      };
      const parts: OpenCodePart[] = [
        {
          id: 'part-1',
          messageID: 'msg-4',
          type: 'tool-invocation',
          callID: 'call-123',
          tool: 'Read',
          state: {
            status: 'completed',
            input: { file_path: '/tmp/test.ts' },
            output: 'file contents here',
            time: { start: '2025-01-15T10:00:01Z', end: '2025-01-15T10:00:02Z' }
          }
        }
      ];

      const events = convertOpenCodeMessage(message, parts);

      // Should produce: assistant event + tool_result event
      expect(events).toHaveLength(2);

      // Assistant event with tool_use block
      const assistantEvent = events[0];
      expect(assistantEvent.type).toBe('assistant');
      const content = assistantEvent.message.content as unknown[];
      expect(content).toHaveLength(1);
      expect(content[0]).toEqual({
        type: 'tool_use',
        id: 'call-123',
        name: 'Read',
        input: { file_path: '/tmp/test.ts' }
      });

      // Synthetic tool_result event
      const resultEvent = events[1];
      expect(resultEvent.type).toBe('user');
      const resultContent = resultEvent.message.content as unknown[];
      expect(resultContent).toHaveLength(1);
      expect(resultContent[0]).toEqual({
        type: 'tool_result',
        tool_use_id: 'call-123',
        content: 'file contents here',
        is_error: false,
        duration: 1000
      });
    });

    it('should handle tool errors', () => {
      const message: OpenCodeMessage = {
        id: 'msg-5',
        sessionID: 'sess-1',
        role: 'assistant',
        tokens: { input: 500, output: 300 },
        time: { created: '2025-01-15T10:00:01Z' }
      };
      const parts: OpenCodePart[] = [
        {
          id: 'part-1',
          messageID: 'msg-5',
          type: 'tool-invocation',
          callID: 'call-456',
          tool: 'Bash',
          state: {
            status: 'error',
            input: { command: 'cat /nonexistent' },
            error: 'No such file or directory'
          }
        }
      ];

      const events = convertOpenCodeMessage(message, parts);

      expect(events).toHaveLength(2);

      const resultEvent = events[1];
      const resultContent = resultEvent.message.content as unknown[];
      expect(resultContent[0]).toEqual({
        type: 'tool_result',
        tool_use_id: 'call-456',
        content: 'No such file or directory',
        is_error: true
      });
    });

    it('should detect compaction from summary flag', () => {
      const message: OpenCodeMessage = {
        id: 'msg-6',
        sessionID: 'sess-1',
        role: 'assistant',
        summary: true,
        tokens: { input: 100, output: 50 },
        time: { created: '2025-01-15T10:00:01Z' }
      };
      const parts: OpenCodePart[] = [
        { id: 'part-1', messageID: 'msg-6', type: 'text', text: 'Summary of conversation...' }
      ];

      const events = convertOpenCodeMessage(message, parts);

      // Should produce: assistant event + summary event
      const summaryEvent = events.find(e => e.type === 'summary');
      expect(summaryEvent).toBeDefined();
      expect(summaryEvent!.message.content).toBe('Context compacted');
    });

    it('should detect compaction from compaction part', () => {
      const message: OpenCodeMessage = {
        id: 'msg-7',
        sessionID: 'sess-1',
        role: 'assistant',
        tokens: { input: 100, output: 50 },
        time: { created: '2025-01-15T10:00:01Z' }
      };
      const parts: OpenCodePart[] = [
        { id: 'part-1', messageID: 'msg-7', type: 'compaction', text: 'Context was compacted' }
      ];

      const events = convertOpenCodeMessage(message, parts);

      const summaryEvent = events.find(e => e.type === 'summary');
      expect(summaryEvent).toBeDefined();
    });

    it('should sort parts by index', () => {
      const message: OpenCodeMessage = {
        id: 'msg-8',
        sessionID: 'sess-1',
        role: 'assistant',
        tokens: { input: 500, output: 200 },
        time: { created: '2025-01-15T10:00:01Z' }
      };
      const parts: OpenCodePart[] = [
        { id: 'part-2', messageID: 'msg-8', index: 1, type: 'text', text: 'Second' },
        { id: 'part-1', messageID: 'msg-8', index: 0, type: 'text', text: 'First' }
      ];

      const events = convertOpenCodeMessage(message, parts);

      const content = events[0].message.content as { type: string; text: string }[];
      expect(content[0].text).toBe('First');
      expect(content[1].text).toBe('Second');
    });

    it('should handle empty parts array', () => {
      const message: OpenCodeMessage = {
        id: 'msg-9',
        sessionID: 'sess-1',
        role: 'user',
        tokens: { input: 0, output: 0 },
        time: { created: '2025-01-15T10:00:00Z' }
      };

      const events = convertOpenCodeMessage(message, []);
      expect(events).toHaveLength(0);
    });

    it('should skip pending/running tool invocations for results', () => {
      const message: OpenCodeMessage = {
        id: 'msg-10',
        sessionID: 'sess-1',
        role: 'assistant',
        tokens: { input: 500, output: 300 },
        time: { created: '2025-01-15T10:00:01Z' }
      };
      const parts: OpenCodePart[] = [
        {
          id: 'part-1',
          messageID: 'msg-10',
          type: 'tool-invocation',
          callID: 'call-789',
          tool: 'Write',
          state: {
            status: 'running',
            input: { file_path: '/tmp/out.ts', content: 'hello' }
          }
        }
      ];

      const events = convertOpenCodeMessage(message, parts);

      // Should only produce assistant event (no tool_result for running tool)
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('assistant');
    });

    it('should handle numeric timestamps', () => {
      const message: OpenCodeMessage = {
        id: 'msg-11',
        sessionID: 'sess-1',
        role: 'user',
        tokens: { input: 0, output: 0 },
        time: { created: 1705312800000 }
      };
      const parts: OpenCodePart[] = [
        { id: 'part-1', messageID: 'msg-11', type: 'text', text: 'Test' }
      ];

      const events = convertOpenCodeMessage(message, parts);

      expect(events).toHaveLength(1);
      // Should be a valid ISO string
      expect(() => new Date(events[0].timestamp)).not.toThrow();
      expect(new Date(events[0].timestamp).getTime()).toBe(1705312800000);
    });

    it('should convert DB tool parts (type "tool")', () => {
      const message: OpenCodeMessage = {
        id: 'msg-db-1',
        sessionID: 'sess-1',
        role: 'assistant',
        tokens: { input: 500, output: 300 },
        time: { created: 1705312800000, completed: 1705312803000 }
      };
      const parts: OpenCodePart[] = [
        {
          id: 'part-1',
          messageID: 'msg-db-1',
          type: 'tool',
          callID: 'call_abc',
          tool: 'glob',
          state: {
            status: 'completed',
            input: { path: '/src', pattern: '*.ts' },
            output: 'file1.ts\nfile2.ts',
            time: { start: 1705312801000, end: 1705312802000 }
          }
        }
      ];

      const events = convertOpenCodeMessage(message, parts);

      // Should produce assistant event + tool_result
      expect(events).toHaveLength(2);
      expect(events[0].type).toBe('assistant');
      const content = events[0].message.content as unknown[];
      expect(content[0]).toEqual({
        type: 'tool_use',
        id: 'call_abc',
        name: 'Glob',
        input: { path: '/src', pattern: '*.ts' }
      });

      const resultEvent = events[1];
      expect(resultEvent.type).toBe('user');
      const resultContent = resultEvent.message.content as unknown[];
      expect(resultContent[0]).toEqual({
        type: 'tool_result',
        tool_use_id: 'call_abc',
        content: 'file1.ts\nfile2.ts',
        is_error: false,
        duration: 1000
      });
    });

    it('should skip step-start and step-finish parts', () => {
      const message: OpenCodeMessage = {
        id: 'msg-step',
        sessionID: 'sess-1',
        role: 'assistant',
        tokens: { input: 100, output: 50 },
        time: { created: 1705312800000 }
      };
      const parts: OpenCodePart[] = [
        { id: 'part-1', messageID: 'msg-step', type: 'step-start', snapshot: 'abc123' },
        { id: 'part-2', messageID: 'msg-step', type: 'text', text: 'Hello' },
        { id: 'part-3', messageID: 'msg-step', type: 'step-finish', reason: 'tool-calls', snapshot: 'abc123' }
      ];

      const events = convertOpenCodeMessage(message, parts);

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('assistant');
      const content = events[0].message.content as unknown[];
      // Only the text part should be in content
      expect(content).toHaveLength(1);
      expect(content[0]).toEqual({ type: 'text', text: 'Hello' });
    });

    it('should convert patch parts to tool_use blocks', () => {
      const message: OpenCodeMessage = {
        id: 'msg-patch',
        sessionID: 'sess-1',
        role: 'assistant',
        tokens: { input: 500, output: 200 },
        time: { created: 1705312800000 }
      };
      const parts: OpenCodePart[] = [
        {
          id: 'part-1',
          messageID: 'msg-patch',
          type: 'patch',
          hash: 'abc123def',
          files: ['/src/foo.ts', '/src/bar.ts']
        }
      ];

      const events = convertOpenCodeMessage(message, parts);

      expect(events).toHaveLength(1);
      const content = events[0].message.content as unknown[];
      expect(content[0]).toEqual({
        type: 'tool_use',
        id: 'patch-part-1',
        name: 'Patch',
        input: { hash: 'abc123def', files: ['/src/foo.ts', '/src/bar.ts'] }
      });
    });
  });

  describe('parseDbMessageData', () => {
    it('should parse a DB message row into OpenCodeMessage', () => {
      const row: DbMessage = {
        id: 'msg_abc123',
        session_id: 'ses_xyz',
        time_created: 1705312800000,
        time_updated: 1705312810000,
        data: JSON.stringify({
          role: 'assistant',
          time: { created: 1705312800000, completed: 1705312805000 },
          modelID: 'claude-sonnet-4-20250514',
          tokens: { input: 1000, output: 500, reasoning: 64, cache: { read: 200, write: 100 } }
        })
      };

      const msg = parseDbMessageData(row);

      expect(msg.id).toBe('msg_abc123');
      expect(msg.sessionID).toBe('ses_xyz');
      expect(msg.role).toBe('assistant');
      expect(msg.modelID).toBe('claude-sonnet-4-20250514');
      expect(msg.tokens.input).toBe(1000);
      expect(msg.tokens.output).toBe(500);
      expect(msg.tokens.cacheRead).toBe(200);
      expect(msg.tokens.cacheWrite).toBe(100);
      expect(msg.tokens.reasoning).toBe(64);
      expect(msg.time.created).toBe(1705312800000);
      expect(msg.time.completed).toBe(1705312805000);
    });

    it('should handle user message with summary', () => {
      const row: DbMessage = {
        id: 'msg_user',
        session_id: 'ses_xyz',
        time_created: 1705312800000,
        time_updated: 1705312800000,
        data: JSON.stringify({
          role: 'user',
          time: { created: 1705312800000 },
          summary: { title: 'Some summary' },
          tokens: {}
        })
      };

      const msg = parseDbMessageData(row);
      expect(msg.role).toBe('user');
      expect(msg.summary).toBe(true);
    });
  });

  describe('parseDbPartData', () => {
    it('should parse a text part', () => {
      const row: DbPart = {
        id: 'prt_1',
        message_id: 'msg_1',
        session_id: 'ses_1',
        time_created: 1705312800000,
        time_updated: 1705312800000,
        data: JSON.stringify({ type: 'text', text: 'Hello world' })
      };

      const part = parseDbPartData(row);
      expect(part.type).toBe('text');
      if (part.type === 'text') {
        expect(part.text).toBe('Hello world');
      }
    });

    it('should parse a tool part', () => {
      const row: DbPart = {
        id: 'prt_2',
        message_id: 'msg_1',
        session_id: 'ses_1',
        time_created: 1705312800000,
        time_updated: 1705312800000,
        data: JSON.stringify({
          type: 'tool',
          callID: 'call_xyz',
          tool: 'bash',
          state: {
            status: 'completed',
            input: { command: 'ls' },
            output: 'file1\nfile2'
          }
        })
      };

      const part = parseDbPartData(row);
      expect(part.type).toBe('tool');
      if (part.type === 'tool') {
        expect(part.callID).toBe('call_xyz');
        expect(part.tool).toBe('bash');
        expect(part.state.status).toBe('completed');
        expect(part.state.output).toBe('file1\nfile2');
      }
    });

    it('should parse step-start and step-finish parts', () => {
      const startRow: DbPart = {
        id: 'prt_3',
        message_id: 'msg_1',
        session_id: 'ses_1',
        time_created: 1705312800000,
        time_updated: 1705312800000,
        data: JSON.stringify({ type: 'step-start', snapshot: 'abc123' })
      };

      const startPart = parseDbPartData(startRow);
      expect(startPart.type).toBe('step-start');
      if (startPart.type === 'step-start') {
        expect(startPart.snapshot).toBe('abc123');
      }

      const finishRow: DbPart = {
        id: 'prt_4',
        message_id: 'msg_1',
        session_id: 'ses_1',
        time_created: 1705312800000,
        time_updated: 1705312800000,
        data: JSON.stringify({ type: 'step-finish', reason: 'tool-calls', snapshot: 'abc123', cost: 0 })
      };

      const finishPart = parseDbPartData(finishRow);
      expect(finishPart.type).toBe('step-finish');
      if (finishPart.type === 'step-finish') {
        expect(finishPart.reason).toBe('tool-calls');
      }
    });

    it('should parse a patch part', () => {
      const row: DbPart = {
        id: 'prt_5',
        message_id: 'msg_1',
        session_id: 'ses_1',
        time_created: 1705312800000,
        time_updated: 1705312800000,
        data: JSON.stringify({ type: 'patch', hash: 'def456', files: ['/src/a.ts'] })
      };

      const part = parseDbPartData(row);
      expect(part.type).toBe('patch');
      if (part.type === 'patch') {
        expect(part.hash).toBe('def456');
        expect(part.files).toEqual(['/src/a.ts']);
      }
    });

    it('should handle unknown part types as text', () => {
      const row: DbPart = {
        id: 'prt_6',
        message_id: 'msg_1',
        session_id: 'ses_1',
        time_created: 1705312800000,
        time_updated: 1705312800000,
        data: JSON.stringify({ type: 'future-type', someField: 'value' })
      };

      const part = parseDbPartData(row);
      expect(part.type).toBe('text');
      if (part.type === 'text') {
        expect(part.text).toContain('future-type');
      }
    });

    it('should parse a subtask part', () => {
      const row: DbPart = {
        id: 'prt_sub',
        message_id: 'msg_1',
        session_id: 'ses_1',
        time_created: 1705312800000,
        time_updated: 1705312800000,
        data: JSON.stringify({
          type: 'subtask',
          prompt: 'Find all TypeScript files',
          description: 'Search for TS files',
          agent: 'Explore',
          model: 'claude-sonnet-4-20250514',
          command: 'explore'
        })
      };

      const part = parseDbPartData(row);
      expect(part.type).toBe('subtask');
      if (part.type === 'subtask') {
        expect(part.prompt).toBe('Find all TypeScript files');
        expect(part.description).toBe('Search for TS files');
        expect(part.agent).toBe('Explore');
        expect(part.model).toBe('claude-sonnet-4-20250514');
        expect(part.command).toBe('explore');
      }
    });

    it('should parse an agent part', () => {
      const row: DbPart = {
        id: 'prt_agent',
        message_id: 'msg_1',
        session_id: 'ses_1',
        time_created: 1705312800000,
        time_updated: 1705312800000,
        data: JSON.stringify({ type: 'agent', name: 'code-reviewer', source: 'builtin' })
      };

      const part = parseDbPartData(row);
      expect(part.type).toBe('agent');
      if (part.type === 'agent') {
        expect(part.name).toBe('code-reviewer');
        expect(part.source).toBe('builtin');
      }
    });

    it('should parse a file part', () => {
      const row: DbPart = {
        id: 'prt_file',
        message_id: 'msg_1',
        session_id: 'ses_1',
        time_created: 1705312800000,
        time_updated: 1705312800000,
        data: JSON.stringify({ type: 'file', mime: 'image/png', filename: 'screenshot.png', url: 'file:///tmp/screenshot.png' })
      };

      const part = parseDbPartData(row);
      expect(part.type).toBe('file');
      if (part.type === 'file') {
        expect(part.mime).toBe('image/png');
        expect(part.filename).toBe('screenshot.png');
        expect(part.url).toBe('file:///tmp/screenshot.png');
      }
    });

    it('should parse a retry part', () => {
      const row: DbPart = {
        id: 'prt_retry',
        message_id: 'msg_1',
        session_id: 'ses_1',
        time_created: 1705312800000,
        time_updated: 1705312800000,
        data: JSON.stringify({
          type: 'retry',
          attempt: 2,
          error: { message: 'Rate limited', code: '429' },
          time: 1705312805000
        })
      };

      const part = parseDbPartData(row);
      expect(part.type).toBe('retry');
      if (part.type === 'retry') {
        expect(part.attempt).toBe(2);
        expect(part.error?.message).toBe('Rate limited');
        expect(part.error?.code).toBe('429');
        expect(part.time).toBe(1705312805000);
      }
    });

    it('should parse a snapshot part', () => {
      const row: DbPart = {
        id: 'prt_snap',
        message_id: 'msg_1',
        session_id: 'ses_1',
        time_created: 1705312800000,
        time_updated: 1705312800000,
        data: JSON.stringify({ type: 'snapshot', snapshot: 'abc123def456' })
      };

      const part = parseDbPartData(row);
      expect(part.type).toBe('snapshot');
      if (part.type === 'snapshot') {
        expect(part.snapshot).toBe('abc123def456');
      }
    });

    it('should parse step-finish with tokens', () => {
      const row: DbPart = {
        id: 'prt_sf',
        message_id: 'msg_1',
        session_id: 'ses_1',
        time_created: 1705312800000,
        time_updated: 1705312800000,
        data: JSON.stringify({
          type: 'step-finish',
          reason: 'end-turn',
          cost: 0.005,
          tokens: { input: 1000, output: 500, reasoning: 200, cache: { read: 300, write: 100 } }
        })
      };

      const part = parseDbPartData(row);
      expect(part.type).toBe('step-finish');
      if (part.type === 'step-finish') {
        expect(part.reason).toBe('end-turn');
        expect(part.cost).toBe(0.005);
        expect(part.tokens?.input).toBe(1000);
        expect(part.tokens?.output).toBe(500);
        expect(part.tokens?.reasoning).toBe(200);
        expect(part.tokens?.cache?.read).toBe(300);
        expect(part.tokens?.cache?.write).toBe(100);
      }
    });
  });

  describe('convertOpenCodeMessage with new part types', () => {
    it('should convert subtask part to tool_use + tool_result in assistant message', () => {
      const message: OpenCodeMessage = {
        id: 'msg-sub',
        sessionID: 'sess-1',
        role: 'assistant',
        tokens: { input: 500, output: 300 },
        time: { created: '2025-01-15T10:00:01Z' }
      };
      const parts: OpenCodePart[] = [
        {
          id: 'part-sub-1',
          messageID: 'msg-sub',
          type: 'subtask',
          description: 'Explore codebase',
          agent: 'Explore',
          model: 'claude-sonnet-4-20250514',
          prompt: 'Find all API endpoints',
        }
      ];

      const events = convertOpenCodeMessage(message, parts);

      // Should have assistant event + synthetic tool_result
      expect(events).toHaveLength(2);

      const assistantEvent = events[0];
      expect(assistantEvent.type).toBe('assistant');
      const content = assistantEvent.message.content as unknown[];
      expect(content[0]).toEqual({
        type: 'tool_use',
        id: 'subtask-part-sub-1',
        name: 'Subtask',
        input: {
          description: 'Explore codebase',
          agent: 'Explore',
          model: 'claude-sonnet-4-20250514',
          prompt: 'Find all API endpoints',
          command: undefined,
        }
      });

      const resultEvent = events[1];
      expect(resultEvent.type).toBe('user');
      const resultContent = resultEvent.message.content as unknown[];
      expect(resultContent[0]).toEqual({
        type: 'tool_result',
        tool_use_id: 'subtask-part-sub-1',
        content: 'Explore codebase',
        is_error: false
      });
    });

    it('should convert file part to text block in assistant message', () => {
      const message: OpenCodeMessage = {
        id: 'msg-file',
        sessionID: 'sess-1',
        role: 'assistant',
        tokens: { input: 100, output: 50 },
        time: { created: '2025-01-15T10:00:01Z' }
      };
      const parts: OpenCodePart[] = [
        { id: 'part-f1', messageID: 'msg-file', type: 'file', mime: 'text/plain', filename: 'output.log' }
      ];

      const events = convertOpenCodeMessage(message, parts);

      expect(events).toHaveLength(1);
      const content = events[0].message.content as { type: string; text: string }[];
      expect(content[0]).toEqual({ type: 'text', text: '[File: output.log (text/plain)]' });
    });

    it('should convert retry part to text block in assistant message', () => {
      const message: OpenCodeMessage = {
        id: 'msg-retry',
        sessionID: 'sess-1',
        role: 'assistant',
        tokens: { input: 100, output: 50 },
        time: { created: '2025-01-15T10:00:01Z' }
      };
      const parts: OpenCodePart[] = [
        { id: 'part-r1', messageID: 'msg-retry', type: 'retry', attempt: 3, error: { message: 'Timeout' } }
      ];

      const events = convertOpenCodeMessage(message, parts);

      expect(events).toHaveLength(1);
      const content = events[0].message.content as { type: string; text: string }[];
      expect(content[0]).toEqual({ type: 'text', text: '[Retry attempt 3: Timeout]' });
    });

    it('should skip agent and snapshot parts in assistant message', () => {
      const message: OpenCodeMessage = {
        id: 'msg-meta',
        sessionID: 'sess-1',
        role: 'assistant',
        tokens: { input: 100, output: 50 },
        time: { created: '2025-01-15T10:00:01Z' }
      };
      const parts: OpenCodePart[] = [
        { id: 'part-a1', messageID: 'msg-meta', type: 'agent', name: 'reviewer', source: 'plugin' },
        { id: 'part-s1', messageID: 'msg-meta', type: 'snapshot', snapshot: 'snap123' },
        { id: 'part-t1', messageID: 'msg-meta', type: 'text', text: 'Hello' }
      ];

      const events = convertOpenCodeMessage(message, parts);

      expect(events).toHaveLength(1);
      const content = events[0].message.content as unknown[];
      // Only the text part should appear
      expect(content).toHaveLength(1);
      expect(content[0]).toEqual({ type: 'text', text: 'Hello' });
    });

    it('should convert file and subtask parts in user message', () => {
      const message: OpenCodeMessage = {
        id: 'msg-user-new',
        sessionID: 'sess-1',
        role: 'user',
        tokens: { input: 0, output: 0 },
        time: { created: '2025-01-15T10:00:00Z' }
      };
      const parts: OpenCodePart[] = [
        { id: 'part-1', messageID: 'msg-user-new', type: 'text', text: 'Check this file' },
        { id: 'part-2', messageID: 'msg-user-new', type: 'file', mime: 'image/png', filename: 'screen.png' },
        { id: 'part-3', messageID: 'msg-user-new', type: 'subtask', description: 'Run analysis' }
      ];

      const events = convertOpenCodeMessage(message, parts);

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('user');
      const content = events[0].message.content as { type: string; text: string }[];
      expect(content).toHaveLength(3);
      expect(content[0]).toEqual({ type: 'text', text: 'Check this file' });
      expect(content[1]).toEqual({ type: 'text', text: '[File: screen.png (image/png)]' });
      expect(content[2]).toEqual({ type: 'text', text: '[Subtask: Run analysis]' });
    });
  });

  describe('normalizeToolName', () => {
    it('should map known lowercase tool names to PascalCase', () => {
      expect(normalizeToolName('read')).toBe('Read');
      expect(normalizeToolName('write')).toBe('Write');
      expect(normalizeToolName('edit')).toBe('Edit');
      expect(normalizeToolName('multiedit')).toBe('MultiEdit');
      expect(normalizeToolName('bash')).toBe('Bash');
      expect(normalizeToolName('glob')).toBe('Glob');
      expect(normalizeToolName('grep')).toBe('Grep');
      expect(normalizeToolName('webfetch')).toBe('WebFetch');
      expect(normalizeToolName('websearch')).toBe('WebSearch');
      expect(normalizeToolName('task')).toBe('Task');
      expect(normalizeToolName('todowrite')).toBe('TodoWrite');
      expect(normalizeToolName('todoread')).toBe('TodoRead');
      expect(normalizeToolName('apply_patch')).toBe('ApplyPatch');
      expect(normalizeToolName('question')).toBe('AskUserQuestion');
      expect(normalizeToolName('skill')).toBe('Skill');
      expect(normalizeToolName('plan_enter')).toBe('EnterPlanMode');
      expect(normalizeToolName('plan_exit')).toBe('ExitPlanMode');
    });

    it('should pass through already-PascalCase names', () => {
      expect(normalizeToolName('Read')).toBe('Read');
      expect(normalizeToolName('Bash')).toBe('Bash');
      expect(normalizeToolName('WebFetch')).toBe('WebFetch');
    });

    it('should capitalize first letter for unknown lowercase names', () => {
      expect(normalizeToolName('codesearch')).toBe('Codesearch');
      expect(normalizeToolName('myCustomTool')).toBe('MyCustomTool');
    });

    it('should handle empty string', () => {
      expect(normalizeToolName('')).toBe('');
    });
  });

  describe('normalizeToolInput', () => {
    it('should alias filePath to file_path', () => {
      const input = { filePath: '/tmp/test.ts' };
      const result = normalizeToolInput(input);
      expect(result.file_path).toBe('/tmp/test.ts');
      expect(result.filePath).toBe('/tmp/test.ts');
    });

    it('should not overwrite existing file_path', () => {
      const input = { filePath: '/tmp/camel.ts', file_path: '/tmp/snake.ts' };
      const result = normalizeToolInput(input);
      expect(result.file_path).toBe('/tmp/snake.ts');
    });

    it('should pass through inputs without filePath unchanged', () => {
      const input = { command: 'ls', pattern: '*.ts' };
      const result = normalizeToolInput(input);
      expect(result).toEqual({ command: 'ls', pattern: '*.ts' });
    });
  });

  describe('convertOpenCodeMessage with tool name normalization', () => {
    it('should normalize lowercase tool names to PascalCase in tool_use blocks', () => {
      const message: OpenCodeMessage = {
        id: 'msg-norm',
        sessionID: 'sess-1',
        role: 'assistant',
        tokens: { input: 500, output: 300 },
        time: { created: 1705312800000, completed: 1705312803000 }
      };
      const parts: OpenCodePart[] = [
        {
          id: 'part-1',
          messageID: 'msg-norm',
          type: 'tool',
          callID: 'call_norm',
          tool: 'glob',
          state: {
            status: 'completed',
            input: { path: '/src', pattern: '*.ts' },
            output: 'file1.ts\nfile2.ts',
            time: { start: 1705312801000, end: 1705312802000 }
          }
        }
      ];

      const events = convertOpenCodeMessage(message, parts);

      const content = events[0].message.content as Array<{ type: string; name: string }>;
      expect(content[0].name).toBe('Glob');
    });

    it('should normalize tool-invocation names and add file_path alias', () => {
      const message: OpenCodeMessage = {
        id: 'msg-norm2',
        sessionID: 'sess-1',
        role: 'assistant',
        tokens: { input: 500, output: 300 },
        time: { created: '2025-01-15T10:00:01Z' }
      };
      const parts: OpenCodePart[] = [
        {
          id: 'part-1',
          messageID: 'msg-norm2',
          type: 'tool-invocation',
          callID: 'call_read',
          tool: 'read',
          state: {
            status: 'completed',
            input: { filePath: '/tmp/test.ts' },
            output: 'contents',
            time: { start: '2025-01-15T10:00:01Z', end: '2025-01-15T10:00:02Z' }
          }
        }
      ];

      const events = convertOpenCodeMessage(message, parts);

      const content = events[0].message.content as Array<{ type: string; name: string; input: Record<string, unknown> }>;
      expect(content[0].name).toBe('Read');
      expect(content[0].input.file_path).toBe('/tmp/test.ts');
      expect(content[0].input.filePath).toBe('/tmp/test.ts');
    });
  });
});
