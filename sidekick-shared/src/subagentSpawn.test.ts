import { describe, expect, it } from 'vitest';
import {
  SUBAGENT_SPAWN_TOOL_NAMES,
  agentsStoppedNoticeFromEvent,
  contentText,
  isAgentsKilledSystemEvent,
  isCodexSubagentSpawnTool,
  isSubagentSpawnTool,
  isTaskStatusSystemEvent,
  parseAgentsStoppedNotice,
  parseCodexSpawnLaunch,
  taskStatusFromAttachment,
  taskStatusFromEvent,
  isTaskNotificationSystemEvent,
  parseAsyncAgentLaunch,
  parseTaskNotification,
  taskNotificationFromEvent,
  taskNotificationOutcome,
  taskNotificationPromptFromAttachment,
} from './subagentSpawn';
import { isAssistantTurnSubagentTool } from './turns/assistantTurn';
import type { SessionEvent } from './types/sessionEvent';

// Redacted from real Claude Code 2.1.3xx transcripts.
const ASYNC_LAUNCH_TEXT = [
  'Async agent launched successfully. (This tool result is internal metadata — never quote or paste any part of it, including the agentId below, into a user-facing reply.)',
  "agentId: a35998d20ba7e3e9c (internal ID - do not mention to user. Use SendMessage with to: 'a35998d20ba7e3e9c', summary: '<5-10 word recap>' to continue this agent.)",
  'The agent is working in the background. You will be notified automatically when it completes.',
  'output_file: /tmp/claude/session/tasks/a35998d20ba7e3e9c.output',
].join('\n');

const AGENT_NOTIFICATION = [
  '<task-notification>',
  '<task-id>a35998d20ba7e3e9c</task-id>',
  '<tool-use-id>toolu_018Mg9LTJkK3QyzSHWC4bmou</tool-use-id>',
  '<output-file>/tmp/claude/session/tasks/a35998d20ba7e3e9c.output</output-file>',
  '<status>completed</status>',
  '<summary>Agent "Explore quota pipeline" finished</summary>',
  '<note>A task-notification fires each time this agent stops with no live background children of its own.</note>',
  '<result>I traced the quota. Quoted markup like <status>failed</status> and <task-id>zzz</task-id> stays in the result.</result>',
  '<usage><subagent_tokens>164192</subagent_tokens><tool_uses>48</tool_uses></usage>',
  '</task-notification>',
].join('\n');

const INTERIM_NOTIFICATION = [
  '<task-notification>',
  '<task-id>abc37979f551d7e72</task-id>',
  '<tool-use-id>toolu_01A33gB4uTwmShz536Ly5Nri</tool-use-id>',
  '<status>completed</status>',
  '<summary>Agent "Fix outage bug" is waiting on its own background work</summary>',
  '<note>This agent stopped with background work of its own still running. It may resume on its own when that work completes or reports, and the same task-id notifies again if it does; the result below may be interim.</note>',
  "<result>CI is running. I'm waiting for the checks to finish.</result>",
  '</task-notification>',
].join('\n');

const BASH_NOTIFICATION = [
  '<task-notification>',
  '<task-id>bz5gt6jc3</task-id>',
  '<tool-use-id>toolu_011NGRK3gk5Dr2MPC358wepG</tool-use-id>',
  '<output-file>/tmp/claude/session/tasks/bz5gt6jc3.output</output-file>',
  '<status>completed</status>',
  '<summary>Background command "Watch the release workflow" completed (exit code 0)</summary>',
  '</task-notification>',
].join('\n');

