import { describe, it, expect } from 'vitest';
import {
  messageUsageSchema,
  sessionMessageSchema,
  sessionEventSchema,
  permissionModeSchema,
  extractSessionEvents,
} from './sessionEvent';

describe('messageUsageSchema', () => {
  it('validates a complete usage object', () => {
    const result = messageUsageSchema.safeParse({
      input_tokens: 1000,
      output_tokens: 500,
      cache_creation_input_tokens: 200,
      cache_read_input_tokens: 300,
      reported_cost: 0.01,
      reasoning_tokens: 50,
    });
    expect(result.success).toBe(true);
  });

  it('validates minimal usage (required fields only)', () => {
    const result = messageUsageSchema.safeParse({
      input_tokens: 100,
      output_tokens: 50,
    });
    expect(result.success).toBe(true);
  });

  it('rejects missing required fields', () => {
    const result = messageUsageSchema.safeParse({ input_tokens: 100 });
    expect(result.success).toBe(false);
  });

  it('rejects non-numeric tokens', () => {
    const result = messageUsageSchema.safeParse({
      input_tokens: 'foo',
      output_tokens: 50,
    });
    expect(result.success).toBe(false);
  });
});

describe('sessionMessageSchema', () => {
  it('accepts a null stop_reason from a streaming line and drops it', () => {
    const [event] = extractSessionEvents({
      type: 'assistant',
      timestamp: '2026-09-01T00:00:00.000Z',
      message: {
        role: 'assistant',
        id: 'msg_1',
        stop_reason: null,
        usage: { input_tokens: 2, output_tokens: 3 },
        content: [{ type: 'text', text: 'partial' }],
      },
    });
    expect(event?.message?.usage?.output_tokens).toBe(3);
    expect(
      event?.message && 'stop_reason' in event.message ? event.message.stop_reason : undefined,
    ).toBeUndefined();
  });

  it('validates assistant message with usage', () => {
    const result = sessionMessageSchema.safeParse({
      role: 'assistant',
      id: 'msg_123',
      model: 'claude-opus-4-20250514',
      usage: { input_tokens: 1000, output_tokens: 500 },
      content: [{ type: 'text', text: 'Hello' }],
    });
    expect(result.success).toBe(true);
  });

  it('validates minimal user message', () => {
    const result = sessionMessageSchema.safeParse({ role: 'user' });
    expect(result.success).toBe(true);
  });

  it('rejects missing role', () => {
    const result = sessionMessageSchema.safeParse({});
    expect(result.success).toBe(false);
  });
});

describe('permissionModeSchema', () => {
  it.each(['default', 'acceptEdits', 'bypassPermissions', 'plan', 'auto', 'dontAsk'] as const)(
    'accepts "%s"',
    (mode) => {
      expect(permissionModeSchema.safeParse(mode).success).toBe(true);
    },
  );

  it('rejects unknown mode', () => {
    expect(permissionModeSchema.safeParse('admin').success).toBe(false);
  });

  it('accepts the auto and dontAsk modes', () => {
    for (const mode of ['auto', 'dontAsk']) {
      const [event] = extractSessionEvents({
        type: 'user',
        timestamp: '2026-11-01T10:00:00Z',
        permissionMode: mode,
        message: { role: 'user', content: 'x' },
      });
      expect(event.permissionMode).toBe(mode);
    }
  });

  it('keeps an event whose permission mode is unknown and drops only the mode', () => {
    // A mode added by a later Claude Code release.
    const events = extractSessionEvents({
      type: 'user',
      timestamp: '2026-11-01T10:00:00Z',
      permissionMode: 'someFutureMode',
      message: { role: 'user', content: 'run the tests' },
    });
    expect(events).toHaveLength(1);
    expect(events[0].message?.content).toBe('run the tests');
    expect(events[0].permissionMode).toBeUndefined();
    const known = extractSessionEvents({
      type: 'user',
      timestamp: '2026-11-01T10:00:00Z',
      permissionMode: 'plan',
      message: { role: 'user', content: 'plan it' },
    });
    expect(known[0].permissionMode).toBe('plan');
  });
});

