import { describe, expect, it } from 'vitest';
import type { SessionEvent } from '../types/sessionEvent';
import { CodexRolloutParser } from './codexParser';

const ts = (second: number) => `2026-11-01T10:00:${String(second).padStart(2, '0')}.000Z`;

function convert(rows: Array<Record<string, unknown>>): SessionEvent[] {
  const parser = new CodexRolloutParser({ includeTurnLifecycle: true });
  return rows.flatMap((row) => parser.convertLine(row as never));
}

function results(events: SessionEvent[]): SessionEvent[] {
  return events.filter(
    (event) =>
      Array.isArray(event.message?.content) &&
      (event.message?.content as Array<{ type?: string }>).some(
        (block) => block.type === 'tool_result',
      ),
  );
}

describe('Codex parser: activity signals', () => {
  it('marks a declined command as refused by the user', () => {
    const events = convert([
      {
        timestamp: ts(1),
        type: 'event_msg',
        payload: { type: 'exec_command_begin', call_id: 'c1', command: ['rm', 'x'] },
      },
      {
        timestamp: ts(2),
        type: 'event_msg',
        payload: { type: 'exec_command_end', call_id: 'c1', exit_code: -1, status: 'declined' },
      },
    ]);
    const [result] = results(events);
    expect(result.permissionDecision).toEqual({ decision: 'reject', source: 'user_reject' });
    expect((result.message?.content as Array<{ is_error?: boolean }>)[0].is_error).toBe(true);
  });

  it('marks a declined patch on each of its files, and a failed one as an error', () => {
    const patch = (callId: string) => ({
      timestamp: ts(3),
      type: 'response_item',
      payload: {
        type: 'custom_tool_call',
        call_id: callId,
        name: 'apply_patch',
        input: '*** Update File: a.ts\n*** Update File: b.ts\n',
      },
    });
    const output = (callId: string) => ({
      timestamp: ts(5),
      type: 'response_item',
      payload: {
        type: 'custom_tool_call_output',
        call_id: callId,
        output: '{"metadata":{"exit_code":0}}',
      },
    });
    const events = convert([
      patch('p1'),
      {
        timestamp: ts(4),
        type: 'event_msg',
        payload: { type: 'patch_apply_end', call_id: 'p1', status: 'declined' },
      },
      output('p1'),
      patch('p2'),
      {
        timestamp: ts(4),
        type: 'event_msg',
        payload: { type: 'patch_apply_end', call_id: 'p2', success: false },
      },
      output('p2'),
    ]);
    const declined = results(events).filter((event) => JSON.stringify(event).includes('p1-'));
    expect(declined).toHaveLength(2);
    for (const event of declined) expect(event.permissionDecision?.decision).toBe('reject');
    const failed = results(events).filter((event) => JSON.stringify(event).includes('p2-'));
    for (const event of failed) {
      expect(event.permissionDecision).toBeUndefined();
      expect((event.message?.content as Array<{ is_error?: boolean }>)[0].is_error).toBe(true);
    }
  });

  it('tags a patch fan-out with its call id and file count', () => {
    const events = convert([
      {
        timestamp: ts(1),
        type: 'response_item',
        payload: {
          type: 'custom_tool_call',
          call_id: 'p9',
          name: 'apply_patch',
          input: '*** Update File: a.ts\n*** Add File: b.ts\n*** Delete File: c.ts\n',
        },
      },
    ]);
    const inputs = events.map(
      (event) => (event.message?.content as Array<{ input: Record<string, unknown> }>)[0].input,
    );
    expect(inputs).toHaveLength(3);
    for (const input of inputs) {
      expect(input).toMatchObject({ _sidekickPatchCallId: 'p9', _sidekickPatchFileCount: 3 });
    }
  });

  it('records a function call’s namespace, and the MCP server of an mcp__ namespace', () => {
    const [mcp, collaboration] = convert([
      {
        timestamp: ts(1),
        type: 'response_item',
        payload: {
          type: 'function_call',
          call_id: 'f1',
          name: 'js',
          namespace: 'mcp__cua_repl',
          arguments: '{}',
        },
      },
      {
        timestamp: ts(2),
        type: 'response_item',
        payload: {
          type: 'function_call',
          call_id: 'f2',
          name: 'spawn_agent',
          namespace: 'collaboration',
          arguments: '{}',
        },
      },
    ]);
    const input = (event: SessionEvent) =>
      (event.message?.content as Array<{ input: Record<string, unknown> }>)[0].input;
    expect(input(mcp)).toMatchObject({
      _sidekickNamespace: 'mcp__cua_repl',
      _sidekickMcpServerName: 'cua_repl',
    });
    expect(input(collaboration)).toMatchObject({ _sidekickNamespace: 'collaboration' });
    expect(input(collaboration)._sidekickMcpServerName).toBeUndefined();
  });

  it('carries the model context window on token counts', () => {
    const [event] = convert([
      {
        timestamp: ts(1),
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 },
            last_token_usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 },
            model_context_window: 387600,
          },
        },
      },
    ]);
    expect(event.providerMetadata).toMatchObject({
      providerId: 'codex',
      contextWindowTokens: 387600,
    });
  });

  it('keeps metadata-only parsing content-free with the new keys', () => {
    const parser = new CodexRolloutParser({ metadataOnly: true });
    const [event] = parser.convertLine({
      timestamp: ts(1),
      type: 'response_item',
      payload: {
        type: 'function_call',
        call_id: 'f1',
        name: 'js',
        namespace: 'mcp__srv',
        arguments: '{"code":"SKCANARY"}',
      },
    } as never);
    const input = (event.message?.content as Array<{ input: Record<string, unknown> }>)[0].input;
    expect(input._sidekickMcpServerName).toBe('srv');
    expect(JSON.stringify(event)).not.toContain('SKCANARY');
  });
});
