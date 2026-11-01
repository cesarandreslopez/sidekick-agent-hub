import { describe, expect, it } from 'vitest';
import {
  CodexRolloutParser,
  DEFAULT_MAX_TRACKED_TOOL_CALLS,
  resolveCodexCallUsage,
} from './codexParser';
import { extractNormalizedUsage } from '../usageNormalization';
import type { CodexRolloutLine } from '../types/codex';

function line(
  type: CodexRolloutLine['type'],
  payload: CodexRolloutLine['payload'],
  timestamp = '2026-06-01T12:00:00.000Z',
): CodexRolloutLine {
  return { timestamp, type, payload };
}

describe('CodexRolloutParser', () => {
  it('preserves exact context compaction token counts', () => {
    const parser = new CodexRolloutParser();
    const events = parser.convertLine(
      line('event_msg', {
        type: 'context_compacted',
        summary: 'kept summary',
        tokens_before: 121_400,
        tokens_after: 27_900,
      }),
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'summary',
      compaction: { tokensBefore: 121_400, tokensAfter: 27_900 },
    });
  });

  it('emits visible system audit events for base instructions and developer messages', () => {
    const parser = new CodexRolloutParser();

    const metaEvents = parser.convertLine(
      line('session_meta', {
        id: 'session-1',
        cwd: '/workspace/app',
        base_instructions: { text: 'Always inspect the repo first.' },
      }),
    );
    const developerEvents = parser.convertLine(
      line('response_item', {
        type: 'message',
        role: 'developer',
        content: [{ type: 'input_text', text: 'Follow the local coding style.' }],
      }),
    );

    expect(metaEvents).toHaveLength(1);
    expect(metaEvents[0]).toMatchObject({
      type: 'system',
      cwd: '/workspace/app',
      message: {
        role: 'system',
        sourceLabel: 'base instructions',
      },
    });
    expect(developerEvents).toHaveLength(1);
    expect(developerEvents[0]).toMatchObject({
      type: 'system',
      message: {
        role: 'developer',
        sourceLabel: 'developer',
      },
    });
  });

  it('emits message-less session metadata so reported cwd remains observable', () => {
    const parser = new CodexRolloutParser();
    const events = parser.convertLine(
      line('session_meta', {
        id: 'session-1',
        cwd: '/workspace/app',
      }),
    );

    expect(events).toEqual([
      {
        type: 'system',
        timestamp: '2026-06-01T12:00:00.000Z',
        cwd: '/workspace/app',
      },
    ]);
  });

  it('attaches normalized rate limits to token_count system events', () => {
    const parser = new CodexRolloutParser();
    parser.convertLine(line('turn_context', { model: 'gpt-5-codex' }));

    const events = parser.convertLine(
      line('event_msg', {
        type: 'token_count',
        info: {
          last_token_usage: {
            input_tokens: 1000,
            output_tokens: 200,
            cached_input_tokens: 300,
            reasoning_output_tokens: 40,
          },
        },
        rate_limits: {
          primary: { used_percent: 72, window_minutes: 300, resets_at: 1790000000 },
          secondary: { used_percent: 12, window_minutes: 10080, resets_at: 1790600000 },
        },
      }),
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'system',
      message: {
        role: 'system',
        sourceLabel: 'token count',
        model: 'gpt-5-codex',
        usage: {
          input_tokens: 700,
          output_tokens: 200,
          cache_read_input_tokens: 300,
          reasoning_tokens: 40,
        },
      },
      rateLimits: {
        primary: { usedPercent: 72, windowMinutes: 300, resetsAt: 1790000000 },
        secondary: { usedPercent: 12, windowMinutes: 10080, resetsAt: 1790600000 },
      },
    });
  });

  it('clamps malformed cached input above total input without rebilling reasoning tokens', () => {
    const parser = new CodexRolloutParser();
    const [event] = parser.convertLine(
      line('event_msg', {
        type: 'token_count',
        info: {
          last_token_usage: {
            input_tokens: 50,
            output_tokens: 20,
            cached_input_tokens: 75,
            reasoning_output_tokens: 10,
          },
        },
      }),
    );

    expect(event.message?.usage).toMatchObject({
      input_tokens: 0,
      output_tokens: 20,
      cache_read_input_tokens: 75,
      reasoning_tokens: 10,
    });
  });

  it('keeps the aggregate codex rate limits when a later model-specific event reports 0%', () => {
    const parser = new CodexRolloutParser();

    parser.convertLine(
      line('event_msg', {
        type: 'token_count',
        info: null,
        rate_limits: {
          limit_id: 'codex',
          primary: { used_percent: 17, window_minutes: 300, resets_at: 1790000000 },
          secondary: { used_percent: 3, window_minutes: 10080, resets_at: 1790600000 },
        },
      }),
    );
    // A trailing per-model family at 0% must not overwrite the aggregate plan quota.
    parser.convertLine(
      line('event_msg', {
        type: 'token_count',
        info: null,
        rate_limits: {
          limit_id: 'codex_bengalfox',
          primary: { used_percent: 0, window_minutes: 300, resets_at: 1790900000 },
        },
      }),
    );

    expect(parser.getLastRateLimits()).toMatchObject({
      limit_id: 'codex',
      primary: { used_percent: 17 },
    });
  });

  it('falls back to a model-specific family when no aggregate rate limits were seen', () => {
    const parser = new CodexRolloutParser();

    parser.convertLine(
      line('event_msg', {
        type: 'token_count',
        info: null,
        rate_limits: {
          limit_id: 'codex_bengalfox',
          primary: { used_percent: 9, window_minutes: 300, resets_at: 1790900000 },
        },
      }),
    );

    expect(parser.getLastRateLimits()).toMatchObject({
      limit_id: 'codex_bengalfox',
      primary: { used_percent: 9 },
    });
  });

  it('fans apply_patch output out to each synthetic Edit tool result', () => {
    const parser = new CodexRolloutParser();

    const toolEvents = parser.convertLine(
      line('response_item', {
        type: 'custom_tool_call',
        call_id: 'patch-1',
        name: 'apply_patch',
        input: [
          '*** Begin Patch',
          '*** Update File: src/a.ts',
          '@@',
          '-old',
          '+new',
          '*** Update File: src/b.ts',
          '@@',
          '-old',
          '+new',
          '*** End Patch',
        ].join('\n'),
      }),
    );
    const resultEvents = parser.convertLine(
      line('response_item', {
        type: 'custom_tool_call_output',
        call_id: 'patch-1',
        output: '{"metadata":{"exit_code":0,"duration_seconds":0.5}}',
      }),
    );

    expect(toolEvents.map((e) => e.message.content)).toHaveLength(2);
    expect(resultEvents).toHaveLength(2);
    expect(
      resultEvents.map((e) => {
        const content = e.message.content as Array<Record<string, unknown>>;
        return content[0].tool_use_id;
      }),
    ).toEqual(['patch-1-src/a.ts', 'patch-1-src/b.ts']);
  });

  it('preserves MCP server metadata on synthesized tool inputs', () => {
    const parser = new CodexRolloutParser();

    parser.convertLine(
      line('event_msg', {
        type: 'mcp_tool_call_begin',
        call_id: 'mcp-1',
        server_name: 'contextful-cortex',
        tool_name: 'searchKnowledge',
        arguments: { query: 'planning' },
      }),
    );
    const events = parser.convertLine(
      line('event_msg', {
        type: 'mcp_tool_call_end',
        call_id: 'mcp-1',
        result: '[]',
        is_error: false,
      }),
    );

    const toolUse = events[0].message.content as Array<Record<string, unknown>>;
    expect(toolUse[0]).toMatchObject({
      type: 'tool_use',
      name: 'SearchKnowledge',
      input: {
        query: 'planning',
        _sidekickRawToolName: 'searchKnowledge',
        _sidekickMcpServerName: 'contextful-cortex',
      },
    });
  });
});

