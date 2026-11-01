/**
 * Redacted rollouts in the shape Codex 0.166 writes for multi-agent sessions:
 * a parent that spawns a child (`spawn_agent` → `SubAgentActivity` started →
 * `{"task_name": …}` output → MESSAGE / FINAL_ANSWER agent messages →
 * `completed`), a failed spawn, `followup_task` / `send_message` /
 * `interrupt_agent` interactions, and a forked child whose rollout embeds the
 * parent's history (and session_meta) before its
 * `subagent_history_start_ordinal`, which itself spawns a grandchild.
 * Payload text is placeholder; ids are synthetic.
 *
 * Test-only helpers.
 *
 * @module testing/codexSubagentFixtures
 */

export type CodexFixtureRow = Record<string, unknown>;

export const PARENT_ID = '01a18f87-0000-7000-8000-000000000001';
export const CHILD_ID = '01a18f9d-0000-7000-8000-000000000002';
export const GRANDCHILD_ID = '01a18fa0-0000-7000-8000-000000000003';
export const CALL_SPAWN = 'call_spawn_builder';
export const CALL_SPAWN_FAILED = 'call_spawn_failed';
export const CALL_FOLLOWUP = 'call_followup_builder';
export const CALL_SEND = 'call_send_builder';
export const CALL_INTERRUPT = 'call_interrupt_builder';
export const CALL_SPAWN_GRANDCHILD = 'call_spawn_deep_dive';
export const CHILD_TURN_ID = '01a18f9d-0000-7000-8000-0000000000t1';
export const CHILD_PATH = '/root/review_builder';
export const GRANDCHILD_PATH = '/root/review_builder/deep_dive';

/** `2026-10-31T01:<minute>:<second>.000Z`. */
export function at(minute: number, second = 0): string {
  return `2026-10-31T01:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}.000Z`;
}

function numbered(rows: CodexFixtureRow[]): CodexFixtureRow[] {
  return rows.map((row, ordinal) => ({ timestamp: row.timestamp, ordinal, ...row }));
}

function tokenCount(timestamp: string, total: number, last: number): CodexFixtureRow {
  return {
    timestamp,
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: { input_tokens: total, output_tokens: 0, total_tokens: total },
        last_token_usage: { input_tokens: last, output_tokens: 0, total_tokens: last },
      },
    },
  };
}

function functionCall(
  timestamp: string,
  callId: string,
  name: string,
  args: Record<string, unknown>,
  namespace: string | undefined = 'collaboration',
): CodexFixtureRow {
  return {
    timestamp,
    type: 'response_item',
    payload: {
      type: 'function_call',
      status: 'completed',
      id: `fc_${callId}`,
      name,
      ...(namespace ? { namespace } : {}),
      arguments: JSON.stringify(args),
      call_id: callId,
    },
  };
}

function output(timestamp: string, callId: string, text: string): CodexFixtureRow {
  return {
    timestamp,
    type: 'response_item',
    payload: { type: 'function_call_output', call_id: callId, output: text },
  };
}

function activity(
  timestamp: string,
  threadId: string,
  item: Record<string, unknown>,
): CodexFixtureRow {
  return {
    timestamp,
    type: 'event_msg',
    payload: {
      type: 'item_completed',
      thread_id: threadId,
      turn_id: `${threadId}-turn`,
      item: { type: 'SubAgentActivity', model: null, reasoning_effort: null, ...item },
    },
  };
}

function agentMessage(
  timestamp: string,
  id: string,
  author: string,
  recipient: string,
  messageType: string,
  payload: string,
): CodexFixtureRow {
  return {
    timestamp,
    type: 'response_item',
    payload: {
      type: 'agent_message',
      id,
      author,
      recipient,
      content: [
        {
          type: 'input_text',
          text: `Message Type: ${messageType}\nTask name: ${recipient}\nSender: ${author}\nPayload:\n${payload}`,
        },
        ...(payload ? [] : [{ type: 'encrypted_content', encrypted_content: 'gAAAA-redacted' }]),
      ],
    },
  };
}

function exec(timestamp: string, callId: string): CodexFixtureRow {
  return functionCall(timestamp, callId, 'exec_command', { cmd: 'rg TODO' }, undefined);
}

