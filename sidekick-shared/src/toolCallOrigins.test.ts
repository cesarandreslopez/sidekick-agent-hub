import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let tmpDir: string;

vi.mock('./paths', async () => {
  const actual = await vi.importActual<typeof import('./paths')>('./paths');
  return { ...actual, getConfigDir: () => path.join(tmpDir, 'config') };
});

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return { ...actual, homedir: () => tmpDir };
});

import { collectPromptHistory } from './promptHistory';
import { findToolCallOrigins } from './toolCallOrigins';
import { createSessionLogFixtures, ts, writeJsonl, type Row } from './testing/sessionLogFixtures';

let repo: string;
let savedCodexHome: string | undefined;

const { claudeFile, claudeUser, claudeAssistant, codexFile, codexMeta, codexUser } =
  createSessionLogFixtures(() => ({ home: tmpDir, repo }));

function claudeToolUse(messageId: string, toolId: string, second: number, cwd = repo): Row {
  return claudeAssistant(
    messageId,
    second,
    { cwd },
    { content: [{ type: 'tool_use', id: toolId, name: 'Edit', input: { file_path: 'a.ts' } }] },
  );
}

function codexCall(callId: string, second: number, type = 'function_call'): Row {
  return {
    timestamp: ts(second),
    type: 'response_item',
    payload: { type, name: 'exec_command', arguments: '{}', call_id: callId },
  };
}

function codexCallOutput(callId: string, second: number): Row {
  return {
    timestamp: ts(second),
    type: 'response_item',
    payload: { type: 'function_call_output', call_id: callId, output: 'done' },
  };
}

beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-tool-origins-')));
  repo = path.join(tmpDir, 'work', 'repo');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  savedCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = path.join(tmpDir, '.codex');
});

afterEach(() => {
  if (savedCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = savedCodexHome;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('findToolCallOrigins', () => {
  it('locates Claude tool_use ids with the prompt ordinal they answered', async () => {
    const file = claudeFile(repo, 'claude-a');
    writeJsonl(file, [
      claudeUser('first prompt', 1),
      claudeToolUse('m1', 'toolu_one', 2),
      claudeUser('second prompt', 3),
      claudeToolUse('m2', 'toolu_two', 4),
    ]);

    const origins = await findToolCallOrigins({
      ids: ['toolu_one', 'toolu_two', 'toolu_missing'],
      workspacePaths: [repo],
    });

    expect(origins.size).toBe(2);
    expect(origins.get('toolu_one')).toMatchObject({
      provider: 'claude-code',
      sessionId: 'claude-a',
      filePath: file,
      timestamp: ts(2),
      afterOrdinal: 0,
      toolName: 'Edit',
    });
    expect(origins.get('toolu_two')?.afterOrdinal).toBe(1);

    // Session keys and ordinals join with prompt history.
    const history = await collectPromptHistory({ workspacePaths: [repo] });
    const keys = new Set(history.changed.map((ref) => ref.sessionKey));
    expect(keys.has(origins.get('toolu_one')!.sessionKey)).toBe(true);
    expect(history.entries.map((entry) => entry.ordinal)).toEqual([0, 1]);
  });

  it('attributes a Claude subagent call to its parent session', async () => {
    const file = claudeFile(repo, 'claude-b');
    writeJsonl(file, [claudeUser('delegate this', 1), claudeAssistant('m1', 2)]);
    const subagent = path.join(path.dirname(file), 'claude-b', 'subagents', 'agent-abc123.jsonl');
    writeJsonl(subagent, [claudeToolUse('s1', 'toolu_sub', 5)]);

    const origin = (await findToolCallOrigins({ ids: ['toolu_sub'], workspacePaths: [repo] })).get(
      'toolu_sub',
    );
    expect(origin).toMatchObject({
      sessionId: 'claude-b',
      filePath: subagent,
      afterOrdinal: 0,
      subagent: { agentId: 'abc123', parentSessionId: 'claude-b' },
    });
  });

  it('locates Codex call_ids and ignores their outputs', async () => {
    const file = codexFile();
    writeJsonl(file, [
      codexMeta(repo),
      codexUser(['run the tests'], 1),
      codexCall('call_x', 2),
      codexCallOutput('call_x', 3),
      codexCall('call_y', 4, 'custom_tool_call'),
    ]);

    const origins = await findToolCallOrigins({
      ids: ['call_x', 'call_y'],
      workspacePaths: [repo],
    });
    expect(origins.get('call_x')).toMatchObject({
      provider: 'codex',
      filePath: file,
      timestamp: ts(2),
      afterOrdinal: 0,
      toolName: 'exec_command',
    });
    expect(origins.get('call_y')?.timestamp).toBe(ts(4));
  });

  it('counts a Codex subagent call against its parent session prompts', async () => {
    const parentFile = codexFile();
    const parentId = /-([0-9a-f-]{36})\.jsonl$/.exec(parentFile)![1];
    writeJsonl(parentFile, [codexMeta(repo), codexUser(['spawn a helper'], 1)]);
    const childFile = codexFile();
    const childId = /-([0-9a-f-]{36})\.jsonl$/.exec(childFile)![1];
    writeJsonl(childFile, [
      codexMeta(repo, { subagent: { thread_spawn: { parent_thread_id: parentId } } }),
      codexCall('call_child', 5),
    ]);

    const origin = (await findToolCallOrigins({ ids: ['call_child'], workspacePaths: [repo] })).get(
      'call_child',
    );
    expect(origin).toMatchObject({
      sessionId: parentId,
      filePath: childFile,
      afterOrdinal: 0,
      subagent: { agentId: childId, parentSessionId: parentId },
    });
  });

  it('ignores sessions outside the workspace scope', async () => {
    const other = path.join(tmpDir, 'work', 'other');
    fs.mkdirSync(path.join(other, '.git'), { recursive: true });
    writeJsonl(claudeFile(other, 'claude-other'), [
      claudeUser('elsewhere', 1, { cwd: other }),
      claudeToolUse('m1', 'toolu_elsewhere', 2, other),
    ]);
    const codex = codexFile();
    writeJsonl(codex, [codexMeta(other), codexCall('call_elsewhere', 2)]);

    const origins = await findToolCallOrigins({
      ids: ['toolu_elsewhere', 'call_elsewhere'],
      workspacePaths: [repo],
    });
    expect(origins.size).toBe(0);
  });

  it('skips files not modified since `since`', async () => {
    const file = claudeFile(repo, 'claude-old');
    writeJsonl(file, [claudeUser('old', 1), claudeToolUse('m1', 'toolu_old', 2)]);
    const past = new Date('2026-01-01T00:00:00Z');
    fs.utimesSync(file, past, past);

    const recent = await findToolCallOrigins({
      ids: ['toolu_old'],
      workspacePaths: [repo],
      since: new Date('2026-06-01T00:00:00Z'),
    });
    expect(recent.size).toBe(0);
    const all = await findToolCallOrigins({ ids: ['toolu_old'], workspacePaths: [repo] });
    expect(all.size).toBe(1);
  });

  it('returns nothing for no ids and rejects when aborted', async () => {
    expect((await findToolCallOrigins({ ids: [], workspacePaths: [repo] })).size).toBe(0);
    const controller = new AbortController();
    controller.abort();
    await expect(
      findToolCallOrigins({ ids: ['x'], workspacePaths: [repo], signal: controller.signal }),
    ).rejects.toBeDefined();
  });
});