describe('duplicate token_count events', () => {
  const usage = (input: number, cached: number, output: number) => ({
    input_tokens: input,
    cached_input_tokens: cached,
    output_tokens: output,
    reasoning_output_tokens: 0,
    total_tokens: input + output,
  });

  function totalTokens(parser: CodexRolloutParser, payloads: Record<string, unknown>[]): number {
    let total = 0;
    for (const payload of payloads) {
      for (const event of parser.convertLine(line('event_msg', payload))) {
        total += extractNormalizedUsage(event)?.totalTokens ?? 0;
      }
    }
    return total;
  }

  it('counts a call once when Codex resends an unchanged cumulative total', () => {
    const parser = new CodexRolloutParser();
    const first = {
      type: 'token_count',
      info: { last_token_usage: usage(1000, 800, 50), total_token_usage: usage(1000, 800, 50) },
    };
    const second = {
      type: 'token_count',
      info: { last_token_usage: usage(1200, 1000, 30), total_token_usage: usage(2200, 1800, 80) },
    };
    // Rate-limit refreshes resend the previous info verbatim.
    const total = totalTokens(parser, [first, first, second, second, second]);
    expect(total).toBe(2200 + 80);
  });

  it('still emits rate limits from a duplicate event, without usage', () => {
    const parser = new CodexRolloutParser();
    const info = { last_token_usage: usage(10, 0, 1), total_token_usage: usage(10, 0, 1) };
    parser.convertLine(line('event_msg', { type: 'token_count', info }));
    const events = parser.convertLine(
      line('event_msg', {
        type: 'token_count',
        info,
        rate_limits: { primary: { used_percent: 5, window_minutes: 300, resets_at: 1 } },
      }),
    );
    expect(events).toHaveLength(1);
    expect(events[0].message?.usage).toBeUndefined();
    expect(events[0].rateLimits?.primary?.usedPercent).toBe(5);
  });

  it('uses the growth of the cumulative total when last_token_usage is missing', () => {
    const parser = new CodexRolloutParser();
    const total = totalTokens(parser, [
      { type: 'token_count', info: { total_token_usage: usage(1000, 0, 100) } },
      { type: 'token_count', info: { total_token_usage: usage(1500, 0, 150) } },
      { type: 'token_count', info: { total_token_usage: usage(1500, 0, 150) } },
    ]);
    // Summing the cumulative values would give 1100 + 1650 + 1650.
    expect(total).toBe(1650);
  });

  it('re-baselines when the cumulative total drops', () => {
    expect(
      resolveCodexCallUsage(
        { last_token_usage: usage(10, 0, 5), total_token_usage: usage(10, 0, 5) },
        usage(5000, 0, 500),
      ),
    ).toEqual({ usage: usage(10, 0, 5), total: usage(10, 0, 5) });
  });

  it('resets its duplicate baseline with the parser', () => {
    const parser = new CodexRolloutParser();
    const event = {
      type: 'token_count',
      info: { last_token_usage: usage(10, 0, 5), total_token_usage: usage(10, 0, 5) },
    };
    expect(totalTokens(parser, [event])).toBe(15);
    parser.reset();
    expect(totalTokens(parser, [event])).toBe(15);
  });

  describe('bounded correlation state', () => {
    function toolUseCount(events: ReturnType<CodexRolloutParser['convertLine']>): number {
      return events.filter(
        (event) =>
          event.type === 'assistant' &&
          Array.isArray(event.message.content) &&
          event.message.content.some((block) => (block as { type?: string }).type === 'tool_use'),
      ).length;
    }

    function exec(parser: CodexRolloutParser, callId: string): number {
      parser.convertLine(
        line('event_msg', { type: 'exec_command_begin', call_id: callId, command: ['ls'] }),
      );
      return toolUseCount(
        parser.convertLine(
          line('event_msg', { type: 'exec_command_end', call_id: callId, exit_code: 0 }),
        ),
      );
    }

    function call(parser: CodexRolloutParser, callId: string): number {
      return toolUseCount(
        parser.convertLine(
          line('response_item', {
            type: 'function_call',
            call_id: callId,
            name: 'exec_command',
            arguments: '{"cmd":"ls"}',
          }),
        ),
      );
    }

    function tracked(parser: CodexRolloutParser): { emitted: number; pending: number } {
      const state = parser as unknown as {
        emittedToolUseIds: Set<string>;
        pendingExecCommands: Map<string, unknown>;
      };
      return { emitted: state.emittedToolUseIds.size, pending: state.pendingExecCommands.size };
    }

    it('caps remembered call ids and still dedupes recent calls', () => {
      const parser = new CodexRolloutParser({ maxTrackedToolCalls: 8 });
      for (let i = 0; i < 100; i++) expect(call(parser, `call-${i}`)).toBe(1);
      expect(tracked(parser).emitted).toBe(8);

      // A recent function_call is not re-emitted from its exec end event.
      expect(exec(parser, 'call-99')).toBe(0);
      // One evicted long ago is treated as unseen.
      expect(exec(parser, 'call-0')).toBe(1);
      expect(tracked(parser).emitted).toBe(8);
    });

    it('caps exec begin events that never see an end', () => {
      const parser = new CodexRolloutParser({ maxTrackedToolCalls: 4 });
      for (let i = 0; i < 50; i++) {
        parser.convertLine(
          line('event_msg', {
            type: 'exec_command_begin',
            call_id: `open-${i}`,
            command: ['sleep'],
          }),
        );
      }
      expect(tracked(parser).pending).toBe(4);
    });

    it('defaults to DEFAULT_MAX_TRACKED_TOOL_CALLS and ignores invalid caps', () => {
      for (const options of [undefined, { maxTrackedToolCalls: 0 }, { maxTrackedToolCalls: NaN }]) {
        const parser = new CodexRolloutParser(options);
        for (let i = 0; i < DEFAULT_MAX_TRACKED_TOOL_CALLS + 10; i++) call(parser, `call-${i}`);
        expect(tracked(parser).emitted).toBe(DEFAULT_MAX_TRACKED_TOOL_CALLS);
      }
    });
  });
});

