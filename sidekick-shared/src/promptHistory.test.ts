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

import {
  collectPromptHistory,
  type PromptHistoryCursor,
  type PromptHistoryEntry,
} from './promptHistory';
import { encodeWorkspacePath as encodeClaudeWorkspacePath } from './parsers/sessionPathResolver';

type Row = Record<string, unknown>;

let repo: string;
let savedCodexHome: string | undefined;

function ts(second: number): string {
  return new Date(Date.UTC(2026, 8, 1, 10, 0, second)).toISOString();
}

function writeJsonl(file: string, rows: Row[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
}

function appendJsonl(file: string, rows: Row[]): void {
  fs.appendFileSync(file, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
}

function claudeFile(workspace: string, sessionId: string): string {
  return path.join(
    tmpDir,
    '.claude',
    'projects',
    encodeClaudeWorkspacePath(workspace),
    `${sessionId}.jsonl`,
  );
}

function claudeUser(content: unknown, second: number, extra: Row = {}): Row {
  return {
    type: 'user',
    entrypoint: 'cli',
    cwd: repo,
    gitBranch: 'main',
    timestamp: ts(second),
    message: { role: 'user', content },
    ...extra,
  };
}

/** One Claude Code assistant record; `message` fields are merged over the defaults. */
function claudeAssistant(id: string, second: number, extra: Row = {}, message: Row = {}): Row {
  return {
    type: 'assistant',
    entrypoint: 'cli',
    cwd: repo,
    timestamp: ts(second),
    message: {
      id,
      role: 'assistant',
      model: 'claude-opus-5',
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
      usage: {
        input_tokens: 10,
        output_tokens: 20,
        cache_read_input_tokens: 30,
        cache_creation_input_tokens: 40,
      },
      ...message,
    },
    ...extra,
  };
}

let codexCounter = 0;
function codexFile(): string {
  codexCounter++;
  const id = `019d86b0-b20c-7b02-a3b2-${String(codexCounter).padStart(12, '0')}`;
  return path.join(
    tmpDir,
    '.codex',
    'sessions',
    '2026',
    '09',
    '01',
    `rollout-2026-09-01T10-00-${String(codexCounter).padStart(2, '0')}-${id}.jsonl`,
  );
}

function codexMeta(cwd: string | undefined, source: unknown = 'cli', extra: Row = {}): Row {
  return {
    timestamp: ts(0),
    type: 'session_meta',
    payload: {
      id: 'meta',
      timestamp: ts(0),
      ...(cwd !== undefined ? { cwd } : {}),
      originator: 'codex-tui',
      source,
      git: { branch: 'feature/x' },
      ...extra,
    },
  };
}

function codexUser(texts: string[], second: number): Row {
  return {
    timestamp: ts(second),
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'user',
      content: texts.map((text) => ({ type: 'input_text', text })),
    },
  };
}

function codexTokenCount(second: number): Row {
  return {
    timestamp: ts(second),
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        last_token_usage: {
          input_tokens: 100,
          cached_input_tokens: 60,
          output_tokens: 7,
          cache_write_input_tokens: 5,
        },
      },
    },
  };
}

function identity(entry: PromptHistoryEntry): string {
  return `${entry.provider}:${entry.sessionId}:${entry.ordinal}`;
}

/** What a consumer does with each result: insert new identities, enrich existing ones. */
function upsert(
  rows: Map<string, PromptHistoryEntry>,
  ...batches: PromptHistoryEntry[][]
): Map<string, PromptHistoryEntry> {
  for (const batch of batches) {
    for (const entry of batch) {
      const existing = rows.get(identity(entry));
      if (existing) {
        expect(entry.text).toBe(existing.text);
        expect(entry.timestamp).toBe(existing.timestamp);
      }
      rows.set(identity(entry), entry);
    }
  }
  return rows;
}

function byIdentity(left: PromptHistoryEntry, right: PromptHistoryEntry): number {
  if (left.provider !== right.provider) return left.provider < right.provider ? -1 : 1;
  if (left.sessionId !== right.sessionId) return left.sessionId < right.sessionId ? -1 : 1;
  return left.ordinal - right.ordinal;
}

function texts(entries: PromptHistoryEntry[]): string[] {
  return entries.map((entry) => entry.text);
}

beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-prompt-history-')));
  repo = path.join(tmpDir, 'work', 'repo');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'pkg'), { recursive: true });
  savedCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = path.join(tmpDir, '.codex');
});

afterEach(() => {
  if (savedCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = savedCodexHome;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('collectPromptHistory — Claude Code', () => {
  it('returns only human prompts with stable ordinals and answering-turn model/usage', async () => {
    writeJsonl(claudeFile(repo, 'c1'), [
      claudeUser('first prompt', 1),
      claudeAssistant('msg_1', 2),
      claudeAssistant('msg_1', 3, {}),
      claudeUser('Base directory for this skill', 4, { isMeta: true }),
      claudeUser('subagent task', 5, { isSidechain: true }),
      claudeUser([{ type: 'tool_result', tool_use_id: 't1', content: 'out' }], 6),
      claudeUser('<local-command-stdout>ok</local-command-stdout>', 7),
      claudeUser([{ type: 'text', text: '[Request interrupted by user]' }], 8),
      claudeUser('This session is being continued from a previous conversation', 9, {
        isCompactSummary: true,
      }),
      claudeUser('<task-notification>done</task-notification>', 10, {
        origin: { kind: 'task-notification' },
      }),
      claudeUser('sdk program prompt', 11, { entrypoint: 'sdk-ts' }),
      claudeUser(
        '<command-message>review</command-message>\n<command-name>/review</command-name>\n<command-args>foo</command-args>',
        12,
      ),
      claudeUser([{ type: 'text', text: 'array prompt' }], 13, { entrypoint: 'claude-desktop' }),
      claudeUser('no timestamp', 14, { timestamp: undefined }),
      claudeUser('print mode prompt', 15, { entrypoint: 'sdk-cli', cwd: path.join(repo, 'pkg') }),
    ]);

    const result = await collectPromptHistory({ workspacePaths: [repo] });

    expect(texts(result.entries)).toEqual([
      'first prompt',
      '/review foo',
      'array prompt',
      'print mode prompt',
    ]);
    expect(result.entries.map((entry) => entry.ordinal)).toEqual([0, 1, 2, 4]);
    expect(result.entries[0]).toMatchObject({
      provider: 'claude-code',
      sessionId: 'c1',
      timestamp: ts(1),
      cwd: repo,
      gitBranch: 'main',
      model: 'claude-opus-5',
      usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 40 },
    });
    expect(result.entries[1].model).toBeUndefined();
    expect(result.entries[3].cwd).toBe(path.join(repo, 'pkg'));
    expect(result.stats).toMatchObject({ sessionsScanned: 1, promptsMissingTimestamp: 1 });
    expect(result.boundsHit).toEqual([]);
  });

  it('fails closed on out-of-scope and missing cwds, including prefix look-alikes', async () => {
    const lookAlike = path.join(tmpDir, 'work', 'repo-other');
    fs.mkdirSync(lookAlike, { recursive: true });
    writeJsonl(claudeFile(repo, 'in'), [claudeUser('in scope', 1)]);
    writeJsonl(claudeFile(repo, 'outside'), [claudeUser('elsewhere', 1, { cwd: tmpDir })]);
    writeJsonl(claudeFile(repo, 'missing'), [claudeUser('no cwd', 1, { cwd: undefined })]);
    writeJsonl(claudeFile(repo, 'gone'), [
      claudeUser('deleted dir', 1, { cwd: path.join(repo, 'deleted') }),
    ]);
    writeJsonl(claudeFile(lookAlike, 'alike'), [claudeUser('look-alike', 1, { cwd: lookAlike })]);

    const result = await collectPromptHistory({ workspacePaths: [repo] });

    expect(texts(result.entries)).toEqual(['in scope']);
    expect(result.stats.sessionsOutOfScope).toBe(4);
    expect(result.stats.promptsOutOfScope).toBe(4);
  });

  it('resolves symlinked roots and includes git worktree siblings by default', async () => {
    const worktree = path.join(tmpDir, 'work', 'repo-wt');
    fs.mkdirSync(path.join(repo, '.git', 'worktrees', 'wt'), { recursive: true });
    fs.mkdirSync(worktree, { recursive: true });
    fs.writeFileSync(
      path.join(repo, '.git', 'worktrees', 'wt', 'gitdir'),
      path.join(worktree, '.git') + '\n',
    );
    fs.writeFileSync(
      path.join(worktree, '.git'),
      `gitdir: ${path.join(repo, '.git', 'worktrees', 'wt')}\n`,
    );
    const link = path.join(tmpDir, 'link-to-repo');
    fs.symlinkSync(repo, link);

    writeJsonl(claudeFile(repo, 'main'), [claudeUser('main prompt', 1)]);
    writeJsonl(claudeFile(worktree, 'wt'), [claudeUser('worktree prompt', 1, { cwd: worktree })]);

    const withSiblings = await collectPromptHistory({ workspacePaths: [link] });
    expect(texts(withSiblings.entries).sort()).toEqual(['main prompt', 'worktree prompt']);
    expect(withSiblings.entries.every((entry) => !entry.cwd.includes('link-to-repo'))).toBe(true);

    const fromWorktree = await collectPromptHistory({ workspacePaths: [worktree] });
    expect(texts(fromWorktree.entries).sort()).toEqual(['main prompt', 'worktree prompt']);

    const withoutSiblings = await collectPromptHistory({
      workspacePaths: [repo],
      includeWorktrees: false,
    });
    expect(texts(withoutSiblings.entries)).toEqual(['main prompt']);
  });
});

describe('collectPromptHistory — Codex', () => {
  it('returns typed prompts from interactive sessions with model and usage', async () => {
    const file = codexFile();
    writeJsonl(file, [
      codexMeta(repo),
      {
        timestamp: ts(1),
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'developer',
          content: [{ type: 'input_text', text: 'dev' }],
        },
      },
      codexUser(['# AGENTS.md instructions for /repo\n\nbe nice'], 2),
      codexUser(['<environment_context>\n<cwd>/repo</cwd>\n</environment_context>'], 3),
      {
        timestamp: ts(4),
        type: 'turn_context',
        payload: { cwd: repo, model: 'gpt-5.5-codex' },
      },
      codexUser(['<image name=[Image #1]>', '</image>', '[Image #1] what is this?'], 5),
      { timestamp: ts(6), type: 'event_msg', payload: { type: 'user_message', message: 'x' } },
      codexTokenCount(7),
      codexTokenCount(8),
      codexUser(['<turn_aborted>'], 9),
      codexUser(['second prompt'], 10),
    ]);

    const result = await collectPromptHistory({ workspacePaths: [repo], providers: ['codex'] });

    expect(texts(result.entries)).toEqual(['[Image #1] what is this?', 'second prompt']);
    expect(result.entries[0]).toMatchObject({
      provider: 'codex',
      ordinal: 0,
      timestamp: ts(5),
      cwd: repo,
      gitBranch: 'feature/x',
      model: 'gpt-5.5-codex',
      usage: { inputTokens: 40, outputTokens: 7, cacheReadTokens: 60, cacheWriteTokens: 5 },
    });
    expect(result.entries[1]).toMatchObject({ ordinal: 1 });
    expect(result.entries[1].usage).toBeUndefined();
  });

  it('skips subagent, forked, and out-of-scope sessions; includes exec sessions', async () => {
    writeJsonl(codexFile(), [
      codexMeta(repo, { subagent: { thread_spawn: { parent_thread_id: 'p' } } }),
      codexUser(['subagent replay'], 1),
    ]);
    writeJsonl(codexFile(), [
      codexMeta(repo, 'cli', { forked_from_id: 'parent' }),
      codexMeta(repo),
      codexUser(['forked replay'], 1),
    ]);
    writeJsonl(codexFile(), [codexMeta(repo, 'exec'), codexUser(['exec prompt'], 1)]);
    writeJsonl(codexFile(), [codexMeta(path.join(repo, 'pkg')), codexUser(['subdir prompt'], 1)]);
    // Parent directory of the root: the provider's listing matches it, scope must not.
    writeJsonl(codexFile(), [codexMeta(path.dirname(repo)), codexUser(['parent dir'], 1)]);
    writeJsonl(codexFile(), [codexMeta(undefined), codexUser(['no cwd'], 1)]);

    const result = await collectPromptHistory({ workspacePaths: [repo], providers: ['codex'] });

    expect(texts(result.entries).sort()).toEqual(['exec prompt', 'subdir prompt']);
    expect(result.stats.sessionsNotInteractive).toBe(2);
    expect(result.stats.sessionsOutOfScope).toBe(1);
  });
});

describe('collectPromptHistory — bounds, cursor, and filters', () => {
  it('skips files over the per-file limit and reports it without throwing', async () => {
    writeJsonl(claudeFile(repo, 'small'), [claudeUser('small', 1)]);
    writeJsonl(claudeFile(repo, 'large'), [claudeUser('large ' + 'x'.repeat(4096), 1)]);

    const result = await collectPromptHistory({
      workspacePaths: [repo],
      bounds: { maxFileBytes: 1024 },
    });

    expect(texts(result.entries)).toEqual(['small']);
    expect(result.stats.filesOverSizeLimit).toBe(1);
    expect(result.boundsHit).toEqual(['maxFileBytes']);
    expect(Object.values(result.cursor.sessions).map((s) => s.sessionId)).toEqual(['small']);
  });

  it('stops at maxSessions and maxTotalBytes with a cursor covering only processed files', async () => {
    writeJsonl(claudeFile(repo, 'a'), [claudeUser('a', 1)]);
    writeJsonl(claudeFile(repo, 'b'), [claudeUser('b', 1)]);

    const bySessions = await collectPromptHistory({
      workspacePaths: [repo],
      bounds: { maxSessions: 1 },
    });
    expect(texts(bySessions.entries)).toEqual(['a']);
    expect(bySessions.boundsHit).toEqual(['maxSessions']);
    expect(Object.keys(bySessions.cursor.sessions)).toHaveLength(1);

    const resumed = await collectPromptHistory({
      workspacePaths: [repo],
      cursor: bySessions.cursor,
      bounds: { maxSessions: 1 },
    });
    expect(texts(resumed.entries)).toEqual(['b']);
    expect(resumed.stats.sessionsSkippedUnchanged).toBe(1);

    const size = fs.statSync(claudeFile(repo, 'a')).size;
    const byBytes = await collectPromptHistory({
      workspacePaths: [repo],
      bounds: { maxTotalBytes: size },
    });
    expect(texts(byBytes.entries)).toEqual(['a']);
    expect(byBytes.boundsHit).toEqual(['maxTotalBytes']);
  });

  it('reports deadline and abort cleanly', async () => {
    writeJsonl(claudeFile(repo, 'a'), [claudeUser('a', 1)]);

    const late = await collectPromptHistory({ workspacePaths: [repo], bounds: { deadlineMs: 0 } });
    expect(late.entries).toEqual([]);
    expect(late.boundsHit).toEqual(['deadline']);
    expect(late.cursor.sessions).toEqual({});

    const controller = new AbortController();
    controller.abort();
    const aborted = await collectPromptHistory({
      workspacePaths: [repo],
      signal: controller.signal,
    });
    expect(aborted.entries).toEqual([]);
    expect(aborted.boundsHit).toEqual(['aborted']);
  });

  it('abandons a file interrupted mid-scan without advancing its cursor', async () => {
    const rows = Array.from({ length: 1200 }, (_, index) => claudeUser(`p${index}`, index % 60));
    writeJsonl(claudeFile(repo, 'big'), rows);
    const controller = new AbortController();
    const originalOpen = fs.promises.open;
    // Abort once the file is open: the per-file check has already passed, so the
    // stop must come from the in-scan check after the first 500 lines.
    const spy = vi.spyOn(fs.promises, 'open').mockImplementation(async (...args) => {
      const handle = await originalOpen(...(args as Parameters<typeof originalOpen>));
      controller.abort();
      return handle;
    });
    try {
      const result = await collectPromptHistory({
        workspacePaths: [repo],
        signal: controller.signal,
      });
      expect(spy).toHaveBeenCalledTimes(1);
      expect(result.boundsHit).toEqual(['aborted']);
      expect(result.entries).toEqual([]);
      expect(result.stats.sessionsScanned).toBe(1);
      expect(result.cursor.sessions).toEqual({});
    } finally {
      spy.mockRestore();
    }
  });

  it('resumes: unchanged files skipped, appended files continue after lastOrdinal', async () => {
    const stable = claudeFile(repo, 'stable');
    const growing = claudeFile(repo, 'growing');
    writeJsonl(stable, [claudeUser('s0', 1), claudeUser('s1', 2)]);
    writeJsonl(growing, [
      claudeUser('g0', 1),
      claudeUser('<system-reminder>x</system-reminder>', 2),
    ]);
    const codex = codexFile();
    writeJsonl(codex, [
      codexMeta(repo),
      { timestamp: ts(1), type: 'turn_context', payload: { cwd: repo, model: 'm1' } },
      codexUser(['c0'], 2),
    ]);

    const first = await collectPromptHistory({ workspacePaths: [repo] });
    expect(texts(first.entries)).toEqual(['g0', 's0', 's1', 'c0']);
    const serialized = JSON.parse(JSON.stringify(first.cursor));

    const unchanged = await collectPromptHistory({ workspacePaths: [repo], cursor: serialized });
    expect(unchanged.entries).toEqual([]);
    expect(unchanged.stats.sessionsSkippedUnchanged).toBe(3);

    appendJsonl(growing, [claudeUser('g1', 3), claudeAssistant('msg_g', 4)]);
    appendJsonl(codex, [codexUser(['c1'], 3), codexTokenCount(4)]);
    const resumed = await collectPromptHistory({ workspacePaths: [repo], cursor: serialized });
    // g0 and c0 were returned as pending; the next prompt closes them unanswered, so they
    // come back once as final with unknown usage, under the same identity.
    expect(resumed.entries.map((e) => [e.text, e.ordinal, e.metadataStatus])).toEqual([
      ['g0', 0, 'final'],
      ['g1', 1, 'final'],
      ['c0', 0, 'final'],
      ['c1', 1, 'final'],
    ]);
    expect(resumed.entries[0].usage).toBeUndefined();
    expect(resumed.entries[0].timestamp).toBe(first.entries[0].timestamp);
    expect(resumed.entries[3].model).toBe('m1');
    expect(resumed.stats).toMatchObject({ sessionsScanned: 2, sessionsSkippedUnchanged: 1 });

    // Upserting every returned entry by identity reproduces a fresh full run exactly.
    const fresh = await collectPromptHistory({ workspacePaths: [repo] });
    const rows = upsert(new Map(), first.entries, resumed.entries);
    expect([...rows.values()].sort(byIdentity)).toEqual(fresh.entries);
  });

  it('ignores an incomplete trailing line until it is finished', async () => {
    const file = claudeFile(repo, 'partial');
    writeJsonl(file, [claudeUser('done', 1)]);
    fs.appendFileSync(file, JSON.stringify(claudeUser('half', 2)).slice(0, 40));

    const first = await collectPromptHistory({ workspacePaths: [repo] });
    expect(texts(first.entries)).toEqual(['done']);

    fs.writeFileSync(file, JSON.stringify(claudeUser('done', 1)) + '\n');
    appendJsonl(file, [claudeUser('half', 2)]);
    const second = await collectPromptHistory({ workspacePaths: [repo], cursor: first.cursor });
    expect(second.entries.map((e) => [e.text, e.ordinal, e.metadataStatus])).toEqual([
      ['done', 0, 'final'],
      ['half', 1, 'pending'],
    ]);
  });

  it('applies the since filter without shifting ordinals', async () => {
    writeJsonl(claudeFile(repo, 'c'), [claudeUser('old', 1), claudeUser('new', 30)]);
    const result = await collectPromptHistory({
      workspacePaths: [repo],
      since: new Date(ts(10)),
    });
    expect(result.entries.map((e) => [e.text, e.ordinal])).toEqual([['new', 1]]);
  });

  it('never returns raw session file paths', async () => {
    writeJsonl(claudeFile(repo, 'c'), [claudeUser('prompt', 1)]);
    writeJsonl(codexFile(), [codexMeta(repo), codexUser(['codex prompt'], 1)]);
    const result = await collectPromptHistory({ workspacePaths: [repo] });
    expect(result.entries).toHaveLength(2);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('.claude');
    expect(serialized).not.toContain('.codex');
    expect(serialized).not.toContain('rollout-');
  });

  it('returns nothing when no root resolves', async () => {
    writeJsonl(claudeFile(repo, 'c'), [claudeUser('prompt', 1)]);
    const result = await collectPromptHistory({
      workspacePaths: [path.join(tmpDir, 'missing'), 'relative/path'],
    });
    expect(result.entries).toEqual([]);
    expect(result.stats.sessionsScanned).toBe(0);
  });
});

describe('collectPromptHistory — late answer metadata', () => {
  function roundTrip<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
  }

  function claudeToolResult(second: number): Row {
    return claudeUser([{ type: 'tool_result', tool_use_id: 't1', content: 'out' }], second);
  }

  it('Claude: returns the same prompt again when its answer arrives after collection', async () => {
    const file = claudeFile(repo, 'late');
    writeJsonl(file, [claudeUser('secret prompt body', 1)]);

    const first = await collectPromptHistory({ workspacePaths: [repo] });
    expect(first.entries).toHaveLength(1);
    expect(first.entries[0]).toMatchObject({ ordinal: 0, metadataStatus: 'pending' });
    expect(first.entries[0].model).toBeUndefined();
    expect(first.entries[0].usage).toBeUndefined();
    expect(first.cursor.version).toBe(2);
    expect(JSON.stringify(first.cursor)).not.toContain('secret prompt body');
    const cursor = roundTrip(first.cursor);

    appendJsonl(file, [claudeAssistant('msg_1', 2)]);
    const second = await collectPromptHistory({ workspacePaths: [repo], cursor });
    expect(second.entries).toHaveLength(1);
    expect(second.entries[0]).toEqual({
      ...first.entries[0],
      model: 'claude-opus-5',
      usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 40 },
      metadataStatus: 'final',
    });
    expect(Object.values(second.cursor.sessions)[0].pending).toBeUndefined();

    const unchanged = await collectPromptHistory({
      workspacePaths: [repo],
      cursor: roundTrip(second.cursor),
    });
    expect(unchanged.entries).toEqual([]);

    appendJsonl(file, [claudeToolResult(3), claudeUser('next prompt', 4)]);
    const third = await collectPromptHistory({
      workspacePaths: [repo],
      cursor: roundTrip(second.cursor),
    });
    expect(third.entries.map((e) => [e.text, e.ordinal])).toEqual([['next prompt', 1]]);

    const fresh = await collectPromptHistory({ workspacePaths: [repo] });
    const rows = upsert(new Map(), first.entries, second.entries, third.entries);
    expect([...rows.values()].sort(byIdentity)).toEqual(fresh.entries);
  });

  it('Codex: returns the same prompt again when its token_count arrives after collection', async () => {
    const file = codexFile();
    writeJsonl(file, [
      codexMeta(repo),
      { timestamp: ts(1), type: 'turn_context', payload: { cwd: repo, model: 'm1' } },
      codexUser(['codex secret prompt'], 2),
    ]);

    const first = await collectPromptHistory({ workspacePaths: [repo], providers: ['codex'] });
    expect(first.entries).toHaveLength(1);
    expect(first.entries[0]).toMatchObject({ ordinal: 0, metadataStatus: 'pending' });
    expect(first.entries[0].model).toBeUndefined();
    expect(JSON.stringify(first.cursor)).not.toContain('codex secret prompt');

    // A turn_context between prompt and answer applies exactly as in a single pass.
    appendJsonl(file, [
      { timestamp: ts(3), type: 'turn_context', payload: { cwd: repo, model: 'm2' } },
      codexTokenCount(4),
    ]);
    const second = await collectPromptHistory({
      workspacePaths: [repo],
      providers: ['codex'],
      cursor: roundTrip(first.cursor),
    });
    expect(second.entries).toEqual([
      {
        ...first.entries[0],
        model: 'm2',
        usage: { inputTokens: 40, outputTokens: 7, cacheReadTokens: 60, cacheWriteTokens: 5 },
        metadataStatus: 'final',
      },
    ]);

    const unchanged = await collectPromptHistory({
      workspacePaths: [repo],
      providers: ['codex'],
      cursor: roundTrip(second.cursor),
    });
    expect(unchanged.entries).toEqual([]);

    appendJsonl(file, [codexUser(['codex next'], 5)]);
    const third = await collectPromptHistory({
      workspacePaths: [repo],
      providers: ['codex'],
      cursor: roundTrip(second.cursor),
    });
    expect(third.entries.map((e) => [e.text, e.ordinal, e.metadataStatus])).toEqual([
      ['codex next', 1, 'pending'],
    ]);

    const fresh = await collectPromptHistory({ workspacePaths: [repo], providers: ['codex'] });
    const rows = upsert(new Map(), first.entries, second.entries, third.entries);
    expect([...rows.values()].sort(byIdentity)).toEqual(fresh.entries);
  });

  it('Claude: records of one answering call split across scans replace, never add, usage', async () => {
    const file = claudeFile(repo, 'split');
    writeJsonl(file, [
      claudeUser('prompt', 1),
      claudeAssistant(
        'msg_1',
        2,
        {},
        {
          content: [{ type: 'thinking', thinking: '' }],
          stop_reason: null,
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      ),
    ]);

    const first = await collectPromptHistory({ workspacePaths: [repo] });
    expect(first.entries[0]).toMatchObject({
      metadataStatus: 'provisional',
      model: 'claude-opus-5',
      usage: { inputTokens: 10, outputTokens: 5 },
    });

    appendJsonl(file, [
      claudeAssistant(
        'msg_1',
        3,
        {},
        { stop_reason: 'tool_use', usage: { input_tokens: 10, output_tokens: 20 } },
      ),
      claudeAssistant(
        'msg_1',
        3,
        {},
        { stop_reason: 'tool_use', usage: { input_tokens: 10, output_tokens: 20 } },
      ),
    ]);
    const second = await collectPromptHistory({
      workspacePaths: [repo],
      cursor: roundTrip(first.cursor),
    });
    expect(second.entries).toHaveLength(1);
    expect(second.entries[0]).toMatchObject({
      ordinal: 0,
      timestamp: ts(1),
      metadataStatus: 'final',
      usage: { inputTokens: 10, outputTokens: 20 },
    });

    appendJsonl(file, [claudeToolResult(4), claudeAssistant('msg_2', 5)]);
    const third = await collectPromptHistory({
      workspacePaths: [repo],
      cursor: roundTrip(second.cursor),
    });
    expect(third.entries).toEqual([]);
  });

  it('Claude: a provisional first call keeps its values when a later call closes it', async () => {
    const file = claudeFile(repo, 'loop');
    writeJsonl(file, [
      claudeUser('prompt', 1),
      claudeAssistant(
        'msg_1',
        2,
        {},
        { stop_reason: null, usage: { input_tokens: 11, output_tokens: 3 } },
      ),
    ]);
    const first = await collectPromptHistory({ workspacePaths: [repo] });
    expect(first.entries[0].metadataStatus).toBe('provisional');

    // Tool-loop calls after the first never replace its attribution.
    appendJsonl(file, [
      claudeToolResult(3),
      claudeAssistant(
        'msg_2',
        4,
        {},
        { model: 'claude-other', usage: { input_tokens: 999, output_tokens: 999 } },
      ),
      claudeAssistant(
        'msg_3',
        5,
        {},
        { model: 'claude-other', usage: { input_tokens: 888, output_tokens: 888 } },
      ),
    ]);
    const second = await collectPromptHistory({
      workspacePaths: [repo],
      cursor: roundTrip(first.cursor),
    });
    expect(second.entries).toHaveLength(1);
    expect(second.entries[0]).toMatchObject({
      ordinal: 0,
      model: 'claude-opus-5',
      usage: { inputTokens: 11, outputTokens: 3 },
      metadataStatus: 'final',
    });
  });

  it('keeps first-call attribution within one scan and ignores synthetic records', async () => {
    writeJsonl(claudeFile(repo, 'one-pass'), [
      claudeUser('prompt', 1),
      claudeAssistant(
        'syn',
        2,
        {},
        { model: '<synthetic>', usage: { input_tokens: 0, output_tokens: 0 } },
      ),
      claudeAssistant(
        'msg_1',
        3,
        {},
        { stop_reason: 'tool_use', usage: { input_tokens: 1, output_tokens: 2 } },
      ),
      claudeToolResult(4),
      claudeAssistant(
        'msg_2',
        5,
        {},
        { model: 'claude-other', usage: { input_tokens: 50, output_tokens: 60 } },
      ),
    ]);
    const result = await collectPromptHistory({ workspacePaths: [repo] });
    expect(result.entries[0]).toMatchObject({
      model: 'claude-opus-5',
      usage: { inputTokens: 1, outputTokens: 2 },
      metadataStatus: 'final',
    });
  });

  it('leaves missing usage unknown rather than zero', async () => {
    writeJsonl(claudeFile(repo, 'no-usage'), [
      claudeUser('prompt', 1),
      claudeAssistant('msg_1', 2, {}, { usage: undefined }),
    ]);
    const codex = codexFile();
    writeJsonl(codex, [
      codexMeta(repo),
      { timestamp: ts(1), type: 'turn_context', payload: { cwd: repo, model: 'm1' } },
      codexUser(['interrupted'], 2),
      { timestamp: ts(3), type: 'event_msg', payload: { type: 'token_count', info: null } },
    ]);

    const first = await collectPromptHistory({ workspacePaths: [repo] });
    const claude = first.entries.find((e) => e.provider === 'claude-code');
    expect(claude).toMatchObject({ model: 'claude-opus-5', metadataStatus: 'final' });
    expect(claude?.usage).toBeUndefined();
    // A rate-limit-only token_count is not an answering call.
    const codexEntry = first.entries.find((e) => e.provider === 'codex');
    expect(codexEntry?.metadataStatus).toBe('pending');

    appendJsonl(codex, [codexUser(['after interrupt'], 4)]);
    const second = await collectPromptHistory({
      workspacePaths: [repo],
      cursor: roundTrip(first.cursor),
    });
    expect(second.entries.map((e) => [e.text, e.ordinal, e.metadataStatus])).toEqual([
      ['interrupted', 0, 'final'],
      ['after interrupt', 1, 'pending'],
    ]);
    expect(second.entries[0].usage).toBeUndefined();
    expect(second.entries[0].model).toBeUndefined();
  });

  it('enriches from an answer line that was incomplete during the previous scan', async () => {
    const file = claudeFile(repo, 'partial-answer');
    const prompt = JSON.stringify(claudeUser('prompt', 1)) + '\n';
    const answer = JSON.stringify(claudeAssistant('msg_1', 2));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, prompt + answer.slice(0, 60));

    const first = await collectPromptHistory({ workspacePaths: [repo] });
    expect(first.entries[0].metadataStatus).toBe('pending');

    fs.appendFileSync(file, answer.slice(60) + '\n');
    const second = await collectPromptHistory({
      workspacePaths: [repo],
      cursor: roundTrip(first.cursor),
    });
    expect(second.entries).toHaveLength(1);
    expect(second.entries[0]).toMatchObject({
      ordinal: 0,
      model: 'claude-opus-5',
      metadataStatus: 'final',
    });
  });

  it('accepts a version 1 cursor, writes version 2, and ignores unknown versions', async () => {
    writeJsonl(claudeFile(repo, 'v1'), [claudeUser('prompt', 1), claudeAssistant('msg_1', 2)]);
    const first = await collectPromptHistory({ workspacePaths: [repo] });
    const v1 = roundTrip({ ...first.cursor, version: 1 }) as unknown as PromptHistoryCursor;

    const fromV1 = await collectPromptHistory({ workspacePaths: [repo], cursor: v1 });
    expect(fromV1.entries).toEqual([]);
    expect(fromV1.stats.sessionsSkippedUnchanged).toBe(1);
    expect(fromV1.cursor.version).toBe(2);

    const unknown = {
      version: 3,
      sessions: first.cursor.sessions,
    } as unknown as PromptHistoryCursor;
    const fromUnknown = await collectPromptHistory({ workspacePaths: [repo], cursor: unknown });
    expect(fromUnknown.entries).toHaveLength(1);
  });

  it('stops waiting on a prompt whose replay window exceeds maxFileBytes', async () => {
    const file = claudeFile(repo, 'big');
    writeJsonl(file, [claudeUser('x'.repeat(2000), 1)]);
    const first = await collectPromptHistory({ workspacePaths: [repo] });
    expect(first.entries[0].metadataStatus).toBe('pending');

    appendJsonl(file, [claudeUser('small', 2)]);
    const second = await collectPromptHistory({
      workspacePaths: [repo],
      cursor: roundTrip(first.cursor),
      bounds: { maxFileBytes: 1000 },
    });
    expect(second.entries.map((e) => [e.text, e.ordinal])).toEqual([['small', 1]]);
    expect(second.stats.filesOverSizeLimit).toBe(0);
    expect(second.boundsHit).toEqual([]);
    expect(Object.values(second.cursor.sessions)[0].pending?.ordinal).toBe(1);
  });
});
