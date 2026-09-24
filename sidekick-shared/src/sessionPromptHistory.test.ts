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

vi.mock('./providers/codexDatabase', () => ({
  CodexDatabase: class {
    isAvailable(): boolean {
      return false;
    }
    open(): boolean {
      return false;
    }
    close(): void {}
  },
}));

import { collectPromptHistory } from './promptHistory';
import { collectSessionPromptHistory, type PromptHistorySession } from './sessionPromptHistory';
import { SIGNAL_TEXT_CHARS } from './sessionPromptSignals';
import {
  claudeFiller,
  createSessionLogFixtures,
  ts,
  writeJsonl,
  type Row,
} from './testing/sessionLogFixtures';

let repo: string;
let savedCodexHome: string | undefined;

const {
  claudeFile,
  claudeUser,
  claudeAssistant,
  codexFile,
  codexMeta,
  codexUser,
  codexTokenCount,
} = createSessionLogFixtures(() => ({ home: tmpDir, repo }));

const REJECTED =
  "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file).";

function codexEvent(second: number, payload: Row): Row {
  return { timestamp: ts(second), type: 'event_msg', payload };
}

function codexItem(second: number, item: Row): Row {
  return codexEvent(second, { type: 'item_completed', item });
}

function toolResult(toolUseId: string, content: unknown, isError = true): Row {
  return { type: 'tool_result', tool_use_id: toolUseId, is_error: isError, content };
}

function toolUse(id: string, name: string): Row {
  return { type: 'tool_use', id, name, input: {} };
}

function setMtime(file: string, date: Date): void {
  fs.utimesSync(file, date, date);
}

function session(sessions: PromptHistorySession[], sessionId: string): PromptHistorySession {
  const found = sessions.find((candidate) => candidate.sessionId === sessionId);
  if (!found) throw new Error(`session ${sessionId} not returned`);
  return found;
}

beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-session-prompts-')));
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