/** A rollout touching every handler that carries tool or reasoning payloads. */
function mixedRollout(): CodexRolloutLine[] {
  const at = (second: number) => `2026-06-01T12:00:${String(second).padStart(2, '0')}.000Z`;
  return [
    line(
      'session_meta',
      { id: 'session-1', cwd: '/w', base_instructions: { text: 'Base rules.' } },
      at(0),
    ),
    line('turn_context', { model: 'gpt-5' }, at(1)),
    line(
      'response_item',
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Fix it' }] },
      at(2),
    ),
    line(
      'response_item',
      { type: 'reasoning', id: 'r-1', summary: [{ type: 'summary_text', text: 'Secret plan' }] },
      at(3),
    ),
    line(
      'response_item',
      {
        type: 'function_call',
        call_id: 'fc-1',
        name: 'exec_command',
        arguments: JSON.stringify({ cmd: 'cat secrets.txt' }),
      },
      at(4),
    ),
    line(
      'response_item',
      { type: 'function_call_output', call_id: 'fc-1', output: 'Process exited with code 1' },
      at(5),
    ),
    line(
      'response_item',
      {
        type: 'local_shell_call',
        call_id: 'ls-1',
        action: { command: ['ls', '-la'], workdir: '/w' },
      },
      at(6),
    ),
    line(
      'response_item',
      {
        type: 'custom_tool_call',
        call_id: 'patch-1',
        name: 'apply_patch',
        input: '*** Begin Patch\n*** Update File: src/a.ts\n-old\n+new\n*** End Patch',
      },
      at(7),
    ),
    line(
      'response_item',
      {
        type: 'custom_tool_call_output',
        call_id: 'patch-1',
        output: '{"output":"Done","metadata":{"exit_code":0,"duration_seconds":0.25}}',
      },
      at(8),
    ),
    line(
      'event_msg',
      { type: 'exec_command_begin', call_id: 'ex-1', command: ['rg', 'token'], workdir: '/w' },
      at(9),
    ),
    line(
      'event_msg',
      {
        type: 'exec_command_end',
        call_id: 'ex-1',
        stdout: 'found it',
        exit_code: 0,
        duration_ms: 12,
      },
      at(10),
    ),
    line(
      'event_msg',
      {
        type: 'mcp_tool_call_begin',
        call_id: 'mcp-1',
        server_name: 'docs',
        tool_name: 'search',
        arguments: { query: 'private query' },
      },
      at(11),
    ),
    line(
      'event_msg',
      { type: 'mcp_tool_call_end', call_id: 'mcp-1', result: 'hit', duration_ms: 7 },
      at(12),
    ),
    line(
      'event_msg',
      { type: 'patch_applied', file_path: 'src/b.ts', additions: 3, deletions: 1 },
      at(13),
    ),
    line('event_msg', { type: 'task_started', collaboration_mode_kind: 'plan' }, at(14)),
    line(
      'event_msg',
      {
        type: 'token_count',
        info: {
          last_token_usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 20 },
        },
      },
      at(15),
    ),
    line(
      'response_item',
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Done.' }] },
      at(16),
    ),
  ];
}