export interface ParentFixtureOptions {
  cwd: string;
  /** Leave out the `SubAgentActivity` records (as before Codex recorded them). */
  withoutActivity?: boolean;
  /** Leave out the `completed` record (Codex before 0.150). */
  withoutCompleted?: boolean;
}

/** The parent session's rollout (ordinals 0…). */
export function parentRollout(options: ParentFixtureOptions): CodexFixtureRow[] {
  const rows: Array<CodexFixtureRow | null> = [
    {
      timestamp: at(15),
      type: 'session_meta',
      payload: {
        id: PARENT_ID,
        session_id: PARENT_ID,
        timestamp: at(15),
        cwd: options.cwd,
        originator: 'codex-tui',
        cli_version: '0.166.0',
        source: 'vscode',
        thread_source: 'user',
        history_mode: 'paginated',
        base_instructions: { text: 'Parent base instructions.' },
      },
    },
    {
      timestamp: at(15, 1),
      type: 'turn_context',
      payload: { model: 'gpt-test', cwd: options.cwd },
    },
    {
      timestamp: at(15, 2),
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'Review the builder.' }],
      },
    },
    tokenCount(at(15, 3), 1000, 1000),
    functionCall(at(40, 33), CALL_SPAWN, 'spawn_agent', {
      task_name: 'review_builder',
      message: 'gAAAA-redacted',
    }),
    options.withoutActivity
      ? null
      : activity(at(40, 33), PARENT_ID, {
          id: CALL_SPAWN,
          kind: 'started',
          model: 'gpt-test',
          reasoning_effort: 'high',
          agent_thread_id: CHILD_ID,
          agent_path: CHILD_PATH,
        }),
    output(at(40, 34), CALL_SPAWN, JSON.stringify({ task_name: CHILD_PATH })),
    functionCall(at(40, 35), CALL_SPAWN_FAILED, 'spawn_agent', {
      task_name: 'review_extra',
      message: 'gAAAA-redacted',
    }),
    output(at(40, 35), CALL_SPAWN_FAILED, 'collab spawn failed: agent thread limit reached'),
    {
      timestamp: at(41, 8),
      type: 'inter_agent_communication_metadata',
      payload: { trigger_turn: false },
    },
    agentMessage(at(41, 8), 'amsg_progress', CHILD_PATH, '/root', 'MESSAGE', ''),
    options.withoutActivity || options.withoutCompleted
      ? null
      : activity(at(42, 21), PARENT_ID, {
          id: `subagent-completed-${CHILD_TURN_ID}`,
          kind: 'completed',
          agent_thread_id: CHILD_ID,
          agent_path: CHILD_PATH,
        }),
    agentMessage(
      at(42, 25),
      'amsg_final',
      CHILD_PATH,
      '/root',
      'FINAL_ANSWER',
      'Found two issues.',
    ),
    functionCall(at(45, 37), CALL_FOLLOWUP, 'followup_task', {
      target: 'review_builder',
      message: 'gAAAA-redacted',
    }),
    options.withoutActivity
      ? null
      : activity(at(45, 37), PARENT_ID, {
          id: CALL_FOLLOWUP,
          kind: 'interacted',
          agent_thread_id: CHILD_ID,
          agent_path: CHILD_PATH,
        }),
    output(at(45, 38), CALL_FOLLOWUP, ''),
    functionCall(at(45, 40), CALL_SEND, 'send_message', {
      target: 'review_builder',
      message: 'gAAAA-redacted',
    }),
    options.withoutActivity
      ? null
      : activity(at(45, 40), PARENT_ID, {
          id: CALL_SEND,
          kind: 'interacted',
          agent_thread_id: CHILD_ID,
          agent_path: CHILD_PATH,
        }),
    functionCall(at(46, 0), CALL_INTERRUPT, 'interrupt_agent', { target: 'review_builder' }),
    options.withoutActivity
      ? null
      : activity(at(46, 0), PARENT_ID, {
          id: CALL_INTERRUPT,
          kind: 'interrupted',
          agent_thread_id: CHILD_ID,
          agent_path: CHILD_PATH,
        }),
    tokenCount(at(46, 5), 2000, 1000),
  ];
  return numbered(rows.filter((row): row is CodexFixtureRow => row !== null));
}

/** Records the child inherits from the parent (re-stamped at fork time, as Codex does). */
const INHERITED_RECORDS = 5;