describe('isSubagentSpawnTool', () => {
  it('accepts Agent, its earlier name Task, and Codex spawn_agent', () => {
    expect(SUBAGENT_SPAWN_TOOL_NAMES).toEqual(['Agent', 'Task']);
    expect(isSubagentSpawnTool('Agent')).toBe(true);
    expect(isSubagentSpawnTool('Task')).toBe(true);
    expect(isSubagentSpawnTool('Spawn_agent')).toBe(true);
    expect(isSubagentSpawnTool('spawn_agent')).toBe(true);
    for (const name of ['TaskCreate', 'TaskUpdate', 'agent', 'task', 'Bash', '', undefined, null]) {
      expect(isSubagentSpawnTool(name)).toBe(false);
    }
  });

  it('recognizes Codex spawn_agent by its raw name in the input', () => {
    expect(isCodexSubagentSpawnTool('Renamed', { _sidekickRawToolName: 'spawn_agent' })).toBe(true);
    expect(isSubagentSpawnTool('Renamed', { _sidekickRawToolName: 'spawn_agent' })).toBe(true);
    expect(isCodexSubagentSpawnTool('Agent')).toBe(false);
    expect(
      isCodexSubagentSpawnTool('Followup_task', { _sidekickRawToolName: 'followup_task' }),
    ).toBe(false);
  });

  it('backs isAssistantTurnSubagentTool with the Claude names only', () => {
    expect(isAssistantTurnSubagentTool('Agent')).toBe(true);
    expect(isAssistantTurnSubagentTool('Task')).toBe(true);
    expect(isAssistantTurnSubagentTool('Spawn_agent')).toBe(false);
    expect(isAssistantTurnSubagentTool('Read')).toBe(false);
    expect(isAssistantTurnSubagentTool(undefined)).toBe(false);
  });
});

describe('parseCodexSpawnLaunch', () => {
  it('reads the agent path from a spawn_agent result', () => {
    expect(parseCodexSpawnLaunch('{"task_name":"/root/review_builder"}')).toEqual({
      agentPath: '/root/review_builder',
    });
    expect(parseCodexSpawnLaunch({ task_name: '/root/x' })).toEqual({ agentPath: '/root/x' });
    expect(parseCodexSpawnLaunch([{ type: 'text', text: '{"task_name":"/root/y"}' }])).toEqual({
      agentPath: '/root/y',
    });
  });

  it('rejects anything else', () => {
    for (const value of [
      '',
      'collab spawn failed: agent thread limit reached',
      '{"other":1}',
      '{not json',
      '["task_name"]',
      null,
      42,
    ]) {
      expect(parseCodexSpawnLaunch(value)).toBeNull();
    }
  });
});

describe('parseAgentsStoppedNotice', () => {
  it('parses the plural queued-command notice', () => {
    expect(
      parseAgentsStoppedNotice(
        '2 background agents were stopped by the user: "Fact-check draft proposal claims", "Infra: hosted Hub DB roles and rollout".',
      ),
    ).toEqual({
      descriptions: ['Fact-check draft proposal claims', 'Infra: hosted Hub DB roles and rollout'],
    });
  });

  it('parses the singular queue-operation notice', () => {
    expect(
      parseAgentsStoppedNotice(
        'Background agent "MCP client repo identity at upload" was stopped by the user.',
      ),
    ).toEqual({ descriptions: ['MCP client repo identity at upload'] });
    expect(parseAgentsStoppedNotice('1 background agent was stopped by the user: "Solo".')).toEqual(
      {
        descriptions: ['Solo'],
      },
    );
  });

  it('rejects other text', () => {
    for (const text of [
      'The user stopped the build.',
      '<task-notification><task-id>a</task-id></task-notification>',
      '2 background agents were stopped by the user:',
      undefined,
    ]) {
      expect(parseAgentsStoppedNotice(text)).toBeNull();
    }
  });

  it('reads the notice from an opt-in task-notification system event only', () => {
    const event: SessionEvent = {
      type: 'system',
      timestamp: '2026-10-12T22:35:58.442Z',
      origin: { kind: 'task-notification' },
      message: {
        role: 'user',
        sourceLabel: 'task notification',
        content: '1 background agent was stopped by the user: "Solo".',
      },
    };
    expect(agentsStoppedNoticeFromEvent(event)).toEqual({ descriptions: ['Solo'] });
    expect(agentsStoppedNoticeFromEvent({ ...event, origin: undefined })).toBeNull();
  });
});

