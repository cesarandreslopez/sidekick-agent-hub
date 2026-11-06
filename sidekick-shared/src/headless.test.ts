import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createClaudeStreamJsonParser,
  createCodexExecJsonParser,
  parseClaudeStreamMessage,
  parseCodexExecEvent,
  type HeadlessEvent,
  type HeadlessStreamOptions,
  type HeadlessStreamParser,
} from './headless';

const FIXTURES = path.join(__dirname, 'fixtures', 'headless');
const claudeBytes = readFileSync(path.join(FIXTURES, 'claude-stream.jsonl'));
const codexBytes = readFileSync(path.join(FIXTURES, 'codex-exec.jsonl'));

type Factory = (options?: HeadlessStreamOptions) => HeadlessStreamParser;

/** Feeds `bytes` in chunks of `size` bytes (0: all at once), then ends the stream. */
function feed(factory: Factory, bytes: Buffer, size = 0, options?: HeadlessStreamOptions) {
  const parser = factory(options);
  const events: HeadlessEvent[] = [];
  if (size <= 0) events.push(...parser.push(bytes));
  else
    for (let i = 0; i < bytes.length; i += size)
      events.push(...parser.push(bytes.subarray(i, i + size)));
  events.push(...parser.end());
  return { events, state: parser.state() };
}

function ofType<T extends HeadlessEvent['type']>(events: HeadlessEvent[], type: T) {
  return events.filter(
    (event): event is Extract<HeadlessEvent, { type: T }> => event.type === type,
  );
}

describe('line handling', () => {
  for (const [name, factory, bytes] of [
    ['claude stream-json', createClaudeStreamJsonParser, claudeBytes],
    ['codex exec --json', createCodexExecJsonParser, codexBytes],
  ] as const) {
    it(`${name}: byte-at-a-time, CRLF, a BOM, and no final newline all parse the same`, () => {
      const whole = feed(factory, bytes);
      expect(whole.events.length).toBeGreaterThan(5);
      // Multi-byte characters in the fixtures are split across these chunks.
      for (const size of [1, 2, 3, 7, 64]) {
        expect(feed(factory, bytes, size).events, `chunk ${size}`).toEqual(whole.events);
      }
      const crlf = Buffer.from(bytes.toString('utf8').replace(/\n/g, '\r\n'), 'utf8');
      expect(feed(factory, crlf, 5).events).toEqual(whole.events);
      const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes]);
      expect(feed(factory, bom, 1).events).toEqual(whole.events);
      const unterminated = bytes.subarray(0, bytes.length - 1);
      expect(feed(factory, unterminated, 11).events).toEqual(whole.events);
      // Text input parses like bytes.
      const textParser = factory();
      const textEvents = [...textParser.push(`﻿${bytes.toString('utf8')}`), ...textParser.end()];
      expect(textEvents).toEqual(whole.events);
      expect(whole.state.terminal).toBe(true);
    });

    it(`${name}: skips non-JSON and oversized lines and counts them`, () => {
      const noisy = Buffer.concat([
        Buffer.from('warning: something on stdout\n\n[1, 2]\n'),
        Buffer.from(`{"type":"pad","pad":"${'x'.repeat(3000)}"}\n`),
        bytes,
      ]);
      const { events, state } = feed(factory, noisy, 9, { maxLineBytes: 2000 });
      expect(events).toEqual(feed(factory, bytes).events);
      expect(state).toMatchObject({ nonJsonLines: 2, oversizedLines: 1 });
    });

    it(`${name}: a stream cut before its terminal event ends incomplete`, () => {
      const lines = bytes.toString('utf8').trimEnd().split('\n');
      const cut = Buffer.from(lines.slice(0, -1).join('\n') + '\n');
      const { events, state } = feed(factory, cut, 13);
      const results = ofType(events, 'result');
      expect(results).toHaveLength(1);
      expect(results[0].status).toBe('incomplete');
      expect(state).toMatchObject({ terminal: false, result: 'incomplete' });
      const empty = factory();
      expect(empty.end()).toEqual([
        { type: 'result', provider: empty.state().provider, status: 'incomplete' },
      ]);
      expect(empty.push('{"type":"late"}\n')).toEqual([]);
    });
  }
});