describe('collectSessionPromptHistory — prompts', () => {
  it('groups the same prompts, ordinals, and metadata as collectPromptHistory', async () => {
    writeJsonl(claudeFile(repo, 'c1'), [
      claudeUser('first prompt', 1),
      claudeAssistant('msg_1', 2),
      claudeUser([{ type: 'text', text: '[Request interrupted by user]' }], 3),
      claudeUser('no timestamp', 4, { timestamp: undefined }),
      claudeUser('second prompt', 5, { gitBranch: 'feature/y' }),
      claudeAssistant('msg_2', 6, {}, { model: 'claude-sonnet-5' }),
    ]);
    const rollout = codexFile();
    writeJsonl(rollout, [
      codexMeta(repo),
      codexUser(['codex prompt'], 1),
      codexTokenCount(2),
      codexUser(['codex follow-up'], 3),
    ]);

    const flat = await collectPromptHistory({ workspacePaths: [repo] });
    const result = await collectSessionPromptHistory({ workspacePaths: [repo] });

    expect(result.sessions).toHaveLength(2);
    for (const grouped of result.sessions) {
      const expected = flat.entries
        .filter(
          (entry) => entry.provider === grouped.provider && entry.sessionId === grouped.sessionId,
        )
        .map(({ provider: _provider, sessionId: _sessionId, ...prompt }) => prompt);
      expect(grouped.prompts).toEqual(expected);
      expect(grouped).not.toHaveProperty('signals');
      expect(grouped.prompts.every((prompt) => !('reply' in prompt))).toBe(true);
    }

    const claude = session(result.sessions, 'c1');
    expect(claude).toMatchObject({
      provider: 'claude-code',
      startedAt: ts(1),
      lastActivityAt: ts(6),
      cwds: [repo],
      gitBranches: ['main', 'feature/y'],
      models: ['claude-opus-5', 'claude-sonnet-5'],
      droppedPrompts: 1,
      complete: false,
      truncated: false,
    });
    expect(claude.prompts.map((prompt) => prompt.ordinal)).toEqual([0, 2]);

    const codex = result.sessions.find((candidate) => candidate.provider === 'codex')!;
    expect(codex.prompts.map((prompt) => prompt.text)).toEqual(['codex prompt', 'codex follow-up']);
    expect(codex).toMatchObject({ startedAt: ts(0), complete: true, gitBranches: ['feature/x'] });

    expect(result.stats).toMatchObject({ sessionsMatched: 2, sessionsReturned: 2 });
    expect(result.unread).toEqual([]);
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });

  it('returns whole sessions for since, selecting by file time only', async () => {
    const recent = claudeFile(repo, 'recent');
    const old = claudeFile(repo, 'old');
    writeJsonl(recent, [claudeUser('one', 1), claudeUser('two', 2), claudeUser('three', 3)]);
    writeJsonl(old, [claudeUser('stale', 1)]);
    setMtime(old, new Date(Date.UTC(2020, 0, 1)));
    // Every prompt is older than `since`; the session changed after it.
    const since = new Date(Date.now() - 60_000);

    const result = await collectSessionPromptHistory({ workspacePaths: [repo], since });

    expect(result.sessions.map((candidate) => candidate.sessionId)).toEqual(['recent']);
    expect(result.sessions[0].prompts.map((prompt) => prompt.text)).toEqual([
      'one',
      'two',
      'three',
    ]);
  });

  it('selects by session id and returns the most recent sessions with prompts for limit', async () => {
    const files = ['s1', 's2', 's3'].map((id, index) => {
      const file = claudeFile(repo, id);
      writeJsonl(file, [claudeUser(`prompt ${id}`, index + 1)]);
      setMtime(file, new Date(Date.UTC(2026, 8, 1, 10, index + 1)));
      return file;
    });
    const sdkOnly = claudeFile(repo, 'sdk');
    writeJsonl(sdkOnly, [claudeUser('program prompt', 9, { entrypoint: 'sdk-ts' })]);
    setMtime(sdkOnly, new Date(Date.UTC(2026, 8, 1, 11)));
    expect(files).toHaveLength(3);

    const latest = await collectSessionPromptHistory({ workspacePaths: [repo], limit: 2 });
    expect(latest.sessions.map((candidate) => candidate.sessionId)).toEqual(['s3', 's2']);
    expect(latest.stats.sessionsWithoutPrompts).toBe(1);

    const picked = await collectSessionPromptHistory({
      workspacePaths: [repo],
      sessionIds: ['s1', 'missing'],
    });
    expect(picked.sessions.map((candidate) => candidate.sessionId)).toEqual(['s1']);
    expect(picked.stats.sessionsMatched).toBe(1);
  });

  it('skips non-interactive Codex sessions', async () => {
    writeJsonl(codexFile(), [codexMeta(repo, { subagent: 'review' }), codexUser(['task'], 1)]);
    writeJsonl(codexFile(), [
      codexMeta(repo, 'cli', { forked_from_id: 'parent' }),
      codexUser(['replayed'], 1),
    ]);

    const result = await collectSessionPromptHistory({ workspacePaths: [repo] });

    expect(result.sessions).toEqual([]);
    expect(result.stats.sessionsNotInteractive).toBe(2);
  });
});