describe('agents_killed and task_status records', () => {
  it('recognizes agents_killed system lines and events', () => {
    expect(isAgentsKilledSystemEvent({ type: 'system', subtype: 'agents_killed' })).toBe(true);
    expect(isAgentsKilledSystemEvent({ type: 'system', subtype: 'turn_duration' })).toBe(false);
    expect(isAgentsKilledSystemEvent({ type: 'user', subtype: 'agents_killed' })).toBe(false);
    expect(isAgentsKilledSystemEvent(null)).toBe(false);
  });

  it('reads background-agent task_status attachments, not shell tasks', () => {
    const line = {
      type: 'attachment',
      timestamp: '2026-10-08T17:11:21.085Z',
      attachment: {
        type: 'task_status',
        taskId: 'a8022858222a8d9b1',
        taskType: 'local_agent',
        description: 'Second-pass grep engine fixes',
        status: 'completed',
        deltaSummary: null,
        canContinueAgent: true,
      },
    };
    expect(taskStatusFromAttachment(line)).toEqual({
      taskId: 'a8022858222a8d9b1',
      taskType: 'local_agent',
      status: 'completed',
      description: 'Second-pass grep engine fixes',
    });
    expect(
      taskStatusFromAttachment({
        ...line,
        attachment: { ...line.attachment, taskType: 'local_bash' },
      }),
    ).toBeNull();
    expect(taskStatusFromAttachment({ ...line, type: 'user' })).toBeNull();
  });

  it('reads the opt-in task-status system event', () => {
    const event: SessionEvent = {
      type: 'system',
      timestamp: '2026-10-08T17:11:21.085Z',
      origin: { kind: 'task-status' },
      message: {
        role: 'system',
        sourceLabel: 'task status',
        content: [
          { type: 'task_status', taskId: 'abc', taskType: 'local_agent', status: 'killed' },
        ],
      },
    };
    expect(isTaskStatusSystemEvent(event)).toBe(true);
    expect(taskStatusFromEvent(event)).toEqual({
      taskId: 'abc',
      taskType: 'local_agent',
      status: 'killed',
    });
    expect(taskStatusFromEvent({ ...event, origin: { kind: 'task-notification' } })).toBeNull();
  });
});

describe('parseAsyncAgentLaunch', () => {
  it('reads the agent id from string or content-block results', () => {
    expect(parseAsyncAgentLaunch(ASYNC_LAUNCH_TEXT)).toEqual({ agentId: 'a35998d20ba7e3e9c' });
    expect(parseAsyncAgentLaunch([{ type: 'text', text: ASYNC_LAUNCH_TEXT }])).toEqual({
      agentId: 'a35998d20ba7e3e9c',
    });
  });

  it('recognizes a launch without an id line', () => {
    expect(parseAsyncAgentLaunch('Async agent launched successfully.')).toEqual({});
  });

  it('rejects foreground results and unrelated text', () => {
    expect(parseAsyncAgentLaunch('Found 3 files. agentId: a1')).toBeNull();
    expect(parseAsyncAgentLaunch([{ type: 'text', text: 'All tests pass.' }])).toBeNull();
    expect(parseAsyncAgentLaunch(undefined)).toBeNull();
    expect(parseAsyncAgentLaunch({ status: 'async_launched' })).toBeNull();
  });
});

describe('parseTaskNotification', () => {
  it('reads the header fields and ignores markup inside <result>', () => {
    expect(parseTaskNotification(AGENT_NOTIFICATION)).toEqual({
      taskId: 'a35998d20ba7e3e9c',
      toolUseId: 'toolu_018Mg9LTJkK3QyzSHWC4bmou',
      status: 'completed',
      summary: 'Agent "Explore quota pipeline" finished',
      interim: false,
    });
  });

  it('tolerates whitespace, newlines, and a missing closing tag', () => {
    const text =
      '  <task-notification>\n  <task-id>\n  a1\n  </task-id>\n\n<status> failed </status>\n<unknown-field>x</unknown-field>';
    expect(parseTaskNotification(text)).toEqual({ taskId: 'a1', status: 'failed', interim: false });
  });

  it('tolerates missing optional fields', () => {
    expect(
      parseTaskNotification('<task-notification><task-id>a2</task-id></task-notification>'),
    ).toEqual({ taskId: 'a2', interim: false });
  });

  it('flags an agent waiting on its own background work as interim', () => {
    expect(parseTaskNotification(INTERIM_NOTIFICATION)).toMatchObject({
      taskId: 'abc37979f551d7e72',
      status: 'completed',
      interim: true,
    });
  });

  it('parses background shell notifications too', () => {
    expect(parseTaskNotification(BASH_NOTIFICATION)).toMatchObject({
      taskId: 'bz5gt6jc3',
      toolUseId: 'toolu_011NGRK3gk5Dr2MPC358wepG',
      interim: false,
    });
  });

  it('rejects text without a block or a task id', () => {
    expect(parseTaskNotification('Agent finished')).toBeNull();
    expect(parseTaskNotification('<task-notification><status>completed</status>')).toBeNull();
    expect(parseTaskNotification(42)).toBeNull();
  });
});

