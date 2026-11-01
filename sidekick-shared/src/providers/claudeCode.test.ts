import { describe, expect, it } from 'vitest';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { readSessionTranscript } from '../sessionTranscripts';
import { ClaudeCodeProvider } from './claudeCode';
import { EventAggregator } from '../aggregation/EventAggregator';

describe('ClaudeCodeProvider transcript provenance', () => {
  it('preserves direct and progress-wrapped provider provenance through projection', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'sidekick-claude-provenance-'));
    const sessionPath = path.join(directory, 'session-1.jsonl');
    const provider = new ClaudeCodeProvider();
    const rows = [
      {
        type: 'user',
        timestamp: '2026-07-22T12:00:00.000Z',
        entrypoint: 'cli',
        isMeta: false,
        isSidechain: false,
        cwd: '/workspace/human',
        gitBranch: 'human-branch',
        message: { role: 'user', content: 'Human CLI prompt' },
      },
      {
        type: 'progress',
        entrypoint: 'sdk',
        isMeta: true,
        isSidechain: true,
        cwd: '/workspace/sdk',
        gitBranch: 'sdk-branch',
        data: {
          message: {
            type: 'user',
            timestamp: '2026-07-22T12:00:01.000Z',
            message: { role: 'user', content: 'SDK orchestration prompt' },
          },
        },
      },
    ];
    writeFileSync(sessionPath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);

    try {
      const transcript = readSessionTranscript(provider, sessionPath, { fidelity: 'full' });

      expect(transcript).toMatchObject({
        provider: 'claude-code',
        cwd: '/workspace/sdk',
        gitBranch: 'sdk-branch',
        messages: [
          {
            text: 'Human CLI prompt',
            source: {
              provider: 'claude-code',
              source: 'claude-code-jsonl',
              entrypoint: 'cli',
              isMeta: false,
              isSidechain: false,
              originalRole: 'user',
            },
          },
          {
            text: 'SDK orchestration prompt',
            source: {
              provider: 'claude-code',
              source: 'claude-code-jsonl',
              entrypoint: 'sdk',
              isMeta: true,
              isSidechain: true,
              originalRole: 'user',
            },
          },
        ],
      });

      const [human, orchestration] = transcript.messages;
      expect(
        human.source.entrypoint === 'cli' &&
          human.source.isMeta !== true &&
          human.source.isSidechain !== true,
      ).toBe(true);
      expect(
        orchestration.source.entrypoint !== 'cli' ||
          orchestration.source.isMeta === true ||
          orchestration.source.isSidechain === true,
      ).toBe(true);
    } finally {
      provider.dispose();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

it('resumes at a complete line when a UTF-8 character spans writes', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'sidekick-claude-cursor-'));
  const filename = path.join(directory, 'session.jsonl');
  const provider = new ClaudeCodeProvider();
  const line = (text: string) =>
    Buffer.from(
      JSON.stringify({
        type: 'user',
        timestamp: '2026-09-06T12:00:00Z',
        message: { role: 'user', content: text },
      }) + '\n',
    );
  const first = line('first');
  const second = line('café ☕');
  const split = second.indexOf(Buffer.from('é')) + 1;
  try {
    writeFileSync(filename, Buffer.concat([first, second.subarray(0, split)]));
    const live = provider.createReader(filename);
    expect(live.readNew()).toHaveLength(1);
    expect(live.getPosition()).toBe(first.length);
    const resumed = provider.createReader(filename);
    resumed.seekTo(live.getPosition());
    appendFileSync(filename, second.subarray(split));
    const expected = [{ message: { content: 'café ☕' } }];
    expect(live.readNew()).toMatchObject(expected);
    expect(resumed.readNew()).toMatchObject(expected);
    expect(resumed.getPosition()).toBe(first.length + second.length);
  } finally {
    provider.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
});