describe('collectSessionPromptHistory — replies and signals', () => {
  it('Claude: attaches final replies and folds a rejection with its interrupt', async () => {
    writeJsonl(claudeFile(repo, 'c1'), [
      claudeUser('fix the bug', 1),
      claudeAssistant('msg_1', 2, {}, { content: [{ type: 'text', text: 'Looking' }] }),
      claudeAssistant('msg_1', 3, {}, { content: [toolUse('tu1', 'Edit')] }),
      claudeUser(
        [toolResult('tu1', `${REJECTED} STOP what you are doing and wait for the user.`)],
        4,
      ),
      claudeUser([{ type: 'text', text: '[Request interrupted by user for tool use]' }], 5),
      claudeUser('no, use the other file', 6),
      claudeAssistant('msg_2', 7, {}, { content: [toolUse('tu2', 'Bash')] }),
      claudeUser(
        [toolResult('tu2', [{ type: 'text', text: `Exit code 1\n${'x'.repeat(2000)}` }])],
        8,
      ),
      claudeAssistant('msg_3', 9, {}, { content: [toolUse('tu3', 'Write')] }),
      claudeUser(
        [
          toolResult(
            'tu3',
            `${REJECTED} To tell you how to proceed, the user said:\nkeep the old name`,
          ),
        ],
        10,
      ),
      claudeAssistant(
        'msg_4',
        11,
        {},
        { content: [{ type: 'text', text: 'Done: part one' }], stop_reason: null },
      ),
      claudeAssistant('msg_4', 12, {}, { content: [{ type: 'text', text: 'part two' }] }),
      claudeAssistant(
        'err',
        13,
        { isApiErrorMessage: true },
        { model: '<synthetic>', content: [{ type: 'text', text: 'API Error: 529 overloaded' }] },
      ),
      claudeUser([{ type: 'text', text: '[Request interrupted by user]' }], 14),
      { type: 'system', subtype: 'compact_boundary', timestamp: ts(15) },
      claudeUser('This session is being continued', 16, { isCompactSummary: true }),
      claudeAssistant(
        'side',
        17,
        { isSidechain: true },
        { content: [{ type: 'text', text: 's' }] },
      ),
      claudeUser([toolResult('tu9', 'side error')], 18, { isSidechain: true }),
    ]);

    const plain = await collectSessionPromptHistory({ workspacePaths: [repo] });
    const result = await collectSessionPromptHistory({
      workspacePaths: [repo],
      include: { signals: true, replies: true },
    });

    const [grouped] = result.sessions;
    expect(grouped.prompts.map((prompt) => prompt.text)).toEqual([
      'fix the bug',
      'no, use the other file',
    ]);
    expect(grouped.prompts.map(({ reply: _reply, ...prompt }) => prompt)).toEqual(
      plain.sessions[0].prompts,
    );
    expect(grouped.prompts.map((prompt) => prompt.reply)).toEqual([
      { text: 'Looking', timestamp: ts(2) },
      { text: 'Done: part one\npart two', timestamp: ts(11) },
    ]);

    const signals = grouped.signals!;
    expect(signals.map((signal) => [signal.kind, signal.afterOrdinal, signal.tool])).toEqual([
      ['toolRejected', 0, 'Edit'],
      ['toolError', 1, 'Bash'],
      ['toolRejected', 1, 'Write'],
      ['apiError', 1, undefined],
      ['interrupt', 1, undefined],
      ['compaction', 1, undefined],
    ]);
    expect(signals[0]).not.toHaveProperty('text');
    expect(signals[1].text).toHaveLength(SIGNAL_TEXT_CHARS);
    expect(signals[1].textTruncated).toBe(true);
    expect(signals[2]).toMatchObject({ text: 'keep the old name', timestamp: ts(10) });
    expect(signals[2]).not.toHaveProperty('textTruncated');
    expect(signals[3].text).toBe('API Error: 529 overloaded');
  });

  it('Codex: prefers task_complete replies and reads new and old event shapes', async () => {
    writeJsonl(codexFile(), [
      codexMeta(repo),
      codexUser(['first'], 1),
      codexTokenCount(2),
      codexEvent(2, { type: 'agent_message', message: 'thinking', phase: 'commentary' }),
      codexItem(3, {
        type: 'CommandExecution',
        status: 'failed',
        command: ['/bin/zsh', '-lc', 'npm test'],
        aggregated_output: 'FAIL',
        exit_code: 1,
      }),
      codexItem(4, {
        type: 'McpToolCall',
        status: 'failed',
        tool: 'js',
        error: { message: 'No browser' },
      }),
      codexItem(4, { type: 'CommandExecution', status: 'completed', exit_code: 0 }),
      codexEvent(5, { type: 'task_complete', last_agent_message: 'All done' }),
      {
        timestamp: ts(6),
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'late' }],
        },
      },
      codexUser(['second'], 7),
      codexEvent(8, {
        type: 'exec_command_end',
        command: ['bash', '-lc', 'rg foo'],
        aggregated_output: '',
        exit_code: 2,
        status: 'failed',
      }),
      codexEvent(9, { type: 'patch_apply_end', success: false, stderr: 'patch failed' }),
      codexEvent(10, { type: 'turn_aborted', reason: 'interrupted' }),
      { timestamp: ts(11), type: 'compacted', payload: { message: '', replacement_history: [] } },
      codexItem(11, { type: 'ContextCompaction', id: 'c' }),
      codexEvent(11, { type: 'context_compacted' }),
      codexEvent(12, { type: 'thread_rolled_back', num_turns: 1 }),
      codexItem(13, { type: 'AgentMessage', content: [{ type: 'Text', text: 'partial answer' }] }),
      codexEvent(14, { type: 'task_complete', error: { message: 'usage limit' } }),
      codexEvent(15, {
        type: 'mcp_tool_call_end',
        invocation: { server: 's', tool: 'list' },
        result: { Err: 'tool crashed' },
      }),
      codexEvent(15, {
        type: 'mcp_tool_call_end',
        invocation: { server: 's', tool: 'ok' },
        result: { Ok: { content: [], isError: false } },
      }),
      codexUser(['<turn_aborted>\nThe user interrupted the previous turn on purpose.'], 16),
    ]);

    const result = await collectSessionPromptHistory({
      workspacePaths: [repo],
      include: { signals: true, replies: true },
    });

    const [grouped] = result.sessions;
    expect(grouped.prompts.map((prompt) => [prompt.text, prompt.reply?.text])).toEqual([
      ['first', 'All done'],
      ['second', 'partial answer'],
    ]);
    expect(grouped.signals!.map((signal) => [signal.kind, signal.afterOrdinal])).toEqual([
      ['toolError', 0],
      ['toolError', 0],
      ['toolError', 1],
      ['toolError', 1],
      ['interrupt', 1],
      ['compaction', 1],
      ['rollback', 1],
      ['apiError', 1],
      ['toolError', 1],
    ]);
    expect(grouped.signals!.filter((signal) => signal.kind === 'toolError')).toEqual([
      expect.objectContaining({ tool: 'exec_command', text: '$ npm test\nFAIL' }),
      expect.objectContaining({ tool: 'js', text: 'No browser' }),
      expect.objectContaining({ tool: 'exec_command', text: '$ rg foo' }),
      expect.objectContaining({ tool: 'apply_patch', text: 'patch failed' }),
      expect.objectContaining({ tool: 'list', text: 'tool crashed' }),
    ]);
    expect(grouped.signals!.find((signal) => signal.kind === 'apiError')!.text).toBe('usage limit');
  });

  it('cuts long error text without splitting a surrogate pair', async () => {
    const text = 'x'.repeat(SIGNAL_TEXT_CHARS - 1) + '😀' + 'tail';
    writeJsonl(claudeFile(repo, 'emoji'), [
      claudeUser('run it', 1),
      claudeAssistant('msg_1', 2, {}, { content: [toolUse('tu1', 'Bash')] }),
      claudeUser([toolResult('tu1', text)], 3),
    ]);

    const result = await collectSessionPromptHistory({
      workspacePaths: [repo],
      include: { signals: true },
    });

    const [signal] = result.sessions[0].signals!;
    expect(signal).toMatchObject({ kind: 'toolError', tool: 'Bash', textTruncated: true });
    expect(signal.text).toBe('x'.repeat(SIGNAL_TEXT_CHARS - 1));
  });

  it('fails closed: replies and signals of out-of-scope prompts are dropped', async () => {
    writeJsonl(claudeFile(repo, 'mixed'), [
      claudeUser('in scope', 1),
      claudeAssistant('msg_1', 2, {}, { content: [{ type: 'text', text: 'first reply' }] }),
      claudeUser('elsewhere', 3, { cwd: tmpDir }),
      claudeAssistant('msg_2', 4, {}, { content: [{ type: 'text', text: 'secret reply' }] }),
      claudeUser([{ type: 'text', text: '[Request interrupted by user]' }], 5),
      claudeUser('back in scope', 6),
    ]);
    writeJsonl(claudeFile(repo, 'outside'), [claudeUser('never', 1, { cwd: tmpDir })]);

    const result = await collectSessionPromptHistory({
      workspacePaths: [repo],
      include: { signals: true, replies: true },
    });

    expect(result.sessions).toHaveLength(1);
    const [grouped] = result.sessions;
    expect(grouped.prompts.map((prompt) => [prompt.ordinal, prompt.reply?.text])).toEqual([
      [0, 'first reply'],
      [2, undefined],
    ]);
    expect(grouped.signals).toEqual([]);
    expect(grouped).toMatchObject({ droppedPrompts: 1, complete: false });
    expect(JSON.stringify(result)).not.toContain('secret reply');
    expect(result.stats.sessionsOutOfScope).toBe(1);
  });
});

