import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import { parseTranscript } from './transcriptParser';

vi.mock('fs');
const mockedFs = vi.mocked(fs);

describe('parseTranscript', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns empty array for non-existent file', () => {
    mockedFs.readFileSync.mockImplementation(() => { throw new Error('ENOENT'); });
    expect(parseTranscript('/nonexistent.jsonl')).toEqual([]);
  });

  it('returns empty array for empty file', () => {
    mockedFs.readFileSync.mockReturnValue('');
    expect(parseTranscript('/empty.jsonl')).toEqual([]);
  });

  it('parses a user text message', () => {
    const line = JSON.stringify({
      type: 'user',
      timestamp: '2025-01-15T10:00:00Z',
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'Hello, help me with code' }],
      },
    });
    mockedFs.readFileSync.mockReturnValue(line + '\n');

    const result = parseTranscript('/test.jsonl');
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('user');
    expect(result[0].timestamp).toBe('2025-01-15T10:00:00Z');
    expect(result[0].content).toHaveLength(1);
    expect(result[0].content[0].type).toBe('text');
    expect(result[0].content[0].text).toBe('Hello, help me with code');
  });

  it('parses assistant message with text and usage', () => {
    const line = JSON.stringify({
      type: 'assistant',
      timestamp: '2025-01-15T10:00:01Z',
      message: {
        role: 'assistant',
        model: 'claude-sonnet-4-20250514',
        usage: { input_tokens: 500, output_tokens: 200, cache_read_input_tokens: 100 },
        content: [{ type: 'text', text: 'Here is the solution.' }],
      },
    });
    mockedFs.readFileSync.mockReturnValue(line + '\n');

    const result = parseTranscript('/test.jsonl');
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('assistant');
    expect(result[0].model).toBe('claude-sonnet-4-20250514');
    expect(result[0].usage).toEqual({
      input_tokens: 500,
      output_tokens: 200,
      cache_creation_input_tokens: undefined,
      cache_read_input_tokens: 100,
    });
    expect(result[0].content[0].text).toBe('Here is the solution.');
  });

  it('extracts tool_use blocks with full input', () => {
    const line = JSON.stringify({
      type: 'assistant',
      timestamp: '2025-01-15T10:00:02Z',
      message: {
        role: 'assistant',
        content: [{
          type: 'tool_use',
          id: 'toolu_123',
          name: 'Read',
          input: { file_path: '/src/main.ts', offset: 1, limit: 50 },
        }],
      },
    });
    mockedFs.readFileSync.mockReturnValue(line + '\n');

    const result = parseTranscript('/test.jsonl');
    expect(result).toHaveLength(1);
    expect(result[0].content).toHaveLength(1);
    const block = result[0].content[0];
    expect(block.type).toBe('tool_use');
    expect(block.toolName).toBe('Read');
    expect(block.toolUseId).toBe('toolu_123');
    expect(block.toolInput).toEqual({ file_path: '/src/main.ts', offset: 1, limit: 50 });
  });

  it('extracts tool_result blocks', () => {
    const line = JSON.stringify({
      type: 'user',
      timestamp: '2025-01-15T10:00:03Z',
      message: {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'toolu_123',
          content: 'File contents here...',
        }],
      },
    });
    mockedFs.readFileSync.mockReturnValue(line + '\n');

    const result = parseTranscript('/test.jsonl');
    expect(result).toHaveLength(1);
    const block = result[0].content[0];
    expect(block.type).toBe('tool_result');
    expect(block.toolUseId).toBe('toolu_123');
    expect(block.output).toBe('File contents here...');
    expect(block.isError).toBe(false);
  });

  it('handles tool_result with error flag', () => {
    const line = JSON.stringify({
      type: 'user',
      timestamp: '2025-01-15T10:00:03Z',
      message: {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'toolu_456',
          content: 'Command failed with exit code 1',
          is_error: true,
        }],
      },
    });
    mockedFs.readFileSync.mockReturnValue(line + '\n');

    const result = parseTranscript('/test.jsonl');
    expect(result[0].content[0].isError).toBe(true);
    expect(result[0].content[0].output).toBe('Command failed with exit code 1');
  });

  it('extracts thinking blocks', () => {
    const line = JSON.stringify({
      type: 'assistant',
      timestamp: '2025-01-15T10:00:04Z',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'Let me analyze this step by step...' },
          { type: 'text', text: 'The answer is 42.' },
        ],
      },
    });
    mockedFs.readFileSync.mockReturnValue(line + '\n');

    const result = parseTranscript('/test.jsonl');
    expect(result).toHaveLength(1);
    expect(result[0].content).toHaveLength(2);
    expect(result[0].content[0].type).toBe('thinking');
    expect(result[0].content[0].text).toBe('Let me analyze this step by step...');
    expect(result[0].content[1].type).toBe('text');
  });

  it('skips entries with no content', () => {
    const line = JSON.stringify({
      type: 'assistant',
      timestamp: '2025-01-15T10:00:05Z',
      message: { role: 'assistant', content: [] },
    });
    mockedFs.readFileSync.mockReturnValue(line + '\n');

    const result = parseTranscript('/test.jsonl');
    expect(result).toHaveLength(0);
  });

  it('skips entries without message', () => {
    const line = JSON.stringify({ type: 'system', timestamp: '2025-01-15T10:00:06Z' });
    mockedFs.readFileSync.mockReturnValue(line + '\n');

    const result = parseTranscript('/test.jsonl');
    expect(result).toHaveLength(0);
  });

  it('handles malformed JSONL lines gracefully', () => {
    const data = '{"type":"user","timestamp":"T","message":{"role":"user","content":"hi"}}\n{bad json\n{"type":"assistant","timestamp":"T2","message":{"role":"assistant","content":"hello"}}\n';
    mockedFs.readFileSync.mockReturnValue(data);

    const result = parseTranscript('/test.jsonl');
    // Should parse 2 valid entries, skip the malformed line
    expect(result).toHaveLength(2);
  });

  it('parses summary events', () => {
    const line = JSON.stringify({
      type: 'summary',
      timestamp: '2025-01-15T10:00:07Z',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Context was compacted.' }],
      },
    });
    mockedFs.readFileSync.mockReturnValue(line + '\n');

    const result = parseTranscript('/test.jsonl');
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('summary');
  });

  it('handles tool_result with array content', () => {
    const line = JSON.stringify({
      type: 'user',
      timestamp: '2025-01-15T10:00:08Z',
      message: {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'toolu_789',
          content: [
            { type: 'text', text: 'Part one' },
            { type: 'text', text: 'Part two' },
          ],
        }],
      },
    });
    mockedFs.readFileSync.mockReturnValue(line + '\n');

    const result = parseTranscript('/test.jsonl');
    expect(result[0].content[0].output).toBe('Part one\nPart two');
  });

  it('handles string content in messages', () => {
    const line = JSON.stringify({
      type: 'user',
      timestamp: '2025-01-15T10:00:09Z',
      message: { role: 'user', content: 'Simple string message' },
    });
    mockedFs.readFileSync.mockReturnValue(line + '\n');

    const result = parseTranscript('/test.jsonl');
    expect(result).toHaveLength(1);
    expect(result[0].content[0].type).toBe('text');
    expect(result[0].content[0].text).toBe('Simple string message');
  });
});