describe('sessionEventSchema', () => {
  it('validates a full assistant event', () => {
    const result = sessionEventSchema.safeParse({
      type: 'assistant',
      message: {
        role: 'assistant',
        model: 'claude-sonnet-4-20250514',
        usage: { input_tokens: 5000, output_tokens: 200 },
        content: [
          { type: 'text', text: 'Let me help you.' },
          { type: 'tool_use', id: 'tu_1', name: 'Read', input: { file_path: '/foo.ts' } },
        ],
      },
      timestamp: '2026-03-23T10:00:00Z',
      permissionMode: 'default',
    });
    expect(result.success).toBe(true);
  });

  it('validates a tool_result event', () => {
    const result = sessionEventSchema.safeParse({
      type: 'tool_result',
      message: { role: 'user' },
      timestamp: '2026-03-23T10:00:01Z',
      result: {
        tool_use_id: 'tu_1',
        output: 'file contents here',
        is_error: false,
      },
    });
    expect(result.success).toBe(true);
  });

  it('validates a user event with provider-origin fields', () => {
    const result = sessionEventSchema.safeParse({
      type: 'user',
      message: { role: 'user', content: 'Fix this bug' },
      timestamp: '2026-03-23T10:00:00Z',
      entrypoint: 'cli',
      isMeta: false,
      isSidechain: true,
      cwd: '/workspace/app',
      gitBranch: 'feature/provenance',
    });
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      entrypoint: 'cli',
      isMeta: false,
      isSidechain: true,
      cwd: '/workspace/app',
      gitBranch: 'feature/provenance',
    });
  });

  it('rejects invalid event type', () => {
    const result = sessionEventSchema.safeParse({
      type: 'unknown',
      message: { role: 'user' },
      timestamp: '2026-03-23T10:00:00Z',
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing timestamp', () => {
    const result = sessionEventSchema.safeParse({
      type: 'user',
      message: { role: 'user' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing message', () => {
    const result = sessionEventSchema.safeParse({
      type: 'user',
      timestamp: '2026-03-23T10:00:00Z',
    });
    expect(result.success).toBe(false);
  });

  it('accepts a message-less summary with valid compaction counts', () => {
    expect(
      sessionEventSchema.safeParse({
        type: 'summary',
        timestamp: '2026-03-23T10:00:00Z',
        compaction: { tokensBefore: 10_000, tokensAfter: 4_000 },
      }).success,
    ).toBe(true);
  });

  it.each([
    { tokensBefore: -1, tokensAfter: 0 },
    { tokensBefore: 1, tokensAfter: 2 },
    { tokensBefore: 1.5, tokensAfter: 1 },
    { tokensBefore: Number.POSITIVE_INFINITY, tokensAfter: 1 },
  ])('rejects malformed summary compaction %#', (compaction) => {
    expect(
      sessionEventSchema.safeParse({
        type: 'summary',
        timestamp: '2026-03-23T10:00:00Z',
        compaction,
      }).success,
    ).toBe(false);
  });
});

describe('extractSessionEvents', () => {
  const userEvent = {
    type: 'user',
    message: { role: 'user', content: 'Fix this bug' },
    timestamp: '2026-03-23T10:00:00Z',
  };

  it('returns a direct event as-is', () => {
    const events = extractSessionEvents(userEvent);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual(userEvent);
  });

  it('unwraps a progress-wrapped event', () => {
    const events = extractSessionEvents({
      type: 'progress',
      data: { message: userEvent },
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual(userEvent);
  });

  it('inherits provider provenance from progress wrappers with inner values taking precedence', () => {
    const events = extractSessionEvents({
      type: 'progress',
      entrypoint: 'sdk',
      isMeta: true,
      isSidechain: true,
      cwd: '/workspace/outer',
      gitBranch: 'outer-branch',
      data: {
        message: {
          ...userEvent,
          entrypoint: 'cli',
          cwd: '/workspace/inner',
        },
      },
    });

    expect(events).toEqual([
      {
        ...userEvent,
        entrypoint: 'cli',
        isMeta: true,
        isSidechain: true,
        cwd: '/workspace/inner',
        gitBranch: 'outer-branch',
      },
    ]);
  });

  it('unwraps a progress-wrapped message-less summary', () => {
    const summary = {
      type: 'summary',
      timestamp: '2026-03-23T10:00:00Z',
      compaction: { tokensBefore: 1000, tokensAfter: 400 },
    };
    expect(extractSessionEvents({ type: 'progress', data: { message: summary } })).toEqual([
      summary,
    ]);
  });

  it('unwraps doubly-nested progress envelopes', () => {
    const events = extractSessionEvents({
      type: 'progress',
      data: { message: { type: 'progress', data: { message: userEvent } } },
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual(userEvent);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['number', 42],
    ['string', 'not an event'],
    ['empty object', {}],
    ['bare progress', { type: 'progress' }],
    ['progress with empty data', { type: 'progress', data: {} }],
    ['progress with non-object message', { type: 'progress', data: { message: 'nope' } }],
    [
      'progress with invalid inner event',
      { type: 'progress', data: { message: { type: 'bogus' } } },
    ],
    ['non-progress unknown type', { type: 'file-history-snapshot' }],
  ])('returns [] for %s without throwing', (_label, raw) => {
    expect(extractSessionEvents(raw)).toEqual([]);
  });

  it('stops at the recursion bound for adversarial nesting', () => {
    let wrapped: unknown = userEvent;
    for (let i = 0; i < 20; i++) {
      wrapped = { type: 'progress', data: { message: wrapped } };
    }
    expect(extractSessionEvents(wrapped)).toEqual([]);
  });
});

describe('extractSessionEvents task-notification attachments', () => {
  // Redacted from a real Claude Code mid-turn delivery.
  const prompt =
    '<task-notification>\n<task-id>a35998d20ba7e3e9c</task-id>\n<tool-use-id>toolu_018Mg9LTJkK3QyzSHWC4bmou</tool-use-id>\n<status>completed</status>\n<summary>Agent "Explore quota pipeline" finished</summary>\n<result>Done.</result>\n</task-notification>';
  const attachmentLine = {
    parentUuid: 'cba4d532-87c8-47a2-8b98-671a5e0c54c3',
    isSidechain: false,
    type: 'attachment',
    uuid: '36c44cbe-7b20-494f-aa97-b7626679b072',
    timestamp: '2026-11-01T03:06:53.351Z',
    cwd: '/work/repo',
    gitBranch: 'main',
    rendered: [{ content: '<system-reminder>[SYSTEM NOTIFICATION - NOT USER INPUT]…' }],
    attachment: { type: 'queued_command', prompt, commandMode: 'task-notification' },
  };

  it('drops attachment lines by default, keeping both call signatures', () => {
    expect(extractSessionEvents(attachmentLine)).toEqual([]);
    expect(extractSessionEvents(attachmentLine, 0)).toEqual([]);
    expect(extractSessionEvents(attachmentLine, {})).toEqual([]);
  });

  it('turns one into a system event when opted in', () => {
    expect(extractSessionEvents(attachmentLine, { includeTaskNotifications: true })).toEqual([
      {
        type: 'system',
        timestamp: '2026-11-01T03:06:53.351Z',
        isSidechain: false,
        cwd: '/work/repo',
        gitBranch: 'main',
        origin: { kind: 'task-notification' },
        message: { role: 'user', sourceLabel: 'task notification', content: prompt },
      },
    ]);
  });

  it('ignores other attachments and malformed notifications when opted in', () => {
    const options = { includeTaskNotifications: true };
    for (const attachment of [
      { type: 'queued_command', prompt: 'next prompt', commandMode: 'prompt' },
      { type: 'queued_command', commandMode: 'task-notification' },
      { type: 'file', filename: 'a.ts' },
    ]) {
      expect(extractSessionEvents({ ...attachmentLine, attachment }, options)).toEqual([]);
    }
    expect(extractSessionEvents({ ...attachmentLine, timestamp: undefined }, options)).toEqual([]);
  });

  it('leaves ordinary events unchanged when opted in', () => {
    const user = {
      type: 'user',
      timestamp: '2026-11-01T03:40:59.938Z',
      origin: { kind: 'task-notification' },
      promptSource: 'system',
      message: { role: 'user', content: prompt },
    };
    expect(extractSessionEvents(user, { includeTaskNotifications: true })).toEqual(
      extractSessionEvents(user),
    );
  });
});

describe('extractSessionEvents background-agent settling records', () => {
  const options = { includeTaskNotifications: true };
  // Redacted from real Claude Code 2.1.296–2.1.305 lines.
  const agentsKilled = {
    parentUuid: '9c7aedaa-67c9-41fc-9409-2b67813f30f9',
    isSidechain: false,
    type: 'system',
    subtype: 'agents_killed',
    timestamp: '2026-10-21T04:01:56.057Z',
    uuid: '1a8027cc-afdc-4b60-b292-3939b98f4588',
    isMeta: false,
    entrypoint: 'cli',
    cwd: '/work/repo',
    gitBranch: 'main',
  };
  const taskStatusLine = (status: string, taskType = 'local_agent') => ({
    parentUuid: '0bb9e329-4b47-48ea-8694-732f36f70846',
    isSidechain: false,
    type: 'attachment',
    uuid: 'e837ec3d-86c6-4dc1-8bac-894a2f05dae3',
    timestamp: '2026-10-08T17:11:21.085Z',
    cwd: '/work/repo',
    attachment: {
      type: 'task_status',
      taskId: 'a8022858222a8d9b1',
      taskType,
      description: 'Second-pass grep engine fixes',
      status,
      deltaSummary: null,
      outputFilePath: '/tmp/tasks/a8022858222a8d9b1.output',
      canContinueAgent: true,
    },
  });

  it('keeps the subtype of system lines, with or without the opt-in', () => {
    const expected = [
      {
        type: 'system',
        subtype: 'agents_killed',
        timestamp: '2026-10-21T04:01:56.057Z',
        isSidechain: false,
        isMeta: false,
        entrypoint: 'cli',
        cwd: '/work/repo',
        gitBranch: 'main',
      },
    ];
    expect(extractSessionEvents(agentsKilled)).toEqual(expected);
    expect(extractSessionEvents(agentsKilled, options)).toEqual(expected);
  });

  it('drops a malformed subtype instead of the line', () => {
    expect(extractSessionEvents({ ...agentsKilled, subtype: 7 })).toEqual([
      expect.not.objectContaining({ subtype: expect.anything() }),
    ]);
    expect(extractSessionEvents({ ...agentsKilled, subtype: 7 })).toHaveLength(1);
  });

  it('turns a final background-agent task_status into a system event when opted in', () => {
    expect(extractSessionEvents(taskStatusLine('completed'))).toEqual([]);
    expect(extractSessionEvents(taskStatusLine('completed'), options)).toEqual([
      {
        type: 'system',
        timestamp: '2026-10-08T17:11:21.085Z',
        isSidechain: false,
        cwd: '/work/repo',
        origin: { kind: 'task-status' },
        message: {
          role: 'system',
          sourceLabel: 'task status',
          content: [
            {
              type: 'task_status',
              taskId: 'a8022858222a8d9b1',
              taskType: 'local_agent',
              status: 'completed',
              description: 'Second-pass grep engine fixes',
            },
          ],
        },
      },
    ]);
  });

  it('ignores running statuses and background shell tasks', () => {
    expect(extractSessionEvents(taskStatusLine('running'), options)).toEqual([]);
    expect(extractSessionEvents(taskStatusLine('completed', 'local_bash'), options)).toEqual([]);
  });

  it('turns the plain-text stop notice into a task-notification system event', () => {
    const prompt =
      '2 background agents were stopped by the user: "Fact-check draft proposal claims", "Infra: hosted Hub DB roles and rollout".';
    const [event] = extractSessionEvents(
      {
        type: 'attachment',
        timestamp: '2026-10-12T22:35:58.442Z',
        attachment: { type: 'queued_command', prompt, commandMode: 'task-notification' },
      },
      options,
    );
    expect(event).toMatchObject({
      type: 'system',
      origin: { kind: 'task-notification' },
      message: { content: prompt },
    });
  });
});
