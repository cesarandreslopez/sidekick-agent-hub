import { describe, expect, it } from 'vitest';
import { CodexRolloutParser } from './codexParser';
import type { CodexRolloutLine } from '../types/codex';

function line(
  type: CodexRolloutLine['type'],
  payload: CodexRolloutLine['payload'],
  timestamp = '2026-06-01T12:00:00.000Z',
): CodexRolloutLine {
  return { timestamp, type, payload };
}

describe('CodexRolloutParser', () => {
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
          input_tokens: 1000,
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
