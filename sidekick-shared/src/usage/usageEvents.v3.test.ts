import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let tmpDir: string;

vi.mock('../paths', async () => {
  const actual = await vi.importActual<typeof import('../paths')>('../paths');
  return { ...actual, getConfigDir: () => path.join(tmpDir, 'config') };
});

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return { ...actual, homedir: () => tmpDir };
});

// No Codex state database: rollouts are listed from the sessions directory.
vi.mock('../providers/codexDatabase', async () => {
  const actual = await vi.importActual<typeof import('../providers/codexDatabase')>(
    '../providers/codexDatabase',
  );
  return {
    ...actual,
    CodexDatabase: class {
      isAvailable(): boolean {
        return false;
      }
      open(): boolean {
        return false;
      }
      close(): void {}
    },
  };
});

import { getModelPricing } from '../modelInfo';
import { CHILD_ID, PARENT_ID, childRollout } from '../testing/codexSubagentFixtures';
import { collectPromptHistory, type PromptHistoryEntry } from '../promptHistory';
import { ClaudeCodeProvider } from '../providers/claudeCode';
import { CodexProvider } from '../providers/codex';
import type { SessionProviderBase } from '../providers/types';
import {
  appendJsonl,
  createSessionLogFixtures,
  ts,
  writeJsonl,
  type Row,
} from '../testing/sessionLogFixtures';
import {
  USAGE_CACHE_VERSION,
  collectUsageEvents,
  getUsageCacheDir,
  pruneUsageCache,
  type UsageEventRecord,
} from './usageEvents';

let repo: string;
let savedCodexHome: string | undefined;
let providers: SessionProviderBase[] = [];

const { claudeFile, claudeUser, claudeAssistant, codexMeta, codexUser } = createSessionLogFixtures(
  () => ({ home: tmpDir, repo }),
);

const CODEX_MODEL = 'gpt-5-codex';

function claude(): ClaudeCodeProvider {
  const provider = new ClaudeCodeProvider();
  providers.push(provider);
  return provider;
}

function codex(): CodexProvider {
  const provider = new CodexProvider();
  providers.push(provider);
  return provider;
}

function codexRollout(id: string, rows: Row[]): string {
  const file = path.join(
    tmpDir,
    '.codex',
    'sessions',
    '2026',
    '09',
    '01',
    `rollout-2026-09-01T10-00-00-${id}.jsonl`,
  );
  writeJsonl(file, rows);
  return file;
}

function codexTurn(second: number): Row {
  return {
    timestamp: ts(second),
    type: 'turn_context',
    payload: { model: CODEX_MODEL, cwd: repo },
  };
}

/** A Codex call; totals are cumulative, so each call passes the running total. */
function codexCall(second: number, last: Record<string, number>, total: Record<string, number>) {
  return {
    timestamp: ts(second),
    type: 'event_msg',
    payload: { type: 'token_count', info: { last_token_usage: last, total_token_usage: total } },
  };
}

const REASONING_CALL = {
  input_tokens: 12_000,
  cached_input_tokens: 4_000,
  output_tokens: 3_000,
  reasoning_output_tokens: 2_000,
};

function cacheFiles(): string[] {
  return fs.readdirSync(getUsageCacheDir()).sort();
}

/** The ordinal each event should carry, from what collectPromptHistory returned. */
function expectedOrdinal(event: UsageEventRecord, prompts: PromptHistoryEntry[]): number | null {
  let best: number | null = null;
  for (const prompt of prompts) {
    if (prompt.sessionId !== event.sessionId || prompt.provider !== event.provider) continue;
    if (Date.parse(prompt.timestamp) > event.timestamp) continue;
    best = best === null ? prompt.ordinal : Math.max(best, prompt.ordinal);
  }
  return best;
}

beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-usage-v3-')));
  repo = path.join(tmpDir, 'work', 'repo');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  savedCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = path.join(tmpDir, '.codex');
});