it('restores usage dedupe state so a response split at the cursor is counted once', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'sidekick-claude-resume-'));
  const filename = path.join(directory, 'session.jsonl');
  const provider = new ClaudeCodeProvider();
  // Claude Code writes one response per content block, each repeating its usage.
  const block = (type: string, output: number) =>
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-09-06T12:00:00Z',
      message: {
        id: 'msg_split',
        role: 'assistant',
        model: 'claude-sonnet-4-20250514',
        content: [type === 'text' ? { type, text: 'done' } : { type, thinking: 'hmm' }],
        usage: { input_tokens: 10, output_tokens: output, cache_read_input_tokens: 500 },
      },
    }) + '\n';
  const first = block('thinking', 4);
  const rest = block('text', 4) + block('text', 323);
  const output = (events: ReturnType<ReturnType<typeof provider.createReader>['readNew']>) =>
    events.reduce((sum, event) => sum + (event.message?.normalizedUsage?.outputTokens ?? 0), 0);
  try {
    writeFileSync(filename, first);
    const live = provider.createReader(filename);
    const before = output(live.readNew());
    const position = live.getPosition();
    const state = JSON.parse(JSON.stringify(live.getResumeState?.()));
    expect(state).toMatchObject({ version: 1, entries: [['msg_split', { output: 4 }]] });
    appendFileSync(filename, rest);

    const resumed = provider.createReader(filename);
    resumed.seekTo(position);
    expect(resumed.restoreResumeState?.(state)).toBe(true);
    expect(before + output(resumed.readNew())).toBe(323);

    const unrestored = provider.createReader(filename);
    unrestored.seekTo(position);
    expect(before + output(unrestored.readNew())).toBe(4 + 323);

    const rejected = provider.createReader(filename);
    rejected.seekTo(position);
    expect(rejected.restoreResumeState?.(undefined)).toBe(false);
    expect(rejected.restoreResumeState?.({ version: 1, entries: [['msg', {}]] })).toBe(false);
  } finally {
    provider.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('ClaudeCodeProvider projects root', () => {
  it('watches the projects directory of CLAUDE_CONFIG_DIR when it is set', () => {
    const provider = new ClaudeCodeProvider();
    process.env.CLAUDE_CONFIG_DIR = '/tmp/custom-claude-home';
    try {
      expect(provider.getProjectsBaseDir()).toBe(path.join('/tmp/custom-claude-home', 'projects'));
      expect(provider.getWatchRoots()).toEqual([path.join('/tmp/custom-claude-home', 'projects')]);
    } finally {
      delete process.env.CLAUDE_CONFIG_DIR;
    }
  });
});

describe('ClaudeCodeProvider background agents', () => {
  it('reads mid-turn task notifications so a background agent completes', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'sidekick-claude-background-'));
    const sessionPath = path.join(directory, 'session.jsonl');
    const provider = new ClaudeCodeProvider();
    const notification =
      '<task-notification>\n<task-id>a35998d20ba7e3e9c</task-id>\n<tool-use-id>toolu_spawn</tool-use-id>\n<status>completed</status>\n<summary>Agent "Explore" finished</summary>\n<result>Done.</result>\n</task-notification>';
    const rows = [
      {
        type: 'assistant',
        timestamp: '2026-11-01T03:00:00.000Z',
        message: {
          role: 'assistant',
          id: 'msg_1',
          content: [
            {
              type: 'tool_use',
              id: 'toolu_spawn',
              name: 'Agent',
              input: { description: 'Explore', subagent_type: 'Explore', run_in_background: true },
            },
          ],
        },
      },
      {
        type: 'user',
        timestamp: '2026-11-01T03:00:01.000Z',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_spawn',
              content: [
                {
                  type: 'text',
                  text: 'Async agent launched successfully.\nagentId: a35998d20ba7e3e9c (internal ID)\nThe agent is working in the background.',
                },
              ],
            },
          ],
        },
        toolUseResult: { status: 'async_launched', agentId: 'a35998d20ba7e3e9c', isAsync: true },
      },
      {
        type: 'attachment',
        timestamp: '2026-11-01T03:06:53.351Z',
        attachment: {
          type: 'queued_command',
          prompt: notification,
          commandMode: 'task-notification',
        },
      },
    ];
    writeFileSync(sessionPath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);

    try {
      const reader = provider.createReader(sessionPath);
      const events = reader.readAll();
      reader.flush();
      expect(events.map((event) => event.type)).toEqual(['assistant', 'user', 'system']);
      expect(events[2]).toMatchObject({
        origin: { kind: 'task-notification' },
        message: { content: notification },
      });

      const aggregator = new EventAggregator();
      for (const event of events) aggregator.processEvent(event);
      expect(aggregator.getSubagents()).toMatchObject([
        {
          id: 'toolu_spawn',
          agentId: 'a35998d20ba7e3e9c',
          background: true,
          status: 'completed',
          outcome: 'completed',
          completionTime: '2026-11-01T03:06:53.351Z',
        },
      ]);

      // Transcripts stay as they were: the notice is not a message.
      const transcript = readSessionTranscript(provider, sessionPath, { fidelity: 'full' });
      expect(transcript.messages.map((message) => message.role)).toEqual(['assistant', 'user']);
    } finally {
      provider.dispose();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