/** The forked child's rollout: its meta, the parent's history, then its own records. */
export function childRollout(options: { cwd: string }): CodexFixtureRow[] {
  const start = 1 + INHERITED_RECORDS;
  return numbered([
    {
      timestamp: at(40, 33),
      type: 'session_meta',
      payload: {
        id: CHILD_ID,
        session_id: PARENT_ID,
        forked_from_id: PARENT_ID,
        parent_thread_id: PARENT_ID,
        timestamp: at(40, 33),
        cwd: options.cwd,
        originator: 'codex-tui',
        cli_version: '0.166.0',
        source: {
          subagent: {
            thread_spawn: {
              parent_thread_id: PARENT_ID,
              depth: 1,
              agent_path: CHILD_PATH,
              agent_nickname: 'Banach',
              agent_role: null,
            },
          },
        },
        thread_source: 'subagent',
        agent_nickname: 'Banach',
        agent_path: CHILD_PATH,
        history_mode: 'paginated',
        subagent_history_start_ordinal: start,
        multi_agent_version: 'v2',
      },
    },
    // The parent's history, embedded by the fork.
    {
      timestamp: at(40, 33),
      type: 'session_meta',
      payload: {
        id: PARENT_ID,
        timestamp: at(15),
        cwd: '/somewhere/else',
        source: 'vscode',
        base_instructions: { text: 'Parent base instructions.' },
      },
    },
    { timestamp: at(40, 33), type: 'turn_context', payload: { model: 'gpt-parent' } },
    exec(at(40, 33), 'call_parent_exec'),
    tokenCount(at(40, 33), 5000, 5000),
    {
      timestamp: at(40, 33),
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'developer',
        content: [{ type: 'input_text', text: 'You are now a newly spawned child agent.' }],
      },
    },
    // The child's own records.
    {
      timestamp: at(40, 34),
      type: 'event_msg',
      payload: { type: 'task_started', turn_id: CHILD_TURN_ID },
    },
    { timestamp: at(40, 34), type: 'turn_context', payload: { model: 'gpt-test' } },
    exec(at(40, 35), 'call_child_exec'),
    output(at(40, 36), 'call_child_exec', 'Process exited with code 0'),
    tokenCount(at(40, 37), 300, 300),
    functionCall(at(40, 38), CALL_SPAWN_GRANDCHILD, 'spawn_agent', {
      task_name: 'deep_dive',
      message: 'gAAAA-redacted',
    }),
    activity(at(40, 38), CHILD_ID, {
      id: CALL_SPAWN_GRANDCHILD,
      kind: 'started',
      agent_thread_id: GRANDCHILD_ID,
      agent_path: GRANDCHILD_PATH,
    }),
    output(at(40, 39), CALL_SPAWN_GRANDCHILD, JSON.stringify({ task_name: GRANDCHILD_PATH })),
    tokenCount(at(42, 20), 500, 200),
  ]);
}

/** The grandchild's rollout (depth 2): a fork of the child. */
export function grandchildRollout(options: { cwd: string }): CodexFixtureRow[] {
  return numbered([
    {
      timestamp: at(40, 38),
      type: 'session_meta',
      payload: {
        id: GRANDCHILD_ID,
        session_id: PARENT_ID,
        forked_from_id: CHILD_ID,
        parent_thread_id: CHILD_ID,
        timestamp: at(40, 38),
        cwd: options.cwd,
        cli_version: '0.166.0',
        source: {
          subagent: {
            thread_spawn: {
              parent_thread_id: CHILD_ID,
              depth: 2,
              agent_path: GRANDCHILD_PATH,
              agent_nickname: 'Noether',
              agent_role: 'explorer',
            },
          },
        },
        thread_source: 'subagent',
        agent_nickname: 'Noether',
        agent_path: GRANDCHILD_PATH,
        agent_role: 'explorer',
        subagent_history_start_ordinal: 3,
      },
    },
    { timestamp: at(40, 38), type: 'session_meta', payload: { id: CHILD_ID, cwd: options.cwd } },
    exec(at(40, 38), 'call_child_exec'),
    exec(at(40, 40), 'call_grandchild_exec'),
    tokenCount(at(40, 41), 50, 50),
  ]);
}

/** Rows as JSONL text. */
export function toJsonl(rows: CodexFixtureRow[]): string {
  return rows.map((row) => JSON.stringify(row)).join('\n') + '\n';
}