describe('collectSessionPromptHistory — bounds', () => {
  function writeThreeSessions(): void {
    for (const [index, id] of ['a', 'b', 'c'].entries()) {
      const file = claudeFile(repo, id);
      writeJsonl(file, [claudeUser(`prompt ${id}`, index + 1)]);
      setMtime(file, new Date(Date.UTC(2026, 8, 1, 10, index + 1)));
    }
  }

  it('lists sessions a bound left unread, and continues from them', async () => {
    writeThreeSessions();

    const first = await collectSessionPromptHistory({
      workspacePaths: [repo],
      bounds: { maxSessions: 1 },
    });
    expect(first.sessions.map((candidate) => candidate.sessionId)).toEqual(['c']);
    expect(first.boundsHit).toEqual(['maxSessions']);
    expect(first.unread).toEqual([
      { provider: 'claude-code', sessionId: 'b' },
      { provider: 'claude-code', sessionId: 'a' },
    ]);

    const rest = await collectSessionPromptHistory({
      workspacePaths: [repo],
      sessionIds: first.unread.map((ref) => ref.sessionId),
    });
    expect(rest.sessions.map((candidate) => candidate.sessionId)).toEqual(['b', 'a']);
    expect(rest.unread).toEqual([]);
  });

  it('reports deadline and abort without returning partial sessions', async () => {
    writeThreeSessions();

    const late = await collectSessionPromptHistory({
      workspacePaths: [repo],
      bounds: { deadlineMs: 0 },
    });
    expect(late.sessions).toEqual([]);
    expect(late.boundsHit).toEqual(['deadline']);
    expect(late.unread).toHaveLength(3);

    const controller = new AbortController();
    controller.abort();
    const aborted = await collectSessionPromptHistory({
      workspacePaths: [repo],
      signal: controller.signal,
    });
    expect(aborted.boundsHit).toEqual(['aborted']);
    expect(aborted.unread).toHaveLength(3);
  });

  it('leaves a session the total budget cut short unread, never partial', async () => {
    const small = claudeFile(repo, 'small');
    const large = claudeFile(repo, 'large');
    writeJsonl(small, [claudeUser('small prompt', 1)]);
    writeJsonl(large, [claudeUser('one', 1), claudeFiller(8000, 2), claudeUser('two', 3)]);
    setMtime(small, new Date(Date.UTC(2026, 8, 1, 12)));
    setMtime(large, new Date(Date.UTC(2026, 8, 1, 11)));

    const result = await collectSessionPromptHistory({
      workspacePaths: [repo],
      bounds: { maxTotalBytes: 2000 },
    });

    expect(result.sessions.map((candidate) => candidate.sessionId)).toEqual(['small']);
    expect(result.unread).toEqual([{ provider: 'claude-code', sessionId: 'large' }]);
    expect(result.boundsHit).toEqual(['maxTotalBytes']);
    expect(result.stats.sessionsTruncated).toBe(0);
  });

  it('returns a session over maxSessionBytes as truncated', async () => {
    writeJsonl(claudeFile(repo, 'big'), [
      claudeUser('one', 1),
      claudeFiller(8000, 2),
      claudeUser('two', 3),
    ]);

    const result = await collectSessionPromptHistory({
      workspacePaths: [repo],
      bounds: { maxSessionBytes: 1000 },
    });

    expect(result.sessions[0].prompts.map((prompt) => prompt.text)).toEqual(['one']);
    expect(result.sessions[0]).toMatchObject({ truncated: true, complete: false });
    expect(result.boundsHit).toEqual(['maxSessionBytes']);
    expect(result.stats.sessionsTruncated).toBe(1);
  });

  it('counts excluded records against completeness', async () => {
    const file = claudeFile(repo, 'broken');
    writeJsonl(file, [claudeUser('one', 1)]);
    fs.appendFileSync(file, '{not json\n');
    fs.appendFileSync(file, JSON.stringify(claudeUser('two', 3)) + '\n');

    const result = await collectSessionPromptHistory({ workspacePaths: [repo] });

    expect(result.sessions[0]).toMatchObject({ excludedRecords: 1, complete: false });
    expect(result.sessions[0].prompts.map((prompt) => prompt.text)).toEqual(['one', 'two']);
    expect(result.exclusions).toEqual([
      expect.objectContaining({ sessionId: 'broken', reason: 'malformedRecord' }),
    ]);
  });
});