describe('createClaudeStreamJsonParser', () => {
  it('turns a stream-json run into session, text, tool, usage, and result events', () => {
    const { events, state } = feed(createClaudeStreamJsonParser, claudeBytes, 0, {
      includeUnknown: true,
    });
    expect(events.map((event) => event.type)).toEqual([
      'hook',
      'session',
      'text',
      'text',
      'tool',
      'tool',
      'unknown',
      'status',
      'compaction',
      'status',
      'usage',
      'tool',
      'tool',
      'usage',
      'text',
      'usage',
      'usage',
      'result',
    ]);
    expect(events[0]).toEqual({
      type: 'hook',
      provider: 'claude-code',
      phase: 'completed',
      name: 'SessionStart:startup',
      event: 'SessionStart',
      exitCode: 0,
    });
    expect(events[1]).toEqual({
      type: 'session',
      provider: 'claude-code',
      sessionId: 'f3a1c2d4-0000-4000-8000-000000000001',
      model: 'claude-opus-5',
      cwd: '/work/repo',
      tools: ['Bash', 'Read', 'Edit'],
      version: '2.1.0',
      permissionMode: 'default',
    });
    expect(ofType(events, 'tool')).toEqual([
      expect.objectContaining({
        phase: 'started',
        id: 'toolu_01',
        name: 'Bash',
        category: 'shell',
        command: 'npm test',
      }),
      expect.objectContaining({
        phase: 'completed',
        id: 'toolu_01',
        name: 'Bash',
        category: 'shell',
        output: 'FAIL src/a.test.ts\n1 failed',
        status: 'failed',
        isError: true,
      }),
      expect.objectContaining({
        phase: 'started',
        name: 'mcp__docs__search',
        category: 'mcp',
        mcpServer: 'docs',
      }),
      expect.objectContaining({
        phase: 'completed',
        output: 'Found 2 pages.',
        status: 'completed',
      }),
    ]);
    expect(ofType(events, 'compaction')).toEqual([
      { type: 'compaction', provider: 'claude-code', trigger: 'auto', preTokens: 150000 },
    ]);
    expect(ofType(events, 'status').map((event) => event.status)).toEqual(['compacting', null]);
    expect(state).toMatchObject({
      sessionId: 'f3a1c2d4-0000-4000-8000-000000000001',
      model: 'claude-opus-5',
      terminal: true,
      result: 'success',
      text: 'Fixed – café ✓ 🎉',
    });
  });

  it('reports one call usage per message id, with its last values, then the run totals', () => {
    const { events, state } = feed(createClaudeStreamJsonParser, claudeBytes, 3);
    const usage = ofType(events, 'usage');
    expect(usage).toEqual([
      {
        type: 'usage',
        provider: 'claude-code',
        scope: 'call',
        messageId: 'msg_01',
        model: 'claude-opus-5',
        // The last of the three records of msg_01 (60 output tokens), counted once.
        usage: {
          inputTokens: 10,
          outputTokens: 60,
          cacheReadTokens: 3000,
          cacheWriteTokens: 200,
          totalTokens: 3270,
        },
      },
      expect.objectContaining({ scope: 'call', messageId: 'msg_02' }),
      expect.objectContaining({ scope: 'call', messageId: 'msg_03' }),
      {
        type: 'usage',
        provider: 'claude-code',
        scope: 'run',
        model: 'claude-opus-5',
        costUsd: 0.0123,
        usage: {
          inputTokens: 19,
          outputTokens: 102,
          cacheReadTokens: 9500,
          cacheWriteTokens: 200,
          totalTokens: 9821,
        },
      },
    ]);
    // The calls add up to the result's totals.
    const calls = usage.filter((event) => event.scope === 'call');
    expect(calls.reduce((sum, event) => sum + event.usage.outputTokens, 0)).toBe(102);
    expect(state.runUsage).toEqual(usage[3].usage);
    expect(ofType(events, 'result')).toEqual([
      {
        type: 'result',
        provider: 'claude-code',
        status: 'success',
        text: 'Fixed – café ✓ 🎉',
        sessionId: 'f3a1c2d4-0000-4000-8000-000000000001',
        subtype: 'success',
        durationMs: 12000,
        numTurns: 3,
        costUsd: 0.0123,
      },
    ]);
  });

  it('emits partial text only when asked', () => {
    const plain = feed(createClaudeStreamJsonParser, claudeBytes).events;
    expect(ofType(plain, 'text').some((event) => event.partial)).toBe(false);
    const partial = feed(createClaudeStreamJsonParser, claudeBytes, 0, { includePartial: true });
    expect(ofType(partial.events, 'text')[0]).toEqual({
      type: 'text',
      provider: 'claude-code',
      kind: 'message',
      text: 'I will',
      partial: true,
    });
  });

  it('reports error results and API error messages', () => {
    expect(
      parseClaudeStreamMessage({
        type: 'result',
        subtype: 'error_max_turns',
        is_error: true,
        errors: ['Reached the turn limit'],
        usage: { input_tokens: 1, output_tokens: 2 },
      }),
    ).toEqual([
      {
        type: 'usage',
        provider: 'claude-code',
        scope: 'run',
        usage: {
          inputTokens: 1,
          outputTokens: 2,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: 3,
        },
      },
      {
        type: 'result',
        provider: 'claude-code',
        status: 'error',
        subtype: 'error_max_turns',
        errors: ['Reached the turn limit'],
      },
    ]);
    expect(
      parseClaudeStreamMessage({
        type: 'assistant',
        error: 'rate_limit',
        message: {
          id: 'msg_x',
          model: '<synthetic>',
          content: [{ type: 'text', text: 'API Error: rate limited' }],
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      }),
    ).toEqual([
      {
        type: 'error',
        provider: 'claude-code',
        scope: 'stream',
        message: 'API Error: rate limited',
        code: 'rate_limit',
      },
    ]);
    // Stateless: every record reports its own usage.
    const record = JSON.parse(claudeBytes.toString('utf8').split('\n')[3]);
    expect(ofType(parseClaudeStreamMessage(record), 'usage')).toHaveLength(1);
    expect(parseClaudeStreamMessage('nope')).toEqual([]);
  });
});

describe('createClaudeStreamJsonParser: interleaved subagents', () => {
  it("keeps each stream's latest usage when parallel subagents interleave", () => {
    const assistant = (id: string, lane: string | null, output: number) =>
      JSON.stringify({
        type: 'assistant',
        parent_tool_use_id: lane,
        message: {
          id,
          model: 'claude-sonnet-4-5',
          content: [{ type: 'text', text: `${id} ${output}` }],
          usage: { input_tokens: 10, output_tokens: output },
        },
      });
    const lines = [
      assistant('msg_a', 'toolu_a', 1),
      assistant('msg_b', 'toolu_b', 1),
      assistant('msg_a', 'toolu_a', 40),
      assistant('msg_b', 'toolu_b', 25),
      // A new call on stream A ends msg_a only.
      assistant('msg_a2', 'toolu_a', 5),
    ];
    const parser = createClaudeStreamJsonParser();
    const events = [...parser.push(lines.join('\n') + '\n'), ...parser.end()];
    const usage = ofType(events, 'usage').filter((event) => event.scope === 'call');
    const outputById = Object.fromEntries(
      usage.map((event) => [event.messageId, event.usage.outputTokens]),
    );
    expect(outputById).toEqual({ msg_a: 40, msg_b: 25, msg_a2: 5 });
    expect(usage).toHaveLength(3);
  });
});

describe('createCodexExecJsonParser', () => {
  it('turns an exec run into session, text, tool, error, usage, and result events', () => {
    const { events, state } = feed(createCodexExecJsonParser, codexBytes, 0, {
      model: 'gpt-5-codex',
    });
    expect(events.map((event) => event.type)).toEqual([
      'session',
      'status',
      'text',
      'tool',
      'tool',
      'error',
      'tool',
      'tool',
      'tool',
      'tool',
      'text',
      'usage',
      'usage',
      'result',
    ]);
    expect(events[0]).toEqual({
      type: 'session',
      provider: 'codex',
      sessionId: '019d86b0-b20c-7b02-a3b2-0000000e7ec1',
      model: 'gpt-5-codex',
    });
    expect(ofType(events, 'tool')).toEqual([
      expect.objectContaining({
        phase: 'started',
        id: 'item_1',
        name: 'exec_command',
        category: 'shell',
        status: 'in_progress',
      }),
      expect.objectContaining({
        phase: 'completed',
        command: "/bin/zsh -lc 'npm test'",
        output: 'FAIL src/a.test.ts\n',
        exitCode: 1,
        status: 'failed',
        isError: true,
      }),
      expect.objectContaining({ name: 'apply_patch', category: 'file_edit', status: 'completed' }),
      expect.objectContaining({
        phase: 'started',
        name: 'search',
        category: 'mcp',
        mcpServer: 'docs',
      }),
      expect.objectContaining({ phase: 'completed', output: 'Found 2 pages.' }),
      expect.objectContaining({ name: 'update_plan', category: 'planning' }),
    ]);
    expect(ofType(events, 'error')).toEqual([
      expect.objectContaining({ scope: 'item', message: expect.stringContaining('Reconnecting') }),
    ]);
    expect(ofType(events, 'result')).toEqual([
      {
        type: 'result',
        provider: 'codex',
        status: 'success',
        text: 'Done — naïve fix ✓ 🎉',
        sessionId: '019d86b0-b20c-7b02-a3b2-0000000e7ec1',
      },
    ]);
    expect(state).toMatchObject({ terminal: true, result: 'success', model: 'gpt-5-codex' });
  });

  it('reports the thread total and, against a baseline, this run’s usage', () => {
    const total = {
      // 12 000 input = 3 000 uncached + 8 000 cached + 1 000 written to the cache.
      inputTokens: 3000,
      outputTokens: 700,
      cacheReadTokens: 8000,
      cacheWriteTokens: 1000,
      reasoningTokens: 300,
      totalTokens: 12700,
    };
    const fresh = feed(createCodexExecJsonParser, codexBytes);
    expect(ofType(fresh.events, 'usage')).toEqual([
      { type: 'usage', provider: 'codex', scope: 'thread-total', usage: total },
      { type: 'usage', provider: 'codex', scope: 'run', usage: total },
    ]);

    // `exec resume`: the previous run left the thread at this total.
    const baselineUsage = {
      inputTokens: 1000,
      outputTokens: 200,
      cacheReadTokens: 5000,
      cacheWriteTokens: 0,
      reasoningTokens: 100,
      totalTokens: 6200,
    };
    const resumed = feed(createCodexExecJsonParser, codexBytes, 0, { baselineUsage });
    expect(resumed.state.threadTotal).toEqual(total);
    expect(resumed.state.runUsage).toEqual({
      inputTokens: 2000,
      outputTokens: 500,
      cacheReadTokens: 3000,
      cacheWriteTokens: 1000,
      reasoningTokens: 200,
      totalTokens: 6500,
    });
  });

  it('keeps error payloads, structured fields included, for failure diagnosis', () => {
    const parser = createCodexExecJsonParser();
    const events = [
      ...parser.push(
        JSON.stringify({
          type: 'error',
          message: 'stream disconnected',
          codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: null } },
        }) + '\n',
      ),
      ...parser.push(
        JSON.stringify({
          type: 'turn.failed',
          error: { message: 'Overloaded', codexErrorInfo: 'serverOverloaded' },
        }) + '\n',
      ),
      ...parser.end(),
    ];
    expect(events).toEqual([
      {
        type: 'error',
        provider: 'codex',
        scope: 'stream',
        message: 'stream disconnected',
        details: {
          message: 'stream disconnected',
          codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: null } },
        },
      },
      {
        type: 'error',
        provider: 'codex',
        scope: 'turn',
        message: 'Overloaded',
        details: { message: 'Overloaded', codexErrorInfo: 'serverOverloaded' },
      },
      { type: 'result', provider: 'codex', status: 'error', errors: ['Overloaded'] },
    ]);
    expect(parser.state()).toMatchObject({ terminal: true, result: 'error' });
  });

  it('parses single events statelessly and reports item updates only when asked', () => {
    const updated = JSON.parse(codexBytes.toString('utf8').split('\n')[4]);
    expect(parseCodexExecEvent(updated)).toEqual([]);
    expect(parseCodexExecEvent(updated, { includePartial: true })).toEqual([
      expect.objectContaining({ type: 'tool', phase: 'updated', output: 'RUN' }),
    ]);
    expect(parseCodexExecEvent({ type: 'turn.completed', usage: { input_tokens: 10 } })).toEqual([
      expect.objectContaining({ scope: 'thread-total' }),
      expect.objectContaining({ scope: 'run' }),
      { type: 'result', provider: 'codex', status: 'success' },
    ]);
    expect(parseCodexExecEvent({ type: 'something.new' }, { includeUnknown: true })).toEqual([
      { type: 'unknown', provider: 'codex', raw: { type: 'something.new' } },
    ]);
    expect(parseCodexExecEvent(null)).toEqual([]);
  });
});