function runRollout(parser: CodexRolloutParser, lines = mixedRollout()) {
  return lines.flatMap((rolloutLine) => parser.convertLine(rolloutLine));
}

type Block = Record<string, unknown>;

function blocksOf(events: ReturnType<typeof runRollout>): Block[] {
  return events.flatMap((event) =>
    Array.isArray(event.message?.content) ? (event.message.content as Block[]) : [],
  );
}

describe('CodexRolloutParser metadataOnly', () => {
  it('keeps names, ids, raw-name keys, timestamps, models, usage, and message text', () => {
    const full = runRollout(new CodexRolloutParser());
    const meta = runRollout(new CodexRolloutParser({ metadataOnly: true }));

    expect(meta).toHaveLength(full.length);
    meta.forEach((event, index) => {
      const reference = full[index];
      expect(event.type).toBe(reference.type);
      expect(event.timestamp).toBe(reference.timestamp);
      expect(event.message?.id).toBe(reference.message?.id);
      expect(event.message?.model).toBe(reference.message?.model);
      expect(event.message?.usage).toEqual(reference.message?.usage);
      expect(event.cwd).toBe(reference.cwd);
    });

    const fullBlocks = blocksOf(full);
    const metaBlocks = blocksOf(meta);
    expect(metaBlocks).toHaveLength(fullBlocks.length);
    metaBlocks.forEach((block, index) => {
      const reference = fullBlocks[index];
      expect(block.type).toBe(reference.type);
      if (block.type === 'tool_use') {
        expect(block.id).toBe(reference.id);
        expect(block.name).toBe(reference.name);
        const rawKeys = Object.fromEntries(
          Object.entries(reference.input as Block).filter(([key]) => key.startsWith('_sidekick')),
        );
        expect(Object.keys(rawKeys).length).toBeGreaterThan(0);
        expect(block.input).toEqual(rawKeys);
      } else if (block.type === 'tool_result') {
        expect(block.tool_use_id).toBe(reference.tool_use_id);
        expect(block.is_error).toBe(reference.is_error);
        expect(block.duration).toBe(reference.duration);
        expect(block.content).toBe('');
        expect(reference.content).not.toBe('');
      } else if (block.type === 'thinking') {
        expect(block.thinking).toBe('');
        expect(reference.thinking).toBe('Secret plan');
      } else {
        expect(block).toEqual(reference);
      }
    });

    const serialized = JSON.stringify(meta);
    for (const secret of ['secrets.txt', 'Secret plan', 'private query', 'found it', 'rg']) {
      expect(serialized).not.toContain(secret);
    }
    expect(serialized).toContain('Base rules.');
    expect(serialized).toContain('Done.');
    expect(metaBlocks).toContainEqual(
      expect.objectContaining({
        type: 'tool_use',
        id: 'mcp-1',
        input: { _sidekickRawToolName: 'search', _sidekickMcpServerName: 'docs' },
      }),
    );
  });

  it('buffers no command or arguments for pending calls', () => {
    const parser = new CodexRolloutParser({ metadataOnly: true });
    parser.convertLine(
      line('event_msg', {
        type: 'exec_command_begin',
        call_id: 'ex-1',
        command: ['echo', 'x'.repeat(1000)],
        workdir: '/w',
      }),
    );
    parser.convertLine(
      line('event_msg', {
        type: 'mcp_tool_call_begin',
        call_id: 'mcp-1',
        server_name: 'docs',
        tool_name: 'search',
        arguments: { query: 'y'.repeat(1000) },
      }),
    );
    const state = parser as unknown as {
      pendingExecCommands: Map<string, { command: string[]; workdir?: string }>;
      pendingMcpToolCalls: Map<string, { arguments?: unknown; server_name?: string }>;
    };
    expect(state.pendingExecCommands.get('ex-1')).toMatchObject({ command: [] });
    expect(state.pendingExecCommands.get('ex-1')?.workdir).toBeUndefined();
    expect(state.pendingMcpToolCalls.get('mcp-1')).toMatchObject({ server_name: 'docs' });
    expect(state.pendingMcpToolCalls.get('mcp-1')?.arguments).toBeUndefined();
  });

  it('leaves the default output unchanged', () => {
    const defaults = runRollout(new CodexRolloutParser());
    expect(runRollout(new CodexRolloutParser({ metadataOnly: false }))).toEqual(defaults);
    expect(runRollout(new CodexRolloutParser({ maxPendingBytes: undefined }))).toEqual(defaults);
    expect(blocksOf(defaults)).toContainEqual(
      expect.objectContaining({
        type: 'tool_use',
        id: 'fc-1',
        input: {
          cmd: 'cat secrets.txt',
          command: 'cat secrets.txt',
          _sidekickRawToolName: 'exec_command',
        },
      }),
    );
  });
});