afterEach(() => {
  for (const provider of providers) provider.dispose();
  providers = [];
  if (savedCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = savedCodexHome;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('usage cache v3 files', () => {
  it('ignores a v2 file under the old name, writes v3 beside it, and leaves the old file alone', async () => {
    writeJsonl(claudeFile(repo, 's1'), [claudeUser('hello', 1), claudeAssistant('msg_1', 2)]);
    const provider = claude();
    const first = await collectUsageEvents({ providers: [provider] });
    expect(USAGE_CACHE_VERSION).toBe(3);
    expect(cacheFiles()).toEqual(['claude-code--s1.v3.json']);

    // What 0.28 wrote: version 2, unversioned name, same fingerprint.
    const v3Path = path.join(getUsageCacheDir(), 'claude-code--s1.v3.json');
    const v2Path = path.join(getUsageCacheDir(), 'claude-code--s1.json');
    const v3 = JSON.parse(fs.readFileSync(v3Path, 'utf8'));
    const v2Content = JSON.stringify({
      ...v3,
      version: 2,
      events: v3.events.map(({ t, m, i, o, cw, cr, bo, tt }: Record<string, unknown>) => ({
        t,
        m,
        i,
        o,
        cw,
        cr,
        bo,
        tt,
      })),
    });
    fs.writeFileSync(v2Path, v2Content);
    const old = new Date(Date.UTC(2026, 0, 1));
    fs.utimesSync(v2Path, old, old);
    fs.unlinkSync(v3Path);

    const second = await collectUsageEvents({ providers: [provider] });
    expect(second.cacheMisses).toBe(1);
    expect(second.cacheHits).toBe(0);
    expect(second.events).toEqual(first.events);
    expect(cacheFiles()).toEqual(['claude-code--s1.json', 'claude-code--s1.v3.json']);
    expect(fs.readFileSync(v2Path, 'utf8')).toBe(v2Content);
    expect(fs.statSync(v2Path).mtimeMs).toBe(old.getTime());

    // A v2 file is never read, even when it is the only one; a v3 file is.
    const third = await collectUsageEvents({ providers: [provider] });
    expect(third.cacheHits).toBe(1);
    expect(fs.statSync(v2Path).mtimeMs).toBe(old.getTime());
  });

  it('rejects a v3-named file that does not carry version 3', async () => {
    writeJsonl(claudeFile(repo, 's1'), [claudeUser('hello', 1), claudeAssistant('msg_1', 2)]);
    const provider = claude();
    await collectUsageEvents({ providers: [provider] });
    const v3Path = path.join(getUsageCacheDir(), 'claude-code--s1.v3.json');
    const cached = JSON.parse(fs.readFileSync(v3Path, 'utf8'));
    fs.writeFileSync(v3Path, JSON.stringify({ ...cached, version: 2 }));
    expect((await collectUsageEvents({ providers: [provider] })).cacheMisses).toBe(1);
  });

  it('ages out unversioned files from older readers alongside v3 files', () => {
    const dir = path.join(tmpDir, 'cache');
    fs.mkdirSync(dir, { recursive: true });
    const names = [
      'claude-code--a.json',
      'claude-code--b.v3.json',
      'codex--c.json',
      'codex--d.v3.json',
    ];
    names.forEach((name, index) => {
      const filePath = path.join(dir, name);
      fs.writeFileSync(filePath, '{}');
      const time = new Date(Date.UTC(2026, 8, 4, 12, index));
      fs.utimesSync(filePath, time, time);
    });
    expect(pruneUsageCache(2, dir)).toBe(2);
    expect(fs.readdirSync(dir).sort()).toEqual(['codex--c.json', 'codex--d.v3.json']);
  });
});

describe('reasoning tokens', () => {
  it('keeps Codex reasoning tokens through the cache without changing the priced cost', async () => {
    const id = '019d86b0-b20c-7b02-a3b2-000000000001';
    codexRollout(id, [
      codexMeta(repo, 'cli', { id }),
      codexTurn(1),
      codexUser(['explain this'], 2),
      codexCall(3, REASONING_CALL, REASONING_CALL),
    ]);
    const provider = codex();
    const miss = await collectUsageEvents({ providers: [provider] });
    const hit = await collectUsageEvents({ providers: [provider] });
    expect(miss.cacheMisses).toBe(1);
    expect(hit.cacheHits).toBe(1);

    for (const result of [miss, hit]) {
      expect(result.events).toHaveLength(1);
      const [event] = result.events;
      expect(event.tokens).toEqual({
        inputTokens: 8_000,
        outputTokens: 3_000,
        cacheWriteTokens: 0,
        cacheReadTokens: 4_000,
        totalTokens: 15_000,
        reasoningTokens: 2_000,
      });
      expect(event.costProvenance).toBe('model-catalog');
      // Pinned to what 0.28 priced this event at: reasoning is inside the
      // 3 000 output tokens and is not priced a second time.
      expect(event.costUsd).toBeCloseTo(0.0405, 12);
      const pricing = getModelPricing(CODEX_MODEL)!;
      expect(event.costUsd).toBeCloseTo(
        (8_000 * pricing.inputCostPerMillion +
          4_000 * pricing.cacheReadCostPerMillion +
          3_000 * pricing.outputCostPerMillion) /
          1_000_000,
        12,
      );
    }
    const cached = JSON.parse(
      fs.readFileSync(path.join(getUsageCacheDir(), `codex--${id}.v3.json`), 'utf8'),
    );
    expect(cached.events[0]).toMatchObject({ o: 3_000, bo: 3_000, rt: 2_000 });
  });

  it('leaves reasoningTokens off events that report none', async () => {
    writeJsonl(claudeFile(repo, 's1'), [claudeUser('hello', 1), claudeAssistant('msg_1', 2)]);
    const result = await collectUsageEvents({ providers: [claude()], noCache: true });
    expect(result.events[0].tokens).not.toHaveProperty('reasoningTokens');
  });
});

describe('subagent attribution', () => {
  it('tags Claude subagent transcript events with the agent id and parent session', async () => {
    const main = claudeFile(repo, 'parent-session');
    writeJsonl(main, [claudeUser('delegate this', 1), claudeAssistant('msg_main', 2)]);
    const subDir = path.join(path.dirname(main), 'parent-session', 'subagents');
    writeJsonl(path.join(subDir, 'agent-a0a27a478cf393505.jsonl'), [
      claudeUser('subagent task', 3, { isSidechain: true }),
      claudeAssistant('msg_sub', 4, { isSidechain: true }),
    ]);
    const provider = claude();
    const miss = await collectUsageEvents({ providers: [provider] });
    const hit = await collectUsageEvents({ providers: [provider] });
    expect(hit.cacheHits).toBe(1);
    expect(hit.events).toEqual(miss.events);

    expect(miss.events.map((event) => [event.requestId, event.subagent])).toEqual([
      ['msg_main', undefined],
      ['msg_sub', { agentId: 'a0a27a478cf393505', parentSessionId: 'parent-session' }],
    ]);
    expect(miss.events.every((event) => event.sessionId === 'parent-session')).toBe(true);
    expect(miss.events[0]).not.toHaveProperty('subagent');
  });

  it('tags Codex spawned subagents and forks with their parent from the first line', async () => {
    const parentId = '019d86b0-b20c-7b02-a3b2-00000000000a';
    const spawnedId = '019d86b0-b20c-7b02-a3b2-00000000000b';
    const forkId = '019d86b0-b20c-7b02-a3b2-00000000000c';
    const call = { input_tokens: 100, cached_input_tokens: 0, output_tokens: 10 };
    codexRollout(parentId, [
      codexMeta(repo, 'cli', { id: parentId }),
      codexTurn(1),
      codexUser(['parent prompt'], 2),
      codexCall(3, call, call),
    ]);
    codexRollout(spawnedId, [
      codexMeta(
        repo,
        {
          subagent: {
            thread_spawn: { parent_thread_id: parentId, depth: 1, agent_nickname: 'Scout' },
          },
        },
        { id: spawnedId, forked_from_id: parentId, parent_thread_id: parentId },
      ),
      codexTurn(4),
      codexCall(5, call, call),
    ]);
    codexRollout(forkId, [
      codexMeta(repo, 'cli', { id: forkId, forked_from_id: parentId }),
      codexTurn(6),
      codexUser(['forked prompt'], 7),
      codexCall(8, call, call),
    ]);
    const provider = codex();
    const miss = await collectUsageEvents({ providers: [provider] });
    const hit = await collectUsageEvents({ providers: [provider] });
    expect(hit.cacheHits).toBe(3);
    expect(hit.events).toEqual(miss.events);

    const bySession = new Map(miss.events.map((event) => [event.sessionId, event]));
    expect(bySession.get(parentId)).not.toHaveProperty('subagent');
    expect(bySession.get(spawnedId)?.subagent).toEqual({
      agentId: spawnedId,
      parentSessionId: parentId,
    });
    expect(bySession.get(forkId)?.subagent).toEqual({
      agentId: forkId,
      parentSessionId: parentId,
    });
    // Subagent and fork rollouts carry no human prompts of their own.
    expect(bySession.get(parentId)?.promptOrdinal).toBe(0);
    expect(bySession.get(spawnedId)?.promptOrdinal).toBeNull();
    expect(bySession.get(forkId)?.promptOrdinal).toBeNull();
  });

  it("counts only a forked child's own records", async () => {
    codexRollout(CHILD_ID, childRollout({ cwd: repo }));
    const first = await collectUsageEvents({ providers: [codex()] });
    // 300 + 200 of its own; the 5000 in the parent history the fork embeds is not counted.
    expect(first.events.map((event) => event.tokens.inputTokens)).toEqual([300, 200]);
    expect(first.events[0].subagent).toEqual({ agentId: CHILD_ID, parentSessionId: PARENT_ID });
  });
});

describe('prompt ordinals', () => {
  it('match collectPromptHistory for a Claude session with subagents and a correction', async () => {
    const main = claudeFile(repo, 'ordinals');
    const split = (second: number, output: number, stop: string | null) =>
      claudeAssistant(
        'msg_split',
        second,
        {},
        {
          stop_reason: stop,
          usage: { input_tokens: 10, output_tokens: output, cache_read_input_tokens: 30 },
        },
      );
    writeJsonl(main, [
      claudeAssistant('msg_before', 1),
      claudeUser('first prompt', 2),
      // One response written as split lines whose usage grows: a correction.
      split(3, 1, null),
      split(4, 1, null),
      split(5, 25, 'end_turn'),
      claudeUser([{ type: 'tool_result', tool_use_id: 't1', content: 'out' }], 6),
      claudeAssistant('msg_tool_loop', 7),
      claudeUser('<local-command-stdout>ok</local-command-stdout>', 8),
      claudeUser('no timestamp', 9, { timestamp: undefined }),
      claudeAssistant('msg_after_untimed', 10),
      claudeUser('second prompt', 11, { cwd: path.join(repo) }),
      claudeAssistant('msg_second', 12),
      claudeUser('third prompt', 20),
      claudeAssistant('msg_third', 21),
    ]);
    const subDir = path.join(path.dirname(main), 'ordinals', 'subagents');
    writeJsonl(path.join(subDir, 'agent-first.jsonl'), [
      claudeUser('subagent task', 13, { isSidechain: true }),
      claudeAssistant('msg_sub_1', 14, { isSidechain: true }),
      claudeAssistant('msg_sub_2', 15, { isSidechain: true }),
    ]);
    writeJsonl(path.join(subDir, 'agent-second.jsonl'), [
      claudeAssistant('msg_sub_3', 22, { isSidechain: true }),
    ]);

    const provider = claude();
    const usage = await collectUsageEvents({ providers: [provider] });
    const history = await collectPromptHistory({ workspacePaths: [repo] });

    expect(history.entries.map((entry) => [entry.ordinal, entry.text])).toEqual([
      [0, 'first prompt'],
      [2, 'second prompt'],
      [3, 'third prompt'],
    ]);
    // The split response is one call, its correction merged in.
    const splitEvent = usage.events.find((event) => event.requestId === 'msg_split');
    expect(splitEvent?.tokens.outputTokens).toBe(25);
    expect(usage.events.filter((event) => event.requestId === 'msg_split')).toHaveLength(1);

    expect(usage.events.map((event) => [event.requestId, event.promptOrdinal])).toEqual([
      ['msg_before', null],
      ['msg_split', 0],
      ['msg_tool_loop', 0],
      // After an untimed prompt (ordinal 1): it cannot be placed, so the
      // call stays with the last placed prompt.
      ['msg_after_untimed', 0],
      ['msg_second', 2],
      ['msg_sub_1', 2],
      ['msg_sub_2', 2],
      ['msg_third', 3],
      ['msg_sub_3', 3],
    ]);
    for (const event of usage.events) {
      expect(event.promptOrdinal).toBe(expectedOrdinal(event, history.entries));
    }

    const hit = await collectUsageEvents({ providers: [provider] });
    expect(hit.cacheHits).toBe(1);
    expect(hit.events.map((event) => event.promptOrdinal)).toEqual(
      usage.events.map((event) => event.promptOrdinal),
    );
  });

  it('match collectPromptHistory for an interactive Codex session', async () => {
    const id = '019d86b0-b20c-7b02-a3b2-000000000002';
    const one = { input_tokens: 100, cached_input_tokens: 40, output_tokens: 10 };
    const two = { input_tokens: 200, cached_input_tokens: 80, output_tokens: 20 };
    const sum = (...calls: Array<Record<string, number>>) => {
      const total: Record<string, number> = {};
      for (const call of calls) {
        for (const [key, value] of Object.entries(call)) total[key] = (total[key] ?? 0) + value;
      }
      return total;
    };
    codexRollout(id, [
      codexMeta(repo, 'cli', { id }),
      codexTurn(1),
      codexUser(['<environment_context>\n<cwd>/repo</cwd>\n</environment_context>'], 2),
      codexUser(['first codex prompt'], 3),
      codexCall(4, one, sum(one)),
      // A duplicate token_count (same total) is not another call.
      codexCall(5, one, sum(one)),
      codexCall(6, two, sum(one, two)),
      codexUser(['second codex prompt'], 7),
      codexCall(8, one, sum(one, two, one)),
    ]);
    const usage = await collectUsageEvents({ providers: [codex()] });
    const history = await collectPromptHistory({ workspacePaths: [repo], providers: ['codex'] });

    expect(history.entries.map((entry) => entry.ordinal)).toEqual([0, 1]);
    expect(usage.events.map((event) => event.promptOrdinal)).toEqual([0, 0, 1]);
    for (const event of usage.events) {
      expect(event.promptOrdinal).toBe(expectedOrdinal(event, history.entries));
    }
  });

  it('skip a prompt inside a record over the default bound, as collectPromptHistory does', async () => {
    const main = claudeFile(repo, 'oversized');
    writeJsonl(main, [
      claudeUser('before', 1),
      claudeAssistant('msg_1', 2),
      claudeUser('x'.repeat(16 * 1024 * 1024), 3),
      claudeAssistant('msg_2', 4),
      claudeUser('after', 5),
      claudeAssistant('msg_3', 6),
    ]);
    const usage = await collectUsageEvents({ providers: [claude()], noCache: true });
    // Default bounds read 16 MiB per call: page through with the cursor.
    const entries: PromptHistoryEntry[] = [];
    const exclusions: unknown[] = [];
    let cursor: Awaited<ReturnType<typeof collectPromptHistory>>['cursor'] | undefined;
    for (let call = 0; call < 10; call++) {
      const page = await collectPromptHistory({ workspacePaths: [repo], cursor });
      entries.push(...page.entries);
      exclusions.push(...page.exclusions);
      cursor = page.cursor;
      if (!page.hasMore) break;
    }

    expect(entries.map((entry) => [entry.ordinal, entry.text])).toEqual([
      [0, 'before'],
      [1, 'after'],
    ]);
    expect(exclusions).toEqual([expect.objectContaining({ reason: 'oversizedRecord' })]);
    for (const event of usage.events) {
      expect(event.promptOrdinal).toBe(expectedOrdinal(event, entries));
    }
    expect(usage.events.map((event) => event.promptOrdinal)).toEqual([0, 0, 1]);
  });

  it('re-reads ordinals only on a cache miss and leaves them off for appended data until then', async () => {
    const main = claudeFile(repo, 'growing');
    writeJsonl(main, [claudeUser('first', 1), claudeAssistant('msg_1', 2)]);
    const provider = claude();
    const first = await collectUsageEvents({ providers: [provider] });
    expect(first.events.map((event) => event.promptOrdinal)).toEqual([0]);

    appendJsonl(main, [claudeUser('second', 3), claudeAssistant('msg_2', 4)]);
    const second = await collectUsageEvents({ providers: [provider] });
    expect(second.cacheMisses).toBe(1);
    expect(second.events.map((event) => event.promptOrdinal)).toEqual([0, 1]);
  });
});