describe('taskNotificationOutcome', () => {
  it('maps known statuses and reads unknown ones as completed', () => {
    expect(taskNotificationOutcome('failed')).toBe('failed');
    expect(taskNotificationOutcome('killed')).toBe('killed');
    expect(taskNotificationOutcome('STOPPED')).toBe('stopped');
    expect(taskNotificationOutcome('completed')).toBe('completed');
    expect(taskNotificationOutcome('paused')).toBe('completed');
    expect(taskNotificationOutcome(undefined)).toBe('completed');
  });
});

describe('task notification events', () => {
  const userLine: SessionEvent = {
    type: 'user',
    timestamp: '2026-11-01T03:40:59.938Z',
    origin: { kind: 'task-notification' },
    promptSource: 'system',
    message: { role: 'user', content: AGENT_NOTIFICATION },
  };

  it('reads a user line flagged by origin or starting with the block', () => {
    expect(taskNotificationFromEvent(userLine)?.taskId).toBe('a35998d20ba7e3e9c');
    const unflagged: SessionEvent = { ...userLine, origin: undefined };
    expect(taskNotificationFromEvent(unflagged)?.taskId).toBe('a35998d20ba7e3e9c');
    const blocks: SessionEvent = {
      ...unflagged,
      message: { role: 'user', content: [{ type: 'text', text: AGENT_NOTIFICATION }] },
    };
    expect(taskNotificationFromEvent(blocks)?.taskId).toBe('a35998d20ba7e3e9c');
  });

  it('ignores prompts that merely mention a notification', () => {
    const typed: SessionEvent = {
      type: 'user',
      timestamp: '2026-11-01T00:00:00Z',
      message: { role: 'user', content: `Why did this arrive?\n${AGENT_NOTIFICATION}` },
    };
    expect(taskNotificationFromEvent(typed)).toBeNull();
    const assistant: SessionEvent = { ...typed, type: 'assistant' };
    expect(taskNotificationFromEvent(assistant)).toBeNull();
  });

  it('reads only flagged system events', () => {
    const system: SessionEvent = {
      type: 'system',
      timestamp: '2026-11-01T03:06:53.351Z',
      origin: { kind: 'task-notification' },
      message: { role: 'user', content: AGENT_NOTIFICATION },
    };
    expect(isTaskNotificationSystemEvent(system)).toBe(true);
    expect(taskNotificationFromEvent(system)?.toolUseId).toBe('toolu_018Mg9LTJkK3QyzSHWC4bmou');
    const plain: SessionEvent = { ...system, origin: undefined };
    expect(isTaskNotificationSystemEvent(plain)).toBe(false);
    expect(taskNotificationFromEvent(plain)).toBeNull();
    expect(isTaskNotificationSystemEvent(userLine)).toBe(false);
  });

  it('reads the prompt of a queued task-notification attachment line', () => {
    const line = {
      type: 'attachment',
      timestamp: '2026-11-01T03:06:53.351Z',
      attachment: {
        type: 'queued_command',
        commandMode: 'task-notification',
        prompt: AGENT_NOTIFICATION,
      },
    };
    expect(taskNotificationPromptFromAttachment(line)).toBe(AGENT_NOTIFICATION);
    expect(
      taskNotificationPromptFromAttachment({
        ...line,
        attachment: { ...line.attachment, commandMode: 'prompt' },
      }),
    ).toBeNull();
    expect(
      taskNotificationPromptFromAttachment({ type: 'attachment', attachment: { type: 'file' } }),
    ).toBeNull();
    expect(taskNotificationPromptFromAttachment({ type: 'user' })).toBeNull();
    expect(taskNotificationPromptFromAttachment(null)).toBeNull();
  });

  it('joins text blocks for content text', () => {
    expect(
      contentText([{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }]),
    ).toBe('a\nb');
    expect(contentText(undefined)).toBe('');
  });
});