describe('CodexRolloutParser maxPendingBytes', () => {
  function mcpBegin(callId: string, pad: number, server = 'docs'): CodexRolloutLine {
    return line('event_msg', {
      type: 'mcp_tool_call_begin',
      call_id: callId,
      server_name: server,
      tool_name: 'search',
      arguments: { query: 'q'.repeat(pad) },
    });
  }

  function mcpEnd(parser: CodexRolloutParser, callId: string): Block {
    const events = parser.convertLine(
      line('event_msg', { type: 'mcp_tool_call_end', call_id: callId, result: 'ok' }),
    );
    return (events[0].message?.content as Block[])[0];
  }

  it('evicts the oldest pending calls first and counts them', () => {
    const parser = new CodexRolloutParser({ maxPendingBytes: 1_000 });
    for (let i = 0; i < 10; i++) parser.convertLine(mcpBegin(`mcp-${i}`, 200));

    const stats = parser.getPendingStats();
    expect(stats.pendingBytes).not.toBeNull();
    expect(stats.pendingBytes!).toBeLessThanOrEqual(1_000);
    expect(stats.pendingCalls).toBeGreaterThan(0);
    expect(stats.pendingCalls).toBeLessThan(10);
    expect(stats.evictedByBytes).toBe(10 - stats.pendingCalls);
    expect(stats.evictedByCount).toBe(0);

    // The newest call still has its details; the oldest lost them.
    expect(mcpEnd(parser, 'mcp-9')).toMatchObject({
      name: 'Search',
      input: { query: 'q'.repeat(200), _sidekickMcpServerName: 'docs' },
    });
    const forgotten = mcpEnd(parser, 'mcp-0');
    expect(forgotten).toMatchObject({ id: 'mcp-0', input: { _sidekickRawToolName: 'McpTool' } });
    expect((forgotten.input as Block).query).toBeUndefined();
  });

  it('keeps one oldest-first order across exec, MCP, and patch calls', () => {
    const parser = new CodexRolloutParser({ maxPendingBytes: 700 });
    parser.convertLine(
      line('event_msg', {
        type: 'exec_command_begin',
        call_id: 'ex-old',
        command: ['echo', 'e'.repeat(250)],
      }),
    );
    parser.convertLine(mcpBegin('mcp-mid', 200));
    parser.convertLine(
      line('response_item', {
        type: 'custom_tool_call',
        call_id: 'patch-new',
        name: 'apply_patch',
        input: `*** Begin Patch\n*** Update File: ${'p'.repeat(150)}.ts\n*** End Patch`,
      }),
    );

    const state = parser as unknown as {
      pendingExecCommands: Map<string, unknown>;
      pendingMcpToolCalls: Map<string, unknown>;
      patchExpandedToolUseIds: Map<string, unknown>;
    };
    expect(state.pendingExecCommands.has('ex-old')).toBe(false);
    expect(state.pendingMcpToolCalls.has('mcp-mid')).toBe(true);
    expect(state.patchExpandedToolUseIds.has('patch-new')).toBe(true);
    expect(parser.getPendingStats()).toMatchObject({ pendingCalls: 2, evictedByBytes: 1 });
  });

  it('releases bytes when calls finish and does not keep a call larger than the budget', () => {
    const parser = new CodexRolloutParser({ maxPendingBytes: 500 });
    parser.convertLine(mcpBegin('mcp-1', 100));
    expect(parser.getPendingStats().pendingBytes).toBeGreaterThan(100);
    mcpEnd(parser, 'mcp-1');
    expect(parser.getPendingStats()).toMatchObject({ pendingCalls: 0, pendingBytes: 0 });

    parser.convertLine(mcpBegin('mcp-huge', 5_000));
    expect(parser.getPendingStats()).toMatchObject({
      pendingCalls: 0,
      pendingBytes: 0,
      evictedByBytes: 1,
    });

    // Re-beginning a call replaces its bytes instead of adding to them.
    parser.convertLine(mcpBegin('mcp-2', 100));
    const once = parser.getPendingStats().pendingBytes;
    parser.convertLine(mcpBegin('mcp-2', 100));
    expect(parser.getPendingStats().pendingBytes).toBe(once);

    parser.reset();
    expect(parser.getPendingStats()).toEqual({
      pendingCalls: 0,
      pendingBytes: 0,
      evictedByCount: 0,
      evictedByBytes: 0,
    });
  });

  it('counts count-cap evictions and keeps byte accounting in step with them', () => {
    const parser = new CodexRolloutParser({ maxTrackedToolCalls: 2, maxPendingBytes: 100_000 });
    for (let i = 0; i < 5; i++) parser.convertLine(mcpBegin(`mcp-${i}`, 10));
    const stats = parser.getPendingStats();
    expect(stats).toMatchObject({ pendingCalls: 2, evictedByCount: 3, evictedByBytes: 0 });
    mcpEnd(parser, 'mcp-3');
    mcpEnd(parser, 'mcp-4');
    expect(parser.getPendingStats()).toMatchObject({ pendingCalls: 0, pendingBytes: 0 });
  });

  it('is unlimited by default and for invalid budgets', () => {
    for (const maxPendingBytes of [undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const parser = new CodexRolloutParser({ maxPendingBytes });
      for (let i = 0; i < 20; i++) parser.convertLine(mcpBegin(`mcp-${i}`, 10_000));
      expect(parser.getPendingStats()).toEqual({
        pendingCalls: 20,
        pendingBytes: null,
        evictedByCount: 0,
        evictedByBytes: 0,
      });
    }
  });
});

describe('CodexRolloutParser resume state', () => {
  const usage = (input: number, output: number) => ({
    input_tokens: input,
    cached_input_tokens: 0,
    output_tokens: output,
    reasoning_output_tokens: 0,
    total_tokens: input + output,
  });
  const at = (second: number) => `2026-06-01T12:01:${String(second).padStart(2, '0')}.000Z`;

  /** The mixed rollout plus cumulative token counts (with a duplicate) and the plan's end. */
  function resumableRollout(): CodexRolloutLine[] {
    return [
      ...mixedRollout(),
      line('turn_context', { model: 'gpt-5.1-codex' }, at(0)),
      line(
        'event_msg',
        {
          type: 'token_count',
          info: { total_token_usage: usage(1000, 100), model_context_window: 258_400 },
          rate_limits: { limit_id: 'codex', primary: { used_percent: 12, window_minutes: 300 } },
        },
        at(1),
      ),
      line(
        'event_msg',
        { type: 'token_count', info: { total_token_usage: usage(1000, 100) } },
        at(2),
      ),
      line(
        'event_msg',
        { type: 'token_count', info: { total_token_usage: usage(1600, 160) } },
        at(3),
      ),
      line('event_msg', { type: 'task_complete' }, at(4)),
    ];
  }

  /** Parses `lines[0..cut)`, round-trips the state through JSON, and parses the rest. */
  function resumedAt(lines: CodexRolloutLine[], cut: number, options = {}) {
    const live = new CodexRolloutParser(options);
    runRollout(live, lines.slice(0, cut));
    const state = JSON.parse(JSON.stringify(live.exportResumeState()));
    const resumed = new CodexRolloutParser(options);
    expect(resumed.importResumeState(state)).toBe(true);
    return { resumed, events: runRollout(resumed, lines.slice(cut)) };
  }

  it('continues exactly like an uninterrupted parse from every line boundary', () => {
    const lines = resumableRollout();
    for (let cut = 0; cut <= lines.length; cut++) {
      const full = new CodexRolloutParser();
      const expected = runRollout(full, lines).slice(
        runRollout(new CodexRolloutParser(), lines.slice(0, cut)).length,
      );
      const { resumed, events } = resumedAt(lines, cut);
      expect(events, `cut at line ${cut}`).toEqual(expected);
      expect(resumed.exportResumeState(), `cut at line ${cut}`).toEqual(full.exportResumeState());
    }
  });

  it('skips a duplicate token_count after resume and keeps the model', () => {
    const lines = resumableRollout();
    const cut = lines.findIndex((entry) => entry.timestamp === at(2));
    const { events } = resumedAt(lines, cut);
    const usageEvents = events.filter((event) => extractNormalizedUsage(event));
    // Only the growth to 1600/160 is counted; the resent 1000/100 is not.
    expect(usageEvents.map((event) => extractNormalizedUsage(event)?.totalTokens)).toEqual([660]);
    expect(usageEvents[0].message?.model).toBe('gpt-5.1-codex');
    expect(events.find((event) => event.timestamp === at(4))).toMatchObject({
      message: { content: [{ name: 'ExitPlanMode' }] },
    });

    // A fresh parser has no baseline: it counts the duplicate and loses the model.
    const fresh = runRollout(new CodexRolloutParser(), lines.slice(cut));
    const freshUsage = fresh.filter((event) => extractNormalizedUsage(event));
    expect(freshUsage.map((event) => extractNormalizedUsage(event)?.totalTokens)).toEqual([
      1100, 660,
    ]);
    expect(freshUsage[0].message?.model).toBeUndefined();
  });

  it('carries metadata, context window, and rate limits', () => {
    const lines = resumableRollout();
    const { resumed } = resumedAt(lines, lines.length);
    expect(resumed.getSessionMeta()).toMatchObject({ id: 'session-1', cwd: '/w' });
    expect(resumed.getCurrentModel()).toBe('gpt-5.1-codex');
    expect(resumed.getModelContextWindow()).toBe(258_400);
    expect(resumed.getLastRateLimits()).toMatchObject({ limit_id: 'codex' });
    expect(resumed.getLastTokenUsage()).toMatchObject({ input_tokens: 600, output_tokens: 60 });
  });

  it('exports the newest entries of each table and copies, not aliases, its data', () => {
    const parser = new CodexRolloutParser();
    for (let i = 0; i < 5; i++) {
      parser.convertLine(
        line('event_msg', { type: 'exec_command_begin', call_id: `open-${i}`, command: ['ls'] }),
      );
    }
    const state = parser.exportResumeState(2);
    expect(state.pendingExecCommands.map((entry) => entry.call_id)).toEqual(['open-3', 'open-4']);
    state.pendingExecCommands[0].command.push('-la');
    expect(parser.exportResumeState().pendingExecCommands[3].command).toEqual(['ls']);
  });

  it('applies its own metadataOnly option to imported pending calls', () => {
    const lines = mixedRollout();
    const cut = lines.findIndex(
      (entry) => (entry.payload as { type?: string }).type === 'mcp_tool_call_end',
    );
    const live = new CodexRolloutParser();
    runRollout(live, lines.slice(0, cut));
    const state = live.exportResumeState();
    expect(state.pendingMcpToolCalls).toMatchObject([{ arguments: { query: 'private query' } }]);
    const scan = new CodexRolloutParser({ metadataOnly: true });
    expect(scan.importResumeState(state)).toBe(true);
    expect(scan.exportResumeState().pendingMcpToolCalls[0].arguments).toBeUndefined();
  });

  const valid = () => new CodexRolloutParser().exportResumeState();
  it.each([
    ['undefined', () => undefined],
    ['null', () => null],
    ['another version', () => ({ ...valid(), version: 2 })],
    ['a numeric model', () => ({ ...valid(), currentModel: 5 })],
    ['a negative token count', () => ({ ...valid(), prevTotalUsage: usage(-1, 0) })],
    ['a token usage without output', () => ({ ...valid(), prevTotalUsage: { input_tokens: 1 } })],
    ['a zero context window', () => ({ ...valid(), modelContextWindow: 0 })],
    ['a non-boolean plan mode', () => ({ ...valid(), inPlanMode: 'yes' })],
    ['an array session meta', () => ({ ...valid(), sessionMeta: [] })],
    ['a missing table', () => ({ ...valid(), emittedToolUseIds: undefined })],
    ['a numeric call id', () => ({ ...valid(), emittedToolUseIds: [1] })],
    ['a malformed patch entry', () => ({ ...valid(), patchExpandedToolUseIds: [['p', 'a']] })],
    [
      'a pending exec without a timestamp',
      () => ({ ...valid(), pendingExecCommands: [{ call_id: 'e', command: [] }] }),
    ],
    [
      'pending MCP arguments that are not an object',
      () => ({
        ...valid(),
        pendingMcpToolCalls: [{ call_id: 'm', tool_name: 't', arguments: 'x', timestamp: 't' }],
      }),
    ],
  ])('rejects %s and keeps its state', (_label, state) => {
    const parser = new CodexRolloutParser();
    runRollout(parser, resumableRollout());
    const before = parser.exportResumeState();
    expect(parser.importResumeState(state())).toBe(false);
    expect(parser.exportResumeState()).toEqual(before);
  });
});
